// Tests for the trash engine (src/trash.js): the batch layout, the journal,
// rename-only moves, recovery, restore, permanent delete, path attacks and the
// trash mutex. The fault-injection matrices run apply, restore, purge and
// recover once per file-system call index, failing or crashing at that call,
// then build a new engine and run recover(): every session folder must then be
// in exactly one place with the same file names and sha256 content.
// Everything is written under one mkdtemp folder. The instrumented fs refuses
// any path outside the test world; the child process of the mutex test gets
// decoy HOME, DSH_HOME and XDG_STATE_HOME folders, which must stay empty.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import nodeFs, {
  appendFileSync, constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertApplyResult, assertPurgeResult, assertTrashList, BATCH_ID_PATTERN, ERROR } from '../src/contract.js'
import { resolveConfig } from '../src/config.js'
import { PathError } from '../src/paths.js'
import {
  batchState, createTrash, foldJournal, LOCK_GRACE_MS, parseJournal, PURGE_PREFIX, STAGING_PREFIX, TrashError,
} from '../src/trash.js'

const TMP = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sessions-trash-test-')))
after(() => rmSync(TMP, { recursive: true, force: true }))

const SRC_FILE = fileURLToPath(new URL('../src/trash.js', import.meta.url))
const CONFIG_FILE = fileURLToPath(new URL('../src/config.js', import.meta.url))
const HOST = os.hostname()
const FIXED_NOW = Date.UTC(2026, 10, 17, 20, 30, 0)
const FAULTY = Object.freeze({ pid: 4_000_001, startedAt: 17, host: HOST })
const FAULTY_TWO = Object.freeze({ pid: 4_000_002, startedAt: 18, host: HOST })
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

// ---------------------------------------------------------------------------
// The test world: a store <root>/store/sessions/<workspaceDir>/<id>/ with
// opaque files, and a data folder <root>/data (trash = <root>/data/trash).
// ---------------------------------------------------------------------------

const LAYOUT = Object.freeze([
  { rootId: 'sa1', members: [['sa1', 'alpha', null], ['sa2', 'alpha', 'sa1'], ['sa3', 'beta', 'sa2']] },
  { rootId: 'sb1', members: [['sb1', 'beta', null]] },
  { rootId: 'sc1', members: [['sc1', 'alpha', null], ['sc2', 'gamma', 'sc1']] },
])
const KEPT = Object.freeze([['sk1', 'alpha', null], ['sk2', 'gamma', null]])
// The fault matrices run once per call index, so they use a smaller store that keeps every shape that
// matters: a multi-member unit across two project folders, a single-member unit, a kept session.
const MATRIX_LAYOUT = Object.freeze([
  { rootId: 'sa1', members: [['sa1', 'alpha', null], ['sa2', 'beta', 'sa1']] },
  { rootId: 'sb1', members: [['sb1', 'beta', null]] },
])
const MATRIX_KEPT = Object.freeze([['sk1', 'alpha', null]])
// In the matrices fsync is a counted (and fault-injected) no-op: they model a crashed process, not a power loss.
const NO_FSYNC = Object.freeze({ fsyncSync: () => {} })

/** A deterministic byte source (sha256 counter mode), also used as the engine's injected random. */
const seeded = (seed) => {
  let counter = 0
  return (size) => {
    const out = Buffer.alloc(size)
    let filled = 0
    while (filled < size) filled += createHash('sha256').update(`${seed}:${counter++}`).digest().copy(out, filled)
    return out
  }
}

function writeSession(folder, id) {
  mkdirSync(path.join(folder, 'blobs', 'deep'), { recursive: true })
  writeFileSync(path.join(folder, 'session.v4.jsonl.zstd'), seeded(`${id}:log`)(900))
  writeFileSync(path.join(folder, 'session.lock'), '')
  writeFileSync(path.join(folder, 'blobs', 'deep', `${id}.bin`), seeded(`${id}:blob`)(333))
}

/** Sorted listing of a folder: `d rel`, `f rel sha256`, `l rel -> target`. */
function treeOf(dir) {
  const out = []
  const walk = (rel) => {
    for (const name of readdirSync(path.join(dir, rel)).sort()) {
      const child = rel === '' ? name : `${rel}/${name}`
      const full = path.join(dir, child)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) out.push(`l ${child} -> ${readlinkSync(full)}`)
      else if (stat.isDirectory()) {
        out.push(`d ${child}`)
        walk(child)
      } else out.push(`f ${child} ${sha(readFileSync(full))}`)
    }
  }
  walk('')
  return out
}

let worlds = 0
function makeWorld(label, { layout = LAYOUT, kept = KEPT, configure = {}, override } = {}) {
  const root = path.join(TMP, `${label}-${++worlds}`)
  const store = path.join(root, 'store', 'sessions')
  const dataDir = path.join(root, 'data')
  mkdirSync(store, { recursive: true })
  const all = [...layout.flatMap((unit) => unit.members), ...kept]
  for (const [id, ws] of all) writeSession(path.join(store, ws, id), id)
  const config = resolveConfig({ dataDir, ...configure }, {})
  const intent = {
    planId: 'plan-test',
    units: layout.map((unit) => ({ rootId: unit.rootId, memberIds: unit.members.map(([id]) => id) })),
    sessions: layout.flatMap((unit) => unit.members.map(([id, ws, parent]) => ({
      id, workspaceDir: ws, workspaceId: `ws-${ws}`, parent, archived: parent === null, pinned: id === 'sb1', bytes: 1000 + id.charCodeAt(1),
      source: path.join(store, ws, id),
    }))),
  }
  return {
    root, store, dataDir, config, trashDir: config.trashDir, intent, override,
    wsOf: new Map(all.map(([id, ws]) => [id, ws])),
    kept: new Set(kept.map(([id]) => id)),
    trees: new Map(all.map(([id, ws]) => [id, treeOf(path.join(store, ws, id))])),
    storeTree: treeOf(store),
  }
}

const storePath = (world, id) => path.join(world.store, world.wsOf.get(id), id)
const trashPath = (world, batchId, id) => path.join(world.trashDir, batchId, 'sessions', world.wsOf.get(id), id)

/** Every folder in the whole world named like a session, by id. */
function placesOf(world) {
  const places = new Map([...world.wsOf.keys()].map((id) => [id, []]))
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      const stat = lstatSync(full)
      if (!stat.isDirectory()) continue
      if (places.has(name)) places.get(name).push(full)
      walk(full)
    }
  }
  walk(world.root)
  return places
}

/** The core invariant: each session folder exists exactly once, with identical names and content. */
function assertEachOnce(world, label) {
  for (const [id, found] of placesOf(world)) {
    assert.equal(found.length, 1, `${label}: ${id} is in ${found.length} places: ${found.map((p) => path.relative(world.root, p)).join(', ')}`)
    assert.deepEqual(treeOf(found[0]), world.trees.get(id), `${label}: the content of ${id} changed`)
    if (world.kept.has(id)) assert.equal(found[0], storePath(world, id), `${label}: kept session ${id} moved`)
  }
}

/** The trash folder without the lock files, which every lock cycle rewrites. */
const trashSnapshot = (world) => (existsSync(world.trashDir) ? treeOf(world.trashDir).filter((line) => !/^[fdl] \.lock/.test(line)) : [])

// ---------------------------------------------------------------------------
// An instrumented fs: counts and records every call, refuses paths outside the
// world, and fails (one EIO) or crashes (that call and every later one throw;
// a crashing write first writes half its bytes) at one call index.
// ---------------------------------------------------------------------------

const FS_METHODS = [
  'openSync', 'closeSync', 'writeSync', 'readSync', 'fstatSync', 'fsyncSync', 'fchmodSync', 'lstatSync', 'statSync', 'realpathSync',
  'mkdirSync', 'chmodSync', 'readdirSync', 'renameSync', 'unlinkSync', 'rmdirSync',
]
const PATH_ARGS = {
  openSync: [0], lstatSync: [0], statSync: [0], realpathSync: [0], mkdirSync: [0], chmodSync: [0], readdirSync: [0], renameSync: [0, 1],
  unlinkSync: [0], rmdirSync: [0],
}
const isInside = (root, target) => {
  const relative = path.relative(root, path.resolve(target))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
const fsError = (code, name) => Object.assign(new Error(`${code}: injected failure in ${name}`), { code, syscall: name })

function instrumentedFs({ root, failAt = -1, mode = 'fail', errorCode = 'EIO', events = [], override = {}, crashWhen = null }) {
  let calls = 0
  let dead = false
  let hit = null
  const open = new Set()
  const fs = {}
  for (const name of FS_METHODS) {
    fs[name] = (...args) => {
      const paths = (PATH_ARGS[name] ?? []).map((index) => args[index])
      for (const target of paths) {
        if (typeof target !== 'string' || !isInside(root, target)) throw new Error(`sandbox: ${name} outside the test world: ${target}`)
      }
      const index = calls++
      const event = { index, name, paths, flags: name === 'openSync' ? args[1] : undefined, fd: typeof args[0] === 'number' ? args[0] : undefined }
      events.push(event)
      if (dead) throw fsError('ECRASH', name)
      if (index === failAt || (crashWhen !== null && crashWhen(name, paths))) {
        hit = { index, name, paths }
        if (mode === 'crash' || crashWhen !== null) {
          dead = true
          if (name === 'writeSync') {
            const [fd, buffer, offset = 0, length = buffer.length - offset] = args
            nodeFs.writeSync(fd, buffer, offset, Math.floor(length / 2))
          }
          throw fsError('ECRASH', name)
        }
        throw fsError(errorCode, name)
      }
      const result = (override[name] ?? nodeFs[name])(...args)
      if (name === 'openSync') {
        open.add(result)
        event.result = result
      }
      if (name === 'closeSync') open.delete(args[0])
      return result
    }
  }
  return {
    fs,
    events,
    calls: () => calls,
    hit: () => hit,
    closeLeaked() {
      for (const fd of open) {
        try { nodeFs.closeSync(fd) } catch { /* already closed */ }
      }
      open.clear()
    },
  }
}

/** An engine on the world; by default this process's identity and only this process alive. */
function trashFor(world, { fs, events, identity, isAlive, now, random, config = world.config, override } = {}) {
  const recorder = fs ? null : instrumentedFs({ root: world.root, events, override: override ?? world.override })
  return createTrash({
    config, sessionsRoot: world.store, fs: fs ?? recorder.fs, identity, isAlive: isAlive ?? ((pid) => pid === process.pid), now, random,
  })
}

/** The engine of a crashed or failed host: a fake pid, a fixed clock, deterministic ids. */
const faultyTrash = (world, fs, identity = FAULTY) => createTrash({
  config: world.config, sessionsRoot: world.store, fs, identity, isAlive: (pid) => pid === identity.pid, now: () => FIXED_NOW, random: seeded(7),
})

/** The engine of the next start: a later clock (past the lock grace period), this process alive. */
const recoverer = (world, events) => trashFor(world, { events, now: () => Date.now() + 2 * LOCK_GRACE_MS })

/** The apply sequence of the Host service: lock, recover, manifest, every unit, finish. */
function runApply(trash, intent, precheck = () => null) {
  const lock = trash.acquire()
  try {
    trash.recover()
    const batch = trash.createBatch(intent)
    const outcomes = []
    try {
      for (const unit of batch.units) outcomes.push(batch.moveUnit(unit, precheck))
    } finally {
      if (!batch.finished) batch.finish()
    }
    return { batch, outcomes, result: batch.result }
  } finally {
    lock.release()
  }
}

const journalLines = (file) => parseJournal(readFileSync(file, 'utf8')).records
const journalOps = (world, batchId) => journalLines(path.join(world.trashDir, batchId, 'journal.jsonl')).map((record) => record.op)
const modeOf = (target) => statSync(target).mode & 0o777

function applyAll(world, options) {
  const { batch, result } = runApply(trashFor(world), world.intent, options?.precheck)
  assert.equal(result.state, 'complete')
  return batch.batchId
}

// ---------------------------------------------------------------------------
// 1. Batch layout and manifest first
// ---------------------------------------------------------------------------

test('batch layout: manifest created with wx and fsynced before the first rename; folders 0700, files 0600', () => {
  const world = makeWorld('layout')
  const events = []
  const trash = trashFor(world, { events })
  const { batch, result, outcomes } = runApply(trash, world.intent)
  assertApplyResult(result)
  assert.deepEqual(result.moved, { units: 3, sessions: 6, bytes: world.intent.sessions.reduce((sum, s) => sum + s.bytes, 0) })
  assert.equal(result.state, 'complete')
  assert.deepEqual(result.skipped, [])
  assert.ok(outcomes.every((outcome) => outcome.outcome === 'moved'))
  assert.match(batch.batchId, BATCH_ID_PATTERN)
  assert.match(batch.batchId, /^b-\d{8}T\d{6}Z-[0-9a-f]{8}$/)

  const dir = path.join(world.trashDir, batch.batchId)
  assert.deepEqual(readdirSync(dir).sort(), ['journal.jsonl', 'manifest.json', 'sessions'])
  assert.deepEqual(readdirSync(path.join(dir, 'sessions')).sort(), ['alpha', 'beta', 'gamma'])
  for (const folder of [world.dataDir, world.trashDir, dir, path.join(dir, 'sessions'), path.join(dir, 'sessions', 'alpha'), path.join(dir, 'sessions', 'gamma')]) {
    assert.equal(modeOf(folder), 0o700, folder)
  }
  for (const file of [path.join(dir, 'manifest.json'), path.join(dir, 'journal.jsonl'), path.join(world.trashDir, '.lock.released')]) {
    assert.equal(modeOf(file), 0o600, file)
  }
  assert.ok(!readdirSync(world.trashDir).some((name) => name.startsWith(STAGING_PREFIX)), 'no staging folder is left')
  assertEachOnce(world, 'layout')
  for (const s of world.intent.sessions) {
    assert.ok(existsSync(trashPath(world, batch.batchId, s.id)), `${s.id} is in the trash`)
    assert.ok(!existsSync(s.source), `${s.id} left the store`)
  }

  // The manifest holds the full intent.
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.batchId, batch.batchId)
  assert.equal(manifest.planId, 'plan-test')
  assert.equal(manifest.sessionsRoot, world.store)
  assert.deepEqual(manifest.workspaceDirs, ['alpha', 'beta', 'gamma'])
  assert.deepEqual(manifest.totals, { units: 3, sessions: 6, bytes: result.moved.bytes })
  assert.deepEqual(manifest.units.map((unit) => [unit.rootId, unit.memberIds]), world.intent.units.map((unit) => [unit.rootId, unit.memberIds]))
  for (const entry of manifest.sessions) {
    assert.deepEqual(Object.keys(entry).sort(), ['archived', 'bytes', 'id', 'parent', 'pinned', 'source', 'workspaceDir', 'workspaceId'])
    assert.deepEqual(entry, world.intent.sessions.find((s) => s.id === entry.id))
  }

  // Order: exclusive create of the manifest (inside the staging folder), its fsync, then the first rename of anything.
  const manifestOpen = events.find((event) => event.name === 'openSync' && event.paths[0].endsWith('manifest.json'))
  assert.ok(manifestOpen, 'the manifest is opened through the injected fs')
  assert.ok(path.basename(path.dirname(manifestOpen.paths[0])).startsWith(STAGING_PREFIX), 'the manifest is written in the staging folder')
  for (const flag of ['O_CREAT', 'O_EXCL', 'O_WRONLY', 'O_NOFOLLOW']) assert.ok(manifestOpen.flags & constants[flag], `manifest open has ${flag}`)
  const manifestClose = events.find((event) => event.index > manifestOpen.index && event.name === 'closeSync' && event.fd === manifestOpen.result)
  const manifestSync = events.find((event) => event.index > manifestOpen.index && event.index < manifestClose.index && event.name === 'fsyncSync' && event.fd === manifestOpen.result)
  assert.ok(manifestSync, 'the manifest is fsynced before it is closed')
  const firstRename = events.find((event) => event.name === 'renameSync')
  assert.ok(firstRename.index > manifestSync.index, 'the manifest fsync precedes every rename')
  const firstSessionRename = events.find((event) => event.name === 'renameSync' && isInside(world.store, event.paths[0]))
  assert.ok(firstSessionRename.index > manifestSync.index)
  // The staging folder becomes the batch before any session moves, and the trash folder is fsynced after it.
  assert.equal(firstRename.paths[1], dir)
  const trashSync = events.find((event) => event.index > firstRename.index && event.name === 'openSync' && event.paths[0] === world.trashDir)
  assert.ok(trashSync && trashSync.index < firstSessionRename.index, 'the trash folder is fsynced before the first session rename')
})

test('the batch folder is exclusive: an existing staging folder for the same id stops createBatch before any move', () => {
  const first = makeWorld('exclusive-a')
  const second = makeWorld('exclusive-b')
  const make = (world) => createTrash({ config: world.config, sessionsRoot: world.store, now: () => FIXED_NOW, random: seeded(99) })
  const one = make(first)
  const batch = one.createBatch(first.intent)
  const { batchId } = batch
  batch.finish()
  mkdirSync(path.join(second.trashDir, `${STAGING_PREFIX}${batchId}`), { recursive: true, mode: 0o700 })
  const two = make(second)
  assert.throws(() => two.createBatch(second.intent), (error) => error.code === 'EEXIST')
  assertEachOnce(second, 'exclusive')
  for (const s of second.intent.sessions) assert.ok(existsSync(s.source))
  assert.ok(!existsSync(path.join(second.trashDir, batchId)))
  assert.ok(!existsSync(path.join(second.trashDir, '.lock')), 'the lock is released after the failure')
})

// ---------------------------------------------------------------------------
// 2. The journal
// ---------------------------------------------------------------------------

test('journal: parseJournal skips torn and foreign lines; the batch state is a fold of the lines', () => {
  const manifest = {
    sessions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    units: [{ rootId: 'a', memberIds: ['a', 'b'] }, { rootId: 'c', memberIds: ['c'] }],
  }
  const text = [
    '{"v":1,"ts":1,"op":"begin"}',
    '{"v":1,"ts":2,"op":"moved","id":"a"}',
    'garbage',
    '[1,2]',
    '{"v":2,"ts":3,"op":"moved","id":"c"}',
    '{"v":1,"ts":3,"op":"moved","id":"b"}',
    '{"v":1,"ts":4,"op":"unit-moved","rootId":"a"}',
    '{"v":1,"ts":5,"op":"future-op","id":"c"}',
    '{"v":1,"ts":6,"op":"end"}',
    '{"v":1,"ts":7,"op":"moved","id":"c"',
  ].join('\n')
  const { records, skipped } = parseJournal(text)
  assert.equal(records.length, 6)
  assert.equal(skipped, 4)
  const fold = foldJournal(manifest, records)
  assert.equal(fold.location.get('a'), 'trash')
  assert.equal(fold.location.get('b'), 'trash')
  assert.equal(fold.location.get('c'), 'store', 'the torn last line is ignored')
  assert.equal(fold.openOp, null)
  assert.equal(batchState(manifest, fold), 'complete')
  // Without the end line the apply is open; a unit split between store and trash needs recovery; lost is conflict.
  assert.equal(batchState(manifest, foldJournal(manifest, records.slice(0, 3))), 'needs-recovery')
  assert.equal(batchState(manifest, foldJournal(manifest, [...records.slice(0, 2), records.at(-1)])), 'needs-recovery')
  assert.equal(batchState(manifest, foldJournal(manifest, [...records, { v: 1, op: 'recovered', id: 'c', location: 'lost' }])), 'conflict')
})

test('journal on disk: every line is one O_APPEND|O_NOFOLLOW write; a torn last line is ignored and ended by the next append', () => {
  const world = makeWorld('journal')
  const events = []
  const { batch } = runApply(trashFor(world, { events }), world.intent)
  const file = path.join(world.trashDir, batch.batchId, 'journal.jsonl')
  const opens = events.filter((event) => event.name === 'openSync' && event.paths[0].endsWith('journal.jsonl'))
  assert.ok(opens.length >= 10)
  for (const open of opens) {
    assert.ok(open.flags & constants.O_APPEND, 'O_APPEND')
    assert.ok(open.flags & constants.O_NOFOLLOW, 'O_NOFOLLOW')
    assert.ok(!(open.flags & constants.O_TRUNC), 'never truncated')
    const close = events.find((event) => event.index > open.index && event.name === 'closeSync' && event.fd === open.result)
    const writes = events.filter((event) => event.index > open.index && event.index < close.index && event.name === 'writeSync' && event.fd === open.result)
    assert.equal(writes.length, 1, 'one write per line')
  }
  const ops = journalOps(world, batch.batchId)
  assert.equal(ops[0], 'begin')
  assert.equal(ops.at(-1), 'end')
  assert.equal(ops.filter((op) => op === 'moved').length, 6)
  assert.equal(ops.filter((op) => op === 'unit-moved').length, 3)

  const trash = trashFor(world)
  const before = trash.inspect(batch.batchId)
  assert.equal(before.state, 'complete')
  appendFileSync(file, '{"v":1,"ts":9,"op":"restored","id":"sa1"')
  const torn = trash.inspect(batch.batchId)
  assert.equal(torn.state, 'complete')
  assert.deepEqual(torn.held, before.held)
  assert.equal(torn.skippedLines, 1)
  assert.equal(torn.sessions.find((s) => s.id === 'sa1').location, 'trash', 'the torn line does not count')
  assertTrashList(trash.list())
  trash.recordStep(batch.batchId, { step: 'unpin', id: 'sb1', outcome: 'ok' })
  const text = readFileSync(file, 'utf8')
  assert.ok(text.includes('"id":"sa1"\n{"v":1'), 'the next append ends the torn line first')
  const after = trash.inspect(batch.batchId)
  assert.deepEqual(after.steps, [{ step: 'unpin', id: 'sb1', outcome: 'ok' }])
  assert.equal(after.skippedLines, 1)
  assert.equal(after.state, 'complete')
})

test('journal: a symlinked journal is never appended to or read', () => {
  const world = makeWorld('journal-link')
  const batchId = applyAll(world)
  const file = path.join(world.trashDir, batchId, 'journal.jsonl')
  const outside = path.join(world.root, 'outside.jsonl')
  writeFileSync(outside, 'precious\n')
  rmSync(file)
  symlinkSync(outside, file)
  const trash = trashFor(world)
  assert.throws(() => trash.recordStep(batchId, { step: 'pin', id: 'sb1', outcome: 'ok' }), (error) => error instanceof PathError && error.code === 'path-unsafe')
  assert.throws(() => trash.inspect(batchId), (error) => error.code === 'path-unsafe')
  assert.equal(readFileSync(outside, 'utf8'), 'precious\n')
  const list = trash.list()
  assertTrashList(list)
  assert.equal(list.batches.find((row) => row.batchId === batchId).state, 'conflict')
})

// ---------------------------------------------------------------------------
// 3. Moves: rename only, precheck right before each rename, EXDEV, failures
// ---------------------------------------------------------------------------

test('a move is one renameSync of the session folder; the synchronous precheck runs right before each rename, with only the lstat re-check in between', () => {
  const world = makeWorld('rename-only')
  const events = []
  const trash = trashFor(world, { events })
  const seen = []
  const precheck = (entry) => {
    assert.ok(Object.isFrozen(entry))
    seen.push(entry)
    events.push({ name: 'precheck', id: entry.id })
    return null
  }
  const batch = trash.createBatch(world.intent)
  const start = events.length
  for (const unit of batch.units) batch.moveUnit(unit, precheck)
  const during = events.slice(start)
  batch.finish()
  const renames = during.filter((event) => event.name === 'renameSync')
  assert.equal(renames.length, 6, 'one rename per session and nothing else')
  for (const rename of renames) {
    const id = path.basename(rename.paths[0])
    assert.equal(rename.paths[0], storePath(world, id))
    assert.equal(rename.paths[1], trashPath(world, batch.batchId, id))
    // Between the precheck and the rename there is nothing but the re-check: one lstat of the project folder and
    // one of the session folder (they must still be the real folders the checks saw).
    const at = during.indexOf(rename)
    assert.deepEqual(during[at - 3], { name: 'precheck', id }, `the precheck of ${id} comes right before its re-check and rename`)
    assert.deepEqual(during.slice(at - 2, at).map((event) => [event.name, event.paths[0]]), [
      ['lstatSync', path.dirname(storePath(world, id))], ['lstatSync', storePath(world, id)],
    ], `${id}: only the lstat re-check runs between the precheck and the rename`)
  }
  assert.deepEqual(seen.map((entry) => entry.id), ['sa1', 'sa2', 'sa3', 'sb1', 'sc1', 'sc2'])
  assert.deepEqual(seen[0], world.intent.sessions[0])
  // No copy of session data: no write goes to a file that is not a journal or a lock file.
  const writtenFds = new Set(during.filter((event) => event.name === 'writeSync').map((event) => event.fd))
  for (const open of during.filter((event) => event.name === 'openSync' && writtenFds.has(event.result))) {
    assert.match(path.basename(open.paths[0]), /^(journal\.jsonl|\.lock.*)$/)
  }
  assert.ok(!during.some((event) => /unlink|rmdir|copy|cp/i.test(event.name ?? '')))
  assertEachOnce(world, 'rename-only')
})

test('precheck: a refusal, a promise, an unknown code or a throw skips the unit and renames moved members back', () => {
  const world = makeWorld('precheck')
  const trash = trashFor(world)
  const batch = trash.createBatch(world.intent)
  const [unitA, unitB, unitC] = batch.units

  const refused = batch.moveUnit(unitA, (entry) => (entry.id === 'sa2' ? 'live' : null))
  assert.deepEqual(refused.reasons, [{ code: 'live', sessionId: 'sa2' }])
  assert.equal(refused.outcome, 'skipped')
  assert.equal(refused.split, false)
  for (const id of ['sa1', 'sa2', 'sa3']) assert.ok(existsSync(storePath(world, id)), `${id} is back in the store`)

  assert.throws(() => batch.moveUnit(unitB, () => Promise.resolve(null)), /synchronous/)
  assert.ok(existsSync(storePath(world, 'sb1')))

  assert.throws(() => batch.moveUnit(unitC, (entry) => (entry.id === 'sc2' ? 'not-a-code' : null)), TypeError)
  assert.ok(existsSync(storePath(world, 'sc1')) && existsSync(storePath(world, 'sc2')))
  const result = batch.finish()
  assertApplyResult(result)
  assert.equal(result.moved.sessions, 0)
  assert.equal(result.state, 'partial')

  const other = makeWorld('precheck-throw')
  const t2 = trashFor(other)
  const b2 = t2.createBatch(other.intent)
  const thrown = b2.moveUnit(b2.units[0], (entry) => {
    if (entry.id === 'sa3') throw new Error('host service failed')
    return null
  })
  assert.equal(thrown.outcome, 'skipped')
  assert.deepEqual(thrown.reasons, [{ code: 'changed', sessionId: 'sa3' }])
  for (const id of ['sa1', 'sa2', 'sa3']) assert.ok(existsSync(storePath(other, id)))
  b2.finish()
  const ops = journalOps(world, batch.batchId)
  assert.deepEqual(ops.slice(0, 4), ['begin', 'moved', 'rolled-back', 'unit-skipped'])
  assertEachOnce(world, 'precheck')
  assertEachOnce(other, 'precheck-throw')
})

test('precheck may return a release (function or {release}); it runs after the rename and after any rollback rename, also on failure', () => {
  const world = makeWorld('release')
  const order = []
  const failOn = new Set()
  const override = {
    renameSync: (from, to) => {
      const id = path.basename(from)
      if (failOn.has(`${id}:${path.basename(path.dirname(path.dirname(from)))}`)) throw fsError('EIO', 'renameSync')
      order.push(`rename:${id}:${isInside(world.store, from) ? 'out' : 'back'}`)
      return nodeFs.renameSync(from, to)
    },
  }
  const trash = trashFor(world, { override })
  const batch = trash.createBatch(world.intent)
  order.length = 0 // the staging rename of createBatch
  const [unitA, unitB, unitC] = batch.units
  const precheck = (entry) => {
    order.push(`acquire:${entry.id}`)
    const release = () => order.push(`release:${entry.id}`)
    return entry.id === 'sa2' ? { release } : release
  }

  // Happy path: acquire -> rename for each member, then every release after the unit's last rename.
  assert.equal(batch.moveUnit(unitA, precheck).outcome, 'moved')
  assert.deepEqual(order, [
    'acquire:sa1', 'rename:sa1:out', 'acquire:sa2', 'rename:sa2:out', 'acquire:sa3', 'rename:sa3:out',
    'release:sa3', 'release:sa2', 'release:sa1',
  ])

  // The rename itself throws: its release still runs, after the rollback rename of the members already moved.
  order.length = 0
  failOn.add('sc2:sessions')
  const failed = batch.moveUnit(unitC, precheck)
  assert.equal(failed.outcome, 'failed')
  assert.deepEqual(order, ['acquire:sc1', 'rename:sc1:out', 'acquire:sc2', 'rename:sc1:back', 'release:sc2', 'release:sc1'])

  // A refusal that also returns a release ({ code, release }) is released too.
  order.length = 0
  const skipped = batch.moveUnit(unitB, (entry) => {
    order.push(`acquire:${entry.id}`)
    return { code: 'locked', release: () => order.push(`release:${entry.id}`) }
  })
  assert.deepEqual(skipped.reasons, [{ code: 'locked', sessionId: 'sb1' }])
  assert.deepEqual(order, ['acquire:sb1', 'release:sb1'])
  batch.finish()

  // A release that throws does not break the unit or the other releases.
  const world2 = makeWorld('release-throw')
  const t2 = trashFor(world2)
  const b2 = t2.createBatch(world2.intent)
  const released = []
  const moved = b2.moveUnit(b2.units[0], (entry) => () => {
    released.push(entry.id)
    if (entry.id === 'sa2') throw new Error('close failed')
  })
  assert.equal(moved.outcome, 'moved')
  assert.deepEqual(released, ['sa3', 'sa2', 'sa1'])
  b2.finish()
  assertEachOnce(world, 'release')
  assertEachOnce(world2, 'release-throw')
})

test('EXDEV is the refusal cross-device: no copy fallback, moved members are renamed back and journaled', () => {
  const world = makeWorld('exdev')
  const events = []
  const override = {
    renameSync: (from, to) => {
      if (from === storePath(world, 'sa3')) throw fsError('EXDEV', 'renameSync')
      return nodeFs.renameSync(from, to)
    },
  }
  const trash = trashFor(world, { events, override })
  const batch = trash.createBatch(world.intent)
  const outcome = batch.moveUnit(batch.units[0], () => null)
  assert.equal(outcome.outcome, 'skipped')
  assert.deepEqual(outcome.reasons, [{ code: 'cross-device', sessionId: 'sa3' }])
  for (const id of ['sa1', 'sa2', 'sa3']) assert.deepEqual(treeOf(storePath(world, id)), world.trees.get(id))
  const result = batch.finish()
  assertApplyResult(result)
  assert.deepEqual(result.skipped[0], { rootId: 'sa1', reasons: [{ code: 'cross-device', sessionId: 'sa3' }] })
  assert.deepEqual(journalOps(world, batch.batchId), ['begin', 'moved', 'moved', 'rolled-back', 'rolled-back', 'unit-skipped', 'end'])
  assert.ok(!events.some((event) => event.name === 'writeSync' && events.find((open) => open.result === event.fd && open.name === 'openSync' && isInside(world.store, open.paths[0]))))
  assert.equal(trash.inspect(batch.batchId).state, 'complete')

  // A device mismatch seen by lstat refuses before any rename is tried.
  const world2 = makeWorld('exdev-dev')
  const events2 = []
  const target = storePath(world2, 'sb1')
  const override2 = {
    lstatSync: (p, ...rest) => {
      const stat = nodeFs.lstatSync(p, ...rest)
      return p === target ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: stat.dev + 1 }) : stat
    },
  }
  const t2 = trashFor(world2, { events: events2, override: override2 })
  const b2 = t2.createBatch(world2.intent)
  const o2 = b2.moveUnit(b2.units[1], () => null)
  assert.deepEqual(o2.reasons, [{ code: 'cross-device', sessionId: 'sb1' }])
  assert.ok(!events2.some((event) => event.name === 'renameSync' && event.paths[0] === target))
  b2.finish()
  assertEachOnce(world, 'exdev')
  assertEachOnce(world2, 'exdev-dev')
})

test('a failure inside a unit renames moved members back; a failed rollback leaves a split that recover() makes whole in the store', () => {
  const world = makeWorld('mid-unit')
  const override = {
    renameSync: (from, to) => {
      if (from === storePath(world, 'sa3')) throw fsError('EIO', 'renameSync')
      return nodeFs.renameSync(from, to)
    },
  }
  const trash = trashFor(world, { override })
  const batch = trash.createBatch(world.intent)
  const outcome = batch.moveUnit(batch.units[0], () => null)
  assert.equal(outcome.outcome, 'failed')
  assert.equal(outcome.error, 'EIO')
  assert.equal(outcome.split, false)
  for (const id of ['sa1', 'sa2', 'sa3']) assert.ok(existsSync(storePath(world, id)))
  assert.equal(batch.moveUnit(batch.units[1], () => null).outcome, 'moved')
  const result = batch.finish()
  assertApplyResult(result)
  assert.equal(result.state, 'partial')
  assertEachOnce(world, 'mid-unit')

  // Now the rollback rename of sa2 fails too: the unit is split.
  const world2 = makeWorld('split')
  let backs = 0
  const override2 = {
    renameSync: (from, to) => {
      if (from === storePath(world2, 'sa3')) throw fsError('EIO', 'renameSync')
      if (isInside(world2.trashDir, from) && path.basename(from) === 'sa2' && backs++ === 0) throw fsError('EIO', 'renameSync')
      return nodeFs.renameSync(from, to)
    },
  }
  const t2 = trashFor(world2, { override: override2 })
  const b2 = t2.createBatch(world2.intent)
  const split = b2.moveUnit(b2.units[0], () => null)
  assert.equal(split.outcome, 'failed')
  assert.equal(split.split, true)
  const r2 = b2.finish()
  assertApplyResult(r2)
  assert.equal(r2.state, 'needs-recovery')
  assert.deepEqual(r2.warnings, [{ code: 'recovery-needed', sessionId: 'sa1' }])
  assert.ok(existsSync(trashPath(world2, b2.batchId, 'sa2')))
  assert.ok(existsSync(storePath(world2, 'sa1')))
  assert.equal(trashFor(world2).inspect(b2.batchId).state, 'needs-recovery')

  const events = []
  const fresh = trashFor(world2, { events })
  const report = fresh.recover()
  assert.equal(report.batches[0].moved, 1)
  assert.equal(report.batches[0].state, 'complete')
  assertEachOnce(world2, 'split recovered')
  for (const id of ['sa1', 'sa2', 'sa3']) assert.ok(existsSync(storePath(world2, id)))
  assert.ok(!events.some((event) => event.name === 'unlinkSync' || event.name === 'rmdirSync'), 'recover() never deletes')
  const frozen = trashSnapshot(world2)
  trashFor(world2).recover()
  assert.deepEqual(trashSnapshot(world2), frozen, 'a second recover() changes nothing')
})

test('an existing destination, even an empty folder, is conflict: skipped, journaled, never overwritten', () => {
  const world = makeWorld('dest-exists')
  const events = []
  const trash = trashFor(world, { events })
  const batch = trash.createBatch(world.intent)
  const squatter = trashPath(world, batch.batchId, 'sb1')
  mkdirSync(squatter, { recursive: true })
  const outcome = batch.moveUnit(batch.units[1], () => null)
  assert.deepEqual(outcome.reasons, [{ code: 'conflict', sessionId: 'sb1' }])
  assert.deepEqual(readdirSync(squatter), [], 'the empty folder is still there, untouched')
  assert.deepEqual(treeOf(storePath(world, 'sb1')), world.trees.get('sb1'))
  assert.ok(!events.some((event) => event.name === 'renameSync' && event.paths[0] === storePath(world, 'sb1')), 'no rename was tried')
  const result = batch.finish()
  assert.equal(result.state, 'conflict')
  const lines = journalLines(path.join(world.trashDir, batch.batchId, 'journal.jsonl'))
  assert.deepEqual(lines.find((line) => line.op === 'unit-skipped').reasons, [{ code: 'conflict', sessionId: 'sb1' }])
})

test('the folders are checked again between the precheck and the rename: one swapped for a symlink (or another folder) is path-unsafe, never renamed, and the unit is renamed back', () => {
  const unitSkipped = (world, batchId) => journalLines(path.join(world.trashDir, batchId, 'journal.jsonl')).find((line) => line.op === 'unit-skipped')
  const renamesOf = (events, from) => events.filter((event) => event.name === 'renameSync' && event.paths[0] === from)

  // 1. A fake fs: once sa2's precheck has run, the lstat of sa2's folder reports a symbolic link.
  const world = makeWorld('swap-fake')
  const target = storePath(world, 'sa2')
  let flipped = false
  const override = {
    lstatSync: (p, ...rest) => {
      const stat = nodeFs.lstatSync(p, ...rest)
      if (!flipped || p !== target) return stat
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { mode: (stat.mode & ~constants.S_IFMT) | constants.S_IFLNK })
    },
  }
  const events = []
  const trash = trashFor(world, { events, override })
  const batch = trash.createBatch(world.intent)
  const start = events.length
  const outcome = batch.moveUnit(batch.units[0], (entry) => {
    if (entry.id === 'sa2') flipped = true
    return null
  })
  flipped = false
  assert.equal(outcome.outcome, 'skipped')
  assert.deepEqual(outcome.reasons, [{ code: 'path-unsafe', sessionId: 'sa2' }])
  assert.equal(outcome.split, false)
  const during = events.slice(start)
  assert.deepEqual(renamesOf(during, target), [], 'the folder that turned into a link is never renamed')
  assert.deepEqual(during.filter((event) => event.name === 'renameSync').map((event) => event.paths.map((p) => path.relative(world.root, p))), [
    [path.relative(world.root, storePath(world, 'sa1')), path.relative(world.root, trashPath(world, batch.batchId, 'sa1'))],
    [path.relative(world.root, trashPath(world, batch.batchId, 'sa1')), path.relative(world.root, storePath(world, 'sa1'))],
  ], 'sa1, moved before, is renamed back')
  for (const id of ['sa1', 'sa2', 'sa3']) assert.deepEqual(treeOf(storePath(world, id)), world.trees.get(id), `${id} is in the store, intact`)
  assert.deepEqual(unitSkipped(world, batch.batchId).reasons, [{ code: 'path-unsafe', sessionId: 'sa2' }], 'the refusal is journaled')
  const result = batch.finish()
  assertApplyResult(result)
  assert.deepEqual(result.skipped[0], { rootId: 'sa1', reasons: [{ code: 'path-unsafe', sessionId: 'sa2' }] }, 'the other units were never handed to moveUnit')
  assert.deepEqual(journalOps(world, batch.batchId), ['begin', 'moved', 'rolled-back', 'unit-skipped', 'end'])
  assert.equal(trash.inspect(batch.batchId).state, 'complete')
  assertEachOnce(world, 'swap-fake')

  // 2. A real swap while the precheck runs (another process replaces sa3's folder by a link to its moved-aside content).
  const world2 = makeWorld('swap-real')
  const elsewhere = path.join(world2.root, 'elsewhere')
  mkdirSync(elsewhere)
  const events2 = []
  const t2 = trashFor(world2, { events: events2 })
  const b2 = t2.createBatch(world2.intent)
  const o2 = b2.moveUnit(b2.units[0], (entry) => {
    if (entry.id === 'sa3') {
      renameSync(storePath(world2, 'sa3'), path.join(elsewhere, 'sa3'))
      symlinkSync(path.join(elsewhere, 'sa3'), storePath(world2, 'sa3'))
    }
    return null
  })
  assert.deepEqual(o2.reasons, [{ code: 'path-unsafe', sessionId: 'sa3' }])
  assert.deepEqual(renamesOf(events2, storePath(world2, 'sa3')), [], 'the link is never renamed')
  assert.ok(lstatSync(storePath(world2, 'sa3')).isSymbolicLink(), 'the link stays in the store')
  assert.throws(() => lstatSync(trashPath(world2, b2.batchId, 'sa3')), { code: 'ENOENT' }, 'nothing of sa3 is in the trash')
  assert.deepEqual(treeOf(path.join(elsewhere, 'sa3')), world2.trees.get('sa3'), 'the data at the link target is untouched')
  for (const id of ['sa1', 'sa2']) assert.deepEqual(treeOf(storePath(world2, id)), world2.trees.get(id), `${id} is renamed back`)
  assert.deepEqual(unitSkipped(world2, b2.batchId).reasons, [{ code: 'path-unsafe', sessionId: 'sa3' }])
  b2.finish()

  // 3. The project folder swapped for a link to itself moved aside: the session folder keeps its inode, but the rename
  //    would resolve through the link. The project folder is checked again too.
  const world3 = makeWorld('swap-project')
  const aside = path.join(world3.root, 'beta-aside')
  const events3 = []
  const t3 = trashFor(world3, { events: events3 })
  const b3 = t3.createBatch(world3.intent)
  const o3 = b3.moveUnit(b3.units[1], () => {
    renameSync(path.join(world3.store, 'beta'), aside)
    symlinkSync(aside, path.join(world3.store, 'beta'))
    return null
  })
  assert.deepEqual(o3.reasons, [{ code: 'path-unsafe', sessionId: 'sb1' }])
  assert.deepEqual(renamesOf(events3, storePath(world3, 'sb1')), [])
  assert.deepEqual(treeOf(path.join(aside, 'sb1')), world3.trees.get('sb1'), 'sb1 stays in the real project folder')
  b3.finish()

  // 4. The session folder replaced by another real folder (a new inode): not the folder the checks saw.
  const world4 = makeWorld('swap-folder')
  const t4 = trashFor(world4)
  const b4 = t4.createBatch(world4.intent)
  const o4 = b4.moveUnit(b4.units[1], () => {
    renameSync(storePath(world4, 'sb1'), path.join(world4.root, 'sb1-aside'))
    mkdirSync(storePath(world4, 'sb1'), { mode: 0o700 })
    return null
  })
  assert.deepEqual(o4.reasons, [{ code: 'path-unsafe', sessionId: 'sb1' }])
  assert.deepEqual(readdirSync(storePath(world4, 'sb1')), [], 'the new folder is left where it is')
  assert.deepEqual(treeOf(path.join(world4.root, 'sb1-aside')), world4.trees.get('sb1'))
  b4.finish()
})

// ---------------------------------------------------------------------------
// 4. recover()
// ---------------------------------------------------------------------------

test('recover(): source only = not moved, destination only = moved, both = conflict, neither = lost; missing lines are appended once', () => {
  const world = makeWorld('recover')
  const batchId = applyAll(world)
  const file = path.join(world.trashDir, batchId, 'journal.jsonl')
  // Lose the journal line of sa2's move, so the disk shows a move the journal lacks.
  writeFileSync(file, readFileSync(file, 'utf8').split('\n').filter((line) => !line.includes('"id":"sa2"')).join('\n'))
  renameSync(trashPath(world, batchId, 'sc1'), storePath(world, 'sc1'))
  renameSync(trashPath(world, batchId, 'sc2'), storePath(world, 'sc2'))
  cpSync(trashPath(world, batchId, 'sa1'), storePath(world, 'sa1'), { recursive: true })
  rmSync(trashPath(world, batchId, 'sb1'), { recursive: true })

  const events = []
  const report = trashFor(world, { events }).recover()
  const batch = report.batches.find((entry) => entry.batchId === batchId)
  assert.deepEqual(batch.conflicts, ['sa1'])
  assert.deepEqual(batch.lost, ['sb1'])
  assert.equal(batch.state, 'conflict')
  assert.equal(batch.moved, 0)
  assert.ok(!events.some((event) => event.name === 'unlinkSync' || event.name === 'rmdirSync'), 'nothing deleted')
  assert.ok(!events.some((event) => event.name === 'renameSync' && !path.basename(event.paths[0]).startsWith('.lock')), 'no session moved')
  const recovered = journalLines(file).filter((line) => line.op === 'recovered').map((line) => `${line.id}:${line.location}`)
  assert.deepEqual(recovered.sort(), ['sa1:conflict', 'sa2:trash', 'sb1:lost', 'sc1:store', 'sc2:store'])
  assert.ok(existsSync(storePath(world, 'sa1')) && existsSync(trashPath(world, batchId, 'sa1')), 'both copies of a conflict stay')
  assert.equal(journalOps(world, batchId).at(-1), 'recover')

  const frozen = trashSnapshot(world)
  const again = trashFor(world).recover()
  assert.equal(again.batches[0].appended, 0)
  assert.deepEqual(trashSnapshot(world), frozen, 'a second run changes nothing')
  const row = trashFor(world).list().batches.find((entry) => entry.batchId === batchId)
  assert.equal(row.state, 'conflict')
  // sa2 and sa3 are in the trash; sa1 is in conflict, and its copy in the batch folder is held too (purge deletes it).
  assert.deepEqual([row.units, row.sessions], [0, 3], 'the batch holds sa2, sa3 and the conflict copy of sa1; no unit is wholly in the trash')
})

test('recover() reports staging and purge leftovers and never touches them', () => {
  const world = makeWorld('leftovers')
  const batchId = applyAll(world)
  mkdirSync(path.join(world.trashDir, `${STAGING_PREFIX}b-20260101T000000Z-00000000`), { mode: 0o700 })
  mkdirSync(path.join(world.trashDir, `${PURGE_PREFIX}b-20260101T000000Z-11111111`), { mode: 0o700 })
  const before = treeOf(world.trashDir)
  const report = trashFor(world).recover()
  assert.deepEqual(report.orphans, [`${STAGING_PREFIX}b-20260101T000000Z-00000000`])
  assert.deepEqual(report.tombstones, ['b-20260101T000000Z-11111111'])
  assert.deepEqual(report.batches.map((entry) => entry.batchId), [batchId])
  assert.deepEqual(treeOf(world.trashDir).filter((l) => !l.includes('.lock')), before.filter((l) => !l.includes('.lock')))
})

// A session the journal places in the store (restored, rolled back or never moved) and that is in neither place of
// its batch left the store by other means: a newer batch pruned it again, or the host removed it. The batch never
// held it, so it is not lost there. Only a session the journal places in the batch's own trash can be lost.

/** The rows the Host's Trash tab shows: service.js trashList hides a batch that holds nothing and needs nothing. */
const shownRows = (trash) => trash.list().batches.filter((row) => !(row.state === 'complete' && row.sessions === 0))
const rowOf = (list, batchId) => {
  const { units, sessions, bytes, state } = list.batches.find((row) => row.batchId === batchId)
  return { units, sessions, bytes, state }
}
const NOTHING = Object.freeze({ units: 0, sessions: 0, bytes: 0 })

test('recover(): sessions a newer batch prunes again are not lost in the older, restored batch; it stays complete, unlisted and unwritten', () => {
  const world = makeWorld('reprune')
  const b1 = applyAll(world)
  const trash = trashFor(world)
  assert.equal(trash.restore(b1).state, 'complete')
  assert.deepEqual(treeOf(world.store), world.storeTree)
  const oldDir = path.join(world.trashDir, b1)
  const oldTree = treeOf(oldDir)
  // The same units are pruned again (runApply runs recover() first, as the Host's apply does).
  const b2 = applyAll(world)
  assert.notEqual(b2, b1)
  for (const s of world.intent.sessions) assert.ok(existsSync(trashPath(world, b2, s.id)), `${s.id} is in the newer batch`)
  assertEachOnce(world, 'pruned again')
  assert.deepEqual(treeOf(oldDir), oldTree, 'the newer apply does not write to the restored batch')

  const events = []
  const report = trashFor(world, { events }).recover()
  const old = report.batches.find((entry) => entry.batchId === b1)
  assert.deepEqual(
    { state: old.state, appended: old.appended, moved: old.moved, conflicts: old.conflicts, lost: old.lost, failures: old.failures },
    { state: 'complete', appended: 0, moved: 0, conflicts: [], lost: [], failures: [] },
  )
  const held = report.batches.find((entry) => entry.batchId === b2)
  assert.deepEqual([held.state, held.appended, held.moved, held.lost, held.conflicts], ['complete', 0, 0, [], []])
  assert.ok(!events.some((event) => event.name === 'renameSync' && !path.basename(event.paths[0]).startsWith('.lock')), 'no session moved')
  assert.deepEqual(treeOf(oldDir), oldTree, 'recover() does not write to the restored batch')
  assert.deepEqual(trash.inspect(b1).sessions.map((s) => [s.id, s.location]), world.intent.sessions.map((s) => [s.id, 'store']))
  const list = trash.list()
  assertTrashList(list)
  assert.deepEqual(rowOf(list, b1), { ...NOTHING, state: 'complete' })
  assert.deepEqual(shownRows(trash).map((row) => row.batchId), [b2], 'the Trash tab shows the newer batch only')

  // A restore of the older batch is a no-op: it journals and moves nothing.
  const frozen = trashSnapshot(world)
  const again = trash.restore(b1)
  assertApplyResult(again)
  assert.deepEqual([again.state, again.moved, again.skipped, again.warnings], ['complete', NOTHING, [], []])
  assert.deepEqual(trashSnapshot(world), frozen, 'restoring the older batch changes nothing')
  trashFor(world).recover()
  assert.deepEqual(trashSnapshot(world), frozen, 'a second recover() changes nothing')
  assertEachOnce(world, 'after the no-op restore')

  // The newer batch is deleted for good: nothing changes for the older one.
  const purged = trash.purge(b2)
  assertPurgeResult(purged)
  assert.equal(purged.removedSessions, world.intent.sessions.length)
  const later = trashFor(world).recover()
  assert.deepEqual(later.batches.map((entry) => [entry.batchId, entry.state, entry.appended, entry.moved, entry.lost, entry.conflicts]), [[b1, 'complete', 0, 0, [], []]])
  assert.deepEqual(treeOf(oldDir), oldTree, 'the purge of the newer batch does not write to the restored batch')
  assert.deepEqual(rowOf(trash.list(), b1), { ...NOTHING, state: 'complete' })
  assert.deepEqual(shownRows(trash), [])
  const last = trash.restore(b1)
  assertApplyResult(last)
  assert.deepEqual([last.state, last.moved, last.skipped], ['complete', NOTHING, []])
  assert.deepEqual(treeOf(oldDir), oldTree)
  for (const s of world.intent.sessions) assert.ok(!existsSync(s.source), `${s.id} is not brought back from anywhere`)
  for (const id of world.kept) assert.deepEqual(treeOf(storePath(world, id)), world.trees.get(id))
})

test('recover(): in a partly restored batch, re-pruned sessions are not lost; a session still in its trash that is gone is lost; one in both places is conflict', () => {
  const world = makeWorld('reprune-lost')
  const b1 = applyAll(world)
  const trash = trashFor(world)
  // Unit sb1 is refused at restore and stays in the trash; units sa1 and sc1 go back to the store.
  const partial = trash.restore(b1, { precheck: (entry) => (entry.id === 'sb1' ? 'live' : null) })
  assertApplyResult(partial)
  assert.deepEqual([partial.state, partial.moved.units, partial.skipped], ['partial', 2, [{ rootId: 'sb1', reasons: [{ code: 'live', sessionId: 'sb1' }] }]])
  // Unit sa1 is pruned again into a newer batch.
  const again = ['sa1', 'sa2', 'sa3']
  const { batch: newer, result } = runApply(trashFor(world), {
    ...world.intent, units: [world.intent.units[0]], sessions: world.intent.sessions.filter((s) => again.includes(s.id)),
  })
  assert.equal(result.state, 'complete')
  const b2 = newer.batchId
  // sb1, which the journal still places in the older batch's trash, disappears; sc2, restored, gets a second copy there.
  rmSync(trashPath(world, b1, 'sb1'), { recursive: true })
  cpSync(storePath(world, 'sc2'), trashPath(world, b1, 'sc2'), { recursive: true })
  const file = path.join(world.trashDir, b1, 'journal.jsonl')
  const linesBefore = journalLines(file).length

  const events = []
  const report = trashFor(world, { events }).recover()
  const old = report.batches.find((entry) => entry.batchId === b1)
  assert.deepEqual([old.state, old.lost, old.conflicts, old.moved], ['conflict', ['sb1'], ['sc2'], 0])
  const added = journalLines(file).slice(linesBefore)
  assert.deepEqual(added.filter((line) => line.op === 'recovered').map((line) => `${line.id}:${line.location}`).sort(), ['sb1:lost', 'sc2:conflict'])
  assert.deepEqual(added.map((line) => line.op).at(-1), 'recover')
  const held = report.batches.find((entry) => entry.batchId === b2)
  assert.deepEqual([held.state, held.appended, held.lost], ['complete', 0, []])
  assert.ok(!events.some((event) => event.name === 'renameSync' && !path.basename(event.paths[0]).startsWith('.lock')), 'no session moved')
  assert.ok(!events.some((event) => event.name === 'unlinkSync' || event.name === 'rmdirSync'), 'nothing deleted')
  assert.deepEqual(trash.inspect(b1).sessions.map((s) => [s.id, s.location]), [
    ['sa1', 'store'], ['sa2', 'store'], ['sa3', 'store'], ['sb1', 'lost'], ['sc1', 'store'], ['sc2', 'conflict'],
  ])
  for (const id of again) assert.deepEqual(treeOf(trashPath(world, b2, id)), world.trees.get(id), `${id} stays in the newer batch`)
  assert.ok(existsSync(storePath(world, 'sc2')) && existsSync(trashPath(world, b1, 'sc2')), 'both copies of a conflict stay')
  assert.deepEqual(shownRows(trash).map((row) => [row.batchId, row.state]).sort(), [[b1, 'conflict'], [b2, 'complete']].sort())

  const frozen = trashSnapshot(world)
  const second = trashFor(world).recover()
  assert.ok(second.batches.every((entry) => entry.appended === 0 && entry.moved === 0), 'a second recover() appends and moves nothing')
  assert.deepEqual(trashSnapshot(world), frozen, 'a second recover() changes nothing')
})

test('recover(): a unit skipped at apply because a member left the store before its move does not make the batch conflict', () => {
  const world = makeWorld('gone-before-move')
  rmSync(storePath(world, 'sb1'), { recursive: true })
  const { batch, result } = runApply(trashFor(world), world.intent)
  assertApplyResult(result)
  assert.equal(result.state, 'partial')
  assert.deepEqual(result.skipped, [{ rootId: 'sb1', reasons: [{ code: 'no-location', sessionId: 'sb1' }] }])
  const dir = path.join(world.trashDir, batch.batchId)
  const before = treeOf(dir)
  const report = trashFor(world).recover()
  assert.deepEqual(report.batches.map((entry) => [entry.state, entry.appended, entry.moved, entry.lost]), [['complete', 0, 0, []]])
  assert.deepEqual(treeOf(dir), before, 'recover() writes nothing')
  assert.equal(trashFor(world).inspect(batch.batchId).sessions.find((s) => s.id === 'sb1').location, 'store')
  assert.deepEqual(rowOf(trashFor(world).list(), batch.batchId), { units: 2, sessions: 5, bytes: result.moved.bytes, state: 'complete' })
  const back = trashFor(world).restore(batch.batchId)
  assertApplyResult(back)
  assert.deepEqual([back.state, back.moved.units, back.moved.sessions, back.skipped], ['complete', 2, 5, []])
  for (const s of world.intent.sessions) if (s.id !== 'sb1') assert.deepEqual(treeOf(s.source), world.trees.get(s.id), `${s.id} is back`)
})

test('recover(): an apply that crashed mid-unit, whose unmoved member then left the store, is made whole in the store, not lost', () => {
  const world = makeWorld('crash-then-gone', MATRIX)
  // Crash at the rename of sa2: sa1 is in the trash (journaled), sa2 and sb1 are still in the store.
  const crashing = instrumentedFs({
    root: world.root, override: world.override, crashWhen: (name, paths) => name === 'renameSync' && paths[0] === storePath(world, 'sa2'),
  })
  assert.throws(() => runApply(faultyTrash(world, crashing.fs), world.intent))
  crashing.closeLeaked()
  const [batchId] = readdirSync(world.trashDir).filter((name) => BATCH_ID_PATTERN.test(name))
  assert.ok(existsSync(trashPath(world, batchId, 'sa1')))
  // The host removes sa2 before the next start.
  rmSync(storePath(world, 'sa2'), { recursive: true })

  const events = []
  const report = recoverer(world, events).recover()
  const entry = report.batches.find((item) => item.batchId === batchId)
  assert.deepEqual([entry.state, entry.moved, entry.lost, entry.conflicts, entry.failures], ['complete', 1, [], [], []])
  assert.deepEqual(treeOf(storePath(world, 'sa1')), world.trees.get('sa1'), 'sa1 is back in the store, intact')
  assert.ok(!existsSync(trashPath(world, batchId, 'sa1')))
  assert.ok(!events.some((event) => event.name === 'unlinkSync' || event.name === 'rmdirSync'), 'recover() never deletes')
  const recovered = journalLines(path.join(world.trashDir, batchId, 'journal.jsonl')).filter((line) => line.op === 'recovered')
  assert.deepEqual(recovered.map((line) => `${line.id}:${line.location}`), ['sa1:store'])
  const detail = recoverer(world).inspect(batchId)
  assert.deepEqual([detail.state, detail.openOp, detail.held], ['complete', null, NOTHING])
  const frozen = trashSnapshot(world)
  recoverer(world).recover()
  assert.deepEqual(trashSnapshot(world), frozen, 'a second recover() changes nothing')
})

// ---------------------------------------------------------------------------
// 5. Fault injection
// ---------------------------------------------------------------------------

/**
 * Runs `act` once with a clean instrumented fs to count its calls, then once
 * per call index k and mode (fail: that call throws EIO once; crash: that call
 * and every later one throw, a crashing write leaves half its bytes), each on
 * a fresh world, and calls `check` with a label naming the index.
 */
function faultMatrix(t, name, { prepare, act, check, identity = FAULTY }) {
  const probeWorld = prepare()
  const probe = instrumentedFs({ root: probeWorld.root, override: probeWorld.override })
  act(probeWorld, faultyTrash(probeWorld, probe.fs, identity))
  const total = probe.calls()
  assert.ok(total > 30, `${name}: the clean run makes ${total} calls`)
  rmSync(probeWorld.root, { recursive: true, force: true })
  let runs = 0
  for (let k = 0; k < total; k += 1) {
    for (const mode of ['fail', 'crash']) {
      const world = prepare()
      const faulty = instrumentedFs({ root: world.root, failAt: k, mode, override: world.override })
      let thrown = null
      try {
        act(world, faultyTrash(world, faulty.fs, identity))
      } catch (error) {
        thrown = error
      }
      faulty.closeLeaked()
      const hit = faulty.hit()
      const label = `${name}: ${mode} at call index ${k} (${hit ? `${hit.name} ${hit.paths.map((p) => path.relative(world.root, p)).join(' -> ')}` : 'not reached'})`
      try {
        assert.ok(hit, 'the fault was reached')
        check(world, label, thrown)
      } catch (error) {
        error.message = `${label}: ${error.message}`
        throw error
      }
      rmSync(world.root, { recursive: true, force: true })
      runs += 1
    }
  }
  t.diagnostic(`${name}: ${total} file-system calls in a clean run; ${runs} fault runs (fail and crash at every index 0..${total - 1})`)
  return { total, runs }
}

const MATRIX = Object.freeze({ layout: MATRIX_LAYOUT, kept: MATRIX_KEPT, override: NO_FSYNC })

/** recover() on a new instance, the invariant, and an idempotent second recover(). */
function recoverAndCheck(world, label) {
  const events = []
  const fresh = recoverer(world, events)
  fresh.recover()
  assert.ok(!events.some((event) => event.name === 'unlinkSync' || event.name === 'rmdirSync'), `${label}: recover() deleted something`)
  assertEachOnce(world, label)
  const frozen = trashSnapshot(world)
  recoverer(world).recover()
  assert.deepEqual(trashSnapshot(world), frozen, `${label}: a second recover() changed the trash`)
  assert.ok(!existsSync(path.join(world.trashDir, '.lock')), `${label}: the lock is released`)
  return fresh
}

function restoreEverything(world, trash, label) {
  const list = trash.list()
  assertTrashList(list)
  for (const row of list.batches) {
    const result = trash.restore(row.batchId)
    assertApplyResult(result)
    assert.ok(result.skipped.length === 0, `${label}: restore skipped ${JSON.stringify(result.skipped)}`)
  }
  assert.deepEqual(treeOf(world.store), world.storeTree, `${label}: the store is not back to its tree from before the prune`)
}

test('fault injection: apply fails or stops at every fs call index; recover() leaves each session once, intact', (t) => {
  faultMatrix(t, 'apply', {
    prepare: () => makeWorld('fi-apply', MATRIX),
    act: (world, trash) => runApply(trash, world.intent),
    check: (world, label) => {
      const fresh = recoverAndCheck(world, label)
      restoreEverything(world, fresh, label)
    },
  })
})

test('fault injection: restore fails or stops at every fs call index; recover() leaves each session once, intact', (t) => {
  faultMatrix(t, 'restore', {
    prepare: () => {
      const world = makeWorld('fi-restore', MATRIX)
      world.batchId = applyAll(world)
      return world
    },
    act: (world, trash) => trash.restore(world.batchId),
    check: (world, label) => {
      const fresh = recoverAndCheck(world, label)
      const result = fresh.restore(world.batchId)
      assertApplyResult(result)
      assert.deepEqual(result.skipped, [], `${label}: skipped`)
      assert.deepEqual(treeOf(world.store), world.storeTree, `${label}: the store is not back to its tree from before the prune`)
      const frozen = trashSnapshot(world)
      const again = fresh.restore(world.batchId)
      assert.equal(again.moved.sessions, 0, `${label}: a second restore moved something`)
      assert.deepEqual(trashSnapshot(world), frozen, `${label}: a second restore changed the trash`)
    },
  })
})

test('fault injection: purge fails or stops at every fs call index; the store and the sibling batch never change', (t) => {
  const PURGED = ['sa1', 'sa2']
  faultMatrix(t, 'purge', {
    prepare: () => {
      const world = makeWorld('fi-purge', MATRIX)
      const trash = trashFor(world)
      const first = trash.createBatch({ ...world.intent, units: world.intent.units.slice(0, 1), sessions: world.intent.sessions.filter((s) => PURGED.includes(s.id)) })
      for (const unit of first.units) first.moveUnit(unit, () => null)
      first.finish()
      const second = trash.createBatch({ ...world.intent, units: world.intent.units.slice(1), sessions: world.intent.sessions.filter((s) => !PURGED.includes(s.id)) })
      for (const unit of second.units) second.moveUnit(unit, () => null)
      second.finish()
      world.batchId = first.batchId
      world.siblingId = second.batchId
      world.storeAfter = treeOf(world.store)
      world.siblingTree = treeOf(path.join(world.trashDir, second.batchId))
      return world
    },
    act: (world, trash) => trash.purge(world.batchId),
    check: (world, label) => {
      const fresh = recoverer(world)
      fresh.recover()
      const dir = path.join(world.trashDir, world.batchId)
      const tomb = path.join(world.trashDir, `${PURGE_PREFIX}${world.batchId}`)
      assert.deepEqual(treeOf(world.store), world.storeAfter, `${label}: the store changed`)
      assert.deepEqual(treeOf(path.join(world.trashDir, world.siblingId)), world.siblingTree, `${label}: the sibling batch changed`)
      if (existsSync(dir)) {
        // Not committed: the batch is whole, every session in it intact, and it is not in the middle of a purge.
        assert.ok(!existsSync(tomb), `${label}: batch and purge folder both exist`)
        assertEachOnce(world, label)
        assert.equal(fresh.inspect(world.batchId).state, 'complete', `${label}: batch state`)
      } else {
        // Committed: no session of the batch is anywhere but in the purge folder.
        const places = placesOf(world)
        for (const id of PURGED) for (const place of places.get(id)) assert.ok(isInside(tomb, place), `${label}: ${id} at ${place}`)
        for (const id of world.wsOf.keys()) if (!PURGED.includes(id)) assert.equal(places.get(id).length, 1, `${label}: ${id}`)
      }
      if (existsSync(dir) || existsSync(tomb)) {
        const result = fresh.purge(world.batchId)
        assertPurgeResult(result)
      } else {
        assert.throws(() => fresh.purge(world.batchId), (error) => error.code === ERROR.batchNotFound)
      }
      assert.ok(!existsSync(dir) && !existsSync(tomb), `${label}: the purge did not finish`)
      assert.deepEqual(treeOf(path.join(world.trashDir, world.siblingId)), world.siblingTree, `${label}: the sibling batch changed`)
      assert.deepEqual(treeOf(world.store), world.storeAfter, `${label}: the store changed`)
      assert.deepEqual(readdirSync(world.trashDir).filter((name) => !name.startsWith('.')), [world.siblingId], `${label}: leftovers`)
    },
  })
})

test('fault injection: recover() of an apply that crashed mid-unit fails or stops at every index; the next recover() completes', (t) => {
  faultMatrix(t, 'recover', {
    // The first crashed host (FAULTY) left its lock; the second (FAULTY_TWO) must see it as stale.
    identity: FAULTY_TWO,
    prepare: () => {
      const world = makeWorld('fi-recover', MATRIX)
      // Crash the apply at the rename of sa2: sa1 is in the trash, sa2 and sa3 are not, the lock is left behind.
      const crashing = instrumentedFs({
        root: world.root,
        override: world.override,
        crashWhen: (name, paths) => name === 'renameSync' && paths[0] === storePath(world, 'sa2'),
      })
      assert.throws(() => runApply(faultyTrash(world, crashing.fs), world.intent))
      crashing.closeLeaked()
      assert.ok(existsSync(path.join(world.trashDir, '.lock')))
      return world
    },
    act: (world, trash) => trash.recover(),
    check: (world, label) => {
      const fresh = recoverAndCheck(world, label)
      for (const id of ['sa1', 'sa2']) assert.ok(existsSync(storePath(world, id)), `${label}: the split unit is whole in the store`)
      restoreEverything(world, fresh, label)
    },
  })
})

// ---------------------------------------------------------------------------
// 6. Restore
// ---------------------------------------------------------------------------

test('restore round trip: tree and hashes equal the state before the prune; a second restore is a no-op', () => {
  const world = makeWorld('round-trip')
  const batchId = applyAll(world)
  assert.notDeepEqual(treeOf(world.store), world.storeTree)
  const trash = trashFor(world)
  const result = trash.restore(batchId)
  assertApplyResult(result)
  assert.equal(result.batchId, batchId)
  assert.equal(result.state, 'complete')
  assert.deepEqual(result.moved, { units: 3, sessions: 6, bytes: world.intent.sessions.reduce((sum, s) => sum + s.bytes, 0) })
  assert.deepEqual(treeOf(world.store), world.storeTree)
  const ops = journalOps(world, batchId)
  assert.equal(ops.filter((op) => op === 'restored').length, 6)
  assert.deepEqual([ops.indexOf('restore-start') < ops.indexOf('restored'), ops.at(-1)], [true, 'restore-end'])
  const row = trash.list().batches.find((entry) => entry.batchId === batchId)
  assert.deepEqual([row.units, row.sessions, row.bytes, row.state], [0, 0, 0, 'complete'])

  const frozen = trashSnapshot(world)
  const again = trash.restore(batchId)
  assertApplyResult(again)
  assert.deepEqual(again.moved, { units: 0, sessions: 0, bytes: 0 })
  assert.deepEqual(again.skipped, [])
  assert.deepEqual(trashSnapshot(world), frozen, 'nothing is journaled or moved')
  assert.deepEqual(treeOf(world.store), world.storeTree)
})

test('restore: an existing destination (a lock-only leftover or any folder) is conflict; the unit stays whole in trash, nothing is overwritten', () => {
  const world = makeWorld('restore-conflict')
  const batchId = applyAll(world)
  mkdirSync(storePath(world, 'sb1'))
  writeFileSync(path.join(storePath(world, 'sb1'), 'session.lock'), '')
  mkdirSync(storePath(world, 'sa2'))
  const events = []
  const trash = trashFor(world, { events })
  const result = trash.restore(batchId)
  assertApplyResult(result)
  assert.equal(result.state, 'conflict')
  assert.deepEqual(result.skipped.map((entry) => [entry.rootId, entry.reasons]).sort(), [
    ['sa1', [{ code: 'conflict', sessionId: 'sa2' }]],
    ['sb1', [{ code: 'conflict', sessionId: 'sb1' }]],
  ])
  assert.deepEqual(result.moved, { units: 1, sessions: 2, bytes: 1000 + 99 + 1000 + 99 })
  assert.deepEqual(readdirSync(storePath(world, 'sb1')), ['session.lock'], 'the leftover is untouched')
  assert.deepEqual(readdirSync(storePath(world, 'sa2')), [])
  for (const id of ['sa1', 'sa2', 'sa3', 'sb1']) assert.deepEqual(treeOf(trashPath(world, batchId, id)), world.trees.get(id), `${id} stays in trash`)
  assert.ok(!events.some((event) => event.name === 'renameSync' && ['sa1', 'sa2', 'sa3', 'sb1'].includes(path.basename(event.paths[0]))))
  const frozen = trashSnapshot(world)
  const again = trash.restore(batchId)
  assert.deepEqual(again.moved, { units: 0, sessions: 0, bytes: 0 })
  assert.equal(again.skipped.length, 2)
  assert.deepEqual(trashSnapshot(world), frozen, 'a repeated conflict journals nothing')
})

test('restore: a destination that appears during the precheck (the host recreating the folder) is conflict, never renamed onto', () => {
  const world = makeWorld('restore-race')
  const batchId = applyAll(world)
  const order = []
  const result = trashFor(world).restore(batchId, {
    precheck: (entry) => {
      order.push(`check:${entry.id}`)
      // The folder appears between the checks and the rename. Empty is the dangerous case: rename(2) would replace it.
      if (entry.id === 'sa2') mkdirSync(entry.source)
      return () => order.push(`release:${entry.id}`)
    },
  })
  assertApplyResult(result)
  assert.deepEqual(result.skipped.find((entry) => entry.rootId === 'sa1').reasons, [{ code: 'conflict', sessionId: 'sa2' }])
  assert.deepEqual(readdirSync(storePath(world, 'sa2')), [], 'the empty folder is not replaced')
  for (const id of ['sa1', 'sa2', 'sa3']) assert.deepEqual(treeOf(trashPath(world, batchId, id)), world.trees.get(id), `${id} is whole in trash`)
  assert.ok(!existsSync(storePath(world, 'sa1')), 'sa1 went back to the trash with its unit')
  assert.deepEqual(order.slice(0, 4), ['check:sa1', 'check:sa2', 'release:sa2', 'release:sa1'])
  for (const id of ['sb1', 'sc1', 'sc2']) assert.ok(existsSync(storePath(world, id)))
})

test('a journal line that cannot be written right after a rename: the unit is renamed back and moveUnit throws trash-unusable', () => {
  const probe = makeWorld('journal-fail-probe')
  const events = []
  const t1 = trashFor(probe, { events })
  const b1 = t1.createBatch(probe.intent)
  b1.moveUnit(b1.units[0], () => null)
  b1.finish()
  const rename = events.find((event) => event.name === 'renameSync' && event.paths[0] === storePath(probe, 'sa2'))
  const write = events.find((event) => event.index > rename.index && event.name === 'writeSync')
  const world = makeWorld('journal-fail')
  const faulty = instrumentedFs({ root: world.root, failAt: write.index, mode: 'fail' })
  const trash = trashFor(world, { fs: faulty.fs })
  const batch = trash.createBatch(world.intent)
  assert.throws(() => batch.moveUnit(batch.units[0], () => null), (error) => error instanceof TrashError && error.code === ERROR.trashUnusable)
  assert.equal(faulty.hit().name, 'writeSync')
  for (const id of ['sa1', 'sa2', 'sa3']) assert.deepEqual(treeOf(storePath(world, id)), world.trees.get(id), `${id} is back in the store`)
  const ops = journalOps(world, batch.batchId)
  assert.deepEqual(ops, ['begin', 'moved', 'rolled-back', 'rolled-back', 'unit-failed'])
  batch.finish()
  assert.equal(trashFor(world).inspect(batch.batchId).state, 'complete')
})

test('restore creates only a missing recorded project folder (0700, journaled) and never the sessions tree or anything above', () => {
  const layout = [...LAYOUT, { rootId: 'sd1', members: [['sd1', 'delta', null]] }]
  const world = makeWorld('restore-mkdir', { layout })
  const batchId = applyAll(world)
  rmdirSync(path.join(world.store, 'delta'))
  const trash = trashFor(world)
  const result = trash.restore(batchId)
  assert.equal(result.state, 'complete')
  assert.equal(modeOf(path.join(world.store, 'delta')), 0o700)
  assert.deepEqual(treeOf(storePath(world, 'sd1')), world.trees.get('sd1'))
  const created = journalLines(path.join(world.trashDir, batchId, 'journal.jsonl')).filter((line) => line.op === 'folder-created')
  assert.deepEqual(created.map((line) => line.workspaceDir), ['delta'])
  assert.deepEqual(trash.inspect(batchId).createdFolders, ['delta'])

  // The sessions tree itself is gone: refused, and nothing is created in its place.
  const world2 = makeWorld('restore-no-root')
  const batch2 = applyAll(world2)
  const aside = `${world2.store}-aside`
  renameSync(world2.store, aside)
  assert.throws(() => trashFor(world2).restore(batch2), (error) => error instanceof PathError && error.code === 'path-unsafe')
  assert.ok(!existsSync(world2.store))
  renameSync(aside, world2.store)
  assertEachOnce(world2, 'restore-no-root')
})

test('restore targets only the exact recorded folder: a tampered manifest is refused with path-unsafe', () => {
  const world = makeWorld('tampered')
  const batchId = applyAll(world)
  const file = path.join(world.trashDir, batchId, 'manifest.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  const decoy = path.join(world.root, 'decoy')
  manifest.sessions.find((s) => s.id === 'sb1').source = path.join(decoy, 'sb1')
  manifest.sessions.find((s) => s.id === 'sc2').workspaceDir = '..'
  manifest.sessions.find((s) => s.id === 'sc2').source = path.join(world.store, '..', 'sc2')
  writeFileSync(file, JSON.stringify(manifest))
  const result = trashFor(world).restore(batchId)
  assert.deepEqual(result.skipped.map((entry) => [entry.rootId, entry.reasons]).sort(), [
    ['sb1', [{ code: 'path-unsafe', sessionId: 'sb1' }]],
    ['sc1', [{ code: 'path-unsafe', sessionId: 'sc2' }]],
  ])
  assert.ok(!existsSync(decoy))
  assert.ok(!existsSync(path.join(world.store, '..', 'sc2')))
  assert.ok(existsSync(storePath(world, 'sa1')), 'the untampered unit is restored')
})

// ---------------------------------------------------------------------------
// 7. Purge
// ---------------------------------------------------------------------------

test('purge removes only <trashDir>/<batchId> and never follows a link inside it', () => {
  const world = makeWorld('purge')
  const trash = trashFor(world)
  const first = trash.createBatch({ ...world.intent, units: world.intent.units.slice(0, 2), sessions: world.intent.sessions.slice(0, 4) })
  for (const unit of first.units) first.moveUnit(unit, () => null)
  first.finish()
  const second = trash.createBatch({ ...world.intent, units: world.intent.units.slice(2), sessions: world.intent.sessions.slice(4) })
  for (const unit of second.units) second.moveUnit(unit, () => null)
  second.finish()
  const precious = path.join(world.root, 'precious')
  mkdirSync(precious)
  writeFileSync(path.join(precious, 'keep.txt'), 'keep')
  symlinkSync(precious, path.join(trashPath(world, first.batchId, 'sa1'), 'escape'))
  symlinkSync(path.join(precious, 'keep.txt'), path.join(trashPath(world, first.batchId, 'sa2'), 'escape-file'))
  const siblingTree = treeOf(path.join(world.trashDir, second.batchId))
  const storeTree = treeOf(world.store)

  const result = trash.purge(first.batchId)
  assertPurgeResult(result)
  assert.equal(result.batchId, first.batchId)
  assert.equal(result.removedSessions, 4)
  assert.ok(result.removedBytes > 4 * 1000, `removed ${result.removedBytes} bytes`)
  assert.ok(!existsSync(path.join(world.trashDir, first.batchId)))
  assert.ok(!existsSync(path.join(world.trashDir, `${PURGE_PREFIX}${first.batchId}`)))
  assert.deepEqual(readdirSync(precious), ['keep.txt'])
  assert.equal(readFileSync(path.join(precious, 'keep.txt'), 'utf8'), 'keep')
  assert.deepEqual(treeOf(path.join(world.trashDir, second.batchId)), siblingTree)
  assert.deepEqual(treeOf(world.store), storeTree)
  assert.deepEqual(trash.list().batches.map((row) => row.batchId), [second.batchId])
  assert.throws(() => trash.restore(first.batchId), (error) => error.code === ERROR.batchNotFound)
})

test('purge refusals: disabled, bad id, unknown batch, symlinked batch, missing or symlinked manifest', () => {
  const world = makeWorld('purge-refuse')
  const batchId = applyAll(world)
  const before = treeOf(world.trashDir)
  const events = []
  const disabled = trashFor(world, { events, config: resolveConfig({ dataDir: world.dataDir, allowPermanentDelete: false }, {}) })
  assert.throws(() => disabled.purge(batchId), (error) => error instanceof TrashError && error.code === ERROR.purgeDisabled)
  assert.equal(events.length, 0, 'a disabled purge touches nothing')

  const trash = trashFor(world)
  for (const bad of ['../x', 'a/b', '.lock', '', '..', 'x'.repeat(65), `${PURGE_PREFIX}${batchId}`, 'a\\b', null]) {
    assert.throws(() => trash.purge(bad), (error) => error.code === 'path-unsafe', String(bad))
  }
  assert.throws(() => trash.purge('b-20200101T000000Z-deadbeef'), (error) => error.code === ERROR.batchNotFound)

  // A batch folder that is a symlink to a folder with a valid-looking manifest.
  const elsewhere = path.join(world.root, 'elsewhere')
  cpSync(path.join(world.trashDir, batchId), elsewhere, { recursive: true })
  const fakeId = 'b-20200101T000000Z-0badf00d'
  const fake = JSON.parse(readFileSync(path.join(elsewhere, 'manifest.json'), 'utf8'))
  writeFileSync(path.join(elsewhere, 'manifest.json'), JSON.stringify({ ...fake, batchId: fakeId }))
  symlinkSync(elsewhere, path.join(world.trashDir, fakeId))
  const elsewhereTree = treeOf(elsewhere)
  assert.throws(() => trash.purge(fakeId), (error) => error.code === 'path-unsafe')
  assert.deepEqual(treeOf(elsewhere), elsewhereTree)
  rmSync(path.join(world.trashDir, fakeId))
  rmSync(elsewhere, { recursive: true }) // the copy would count as a second place of each session

  // A folder without a manifest is not a batch.
  const bare = path.join(world.trashDir, 'b-20200101T000000Z-00000bad')
  mkdirSync(path.join(bare, 'sessions'), { recursive: true, mode: 0o700 })
  assert.throws(() => trash.purge('b-20200101T000000Z-00000bad'), (error) => error.code === ERROR.batchNotFound)
  assert.ok(existsSync(path.join(bare, 'sessions')))
  rmSync(bare, { recursive: true })

  // A symlinked manifest.
  const manifestFile = path.join(world.trashDir, batchId, 'manifest.json')
  const realManifest = path.join(world.root, 'manifest-copy.json')
  renameSync(manifestFile, realManifest)
  symlinkSync(realManifest, manifestFile)
  assert.throws(() => trash.purge(batchId), (error) => error.code === 'path-unsafe')
  rmSync(manifestFile)
  renameSync(realManifest, manifestFile)
  assert.deepEqual(treeOf(world.trashDir).filter((l) => !l.includes('.lock')), before.filter((l) => !l.includes('.lock')))
  assertEachOnce(world, 'purge-refuse')
})

test('only purge() can remove anything: the criterion grep matches inside purge alone, and no other operation calls a remove', () => {
  const lines = readFileSync(SRC_FILE, 'utf8').split('\n')
  const start = lines.findIndex((line) => /^ {2}function purge\(/.test(line))
  const end = lines.findIndex((line, index) => index > start && line === '  }')
  assert.ok(start > 0 && end > start, 'purge() is found')
  const hits = lines.map((line, index) => [index, line]).filter(([, line]) => /rm[(]|rmSync|unlink|rmdir/.test(line))
  assert.ok(hits.length >= 2)
  for (const [index, line] of hits) assert.ok(index > start && index < end, `line ${index + 1} is outside purge(): ${line.trim()}`)

  const world = makeWorld('no-remove')
  const events = []
  const trash = trashFor(world, { events })
  const { batch } = runApply(trash, world.intent)
  trash.recover()
  trash.list()
  trash.inspect(batch.batchId)
  trash.restore(batch.batchId)
  trash.recordStep(batch.batchId, { step: 'attach', id: 'sa1', outcome: 'ok' })
  assert.ok(!events.some((event) => event.name === 'unlinkSync' || event.name === 'rmdirSync'))
})

// ---------------------------------------------------------------------------
// 8. Path attacks
// ---------------------------------------------------------------------------

test('path attacks: symlinked session or project folder, symlinked batch components', () => {
  const world = makeWorld('attack-links')
  // sa2's folder is a symlink to a real copy elsewhere; beta (sb1's project folder) is a symlink too.
  const elsewhere = path.join(world.root, 'elsewhere')
  mkdirSync(elsewhere)
  renameSync(storePath(world, 'sa2'), path.join(elsewhere, 'sa2'))
  symlinkSync(path.join(elsewhere, 'sa2'), storePath(world, 'sa2'))
  const trash = trashFor(world)
  const batch = trash.createBatch(world.intent)
  const a = batch.moveUnit(batch.units[0], () => null)
  assert.deepEqual(a.reasons, [{ code: 'path-unsafe', sessionId: 'sa2' }])
  assert.ok(existsSync(storePath(world, 'sa1')), 'sa1 is renamed back')
  assert.ok(lstatSync(storePath(world, 'sa2')).isSymbolicLink(), 'the link is untouched')
  assert.deepEqual(treeOf(path.join(elsewhere, 'sa2')), world.trees.get('sa2'))
  // <batch>/sessions/gamma is a symlink.
  const gammaTarget = path.join(world.root, 'gamma-target')
  mkdirSync(gammaTarget)
  symlinkSync(gammaTarget, path.join(world.trashDir, batch.batchId, 'sessions', 'gamma'))
  const c = batch.moveUnit(batch.units[2], () => null)
  assert.deepEqual(c.reasons, [{ code: 'path-unsafe', sessionId: 'sc2' }])
  assert.deepEqual(readdirSync(gammaTarget), [])
  assert.ok(existsSync(storePath(world, 'sc1')) && existsSync(storePath(world, 'sc2')))
  batch.finish()

  const world2 = makeWorld('attack-project')
  const realBeta = path.join(world2.root, 'real-beta')
  renameSync(path.join(world2.store, 'beta'), realBeta)
  symlinkSync(realBeta, path.join(world2.store, 'beta'))
  const t2 = trashFor(world2)
  const b2 = t2.createBatch(world2.intent)
  assert.deepEqual(b2.moveUnit(b2.units[1], () => null).reasons, [{ code: 'path-unsafe', sessionId: 'sb1' }])
  // <batch>/sessions itself is a symlink: the whole unit is refused.
  const sessionsDir = path.join(world2.trashDir, b2.batchId, 'sessions')
  rmdirSync(sessionsDir)
  const sessionsTarget = path.join(world2.root, 'sessions-target')
  mkdirSync(sessionsTarget)
  symlinkSync(sessionsTarget, sessionsDir)
  assert.equal(b2.moveUnit(b2.units[0], () => null).reasons[0].code, 'path-unsafe')
  assert.deepEqual(readdirSync(sessionsTarget), [])
  b2.finish()
  assert.ok(existsSync(path.join(realBeta, 'sb1')))
  for (const id of ['sa1', 'sa2', 'sa3']) assert.ok(existsSync(storePath(world2, id)))

  // A symlinked batch folder is refused by restore, inspect and recover (reported, untouched).
  const world3 = makeWorld('attack-batch')
  const batchId = applyAll(world3)
  const moved = path.join(world3.root, 'moved-batch')
  renameSync(path.join(world3.trashDir, batchId), moved)
  symlinkSync(moved, path.join(world3.trashDir, batchId))
  const t3 = trashFor(world3)
  assert.throws(() => t3.restore(batchId), (error) => error.code === 'path-unsafe')
  assert.throws(() => t3.inspect(batchId), (error) => error.code === 'path-unsafe')
  const report = t3.recover()
  assert.deepEqual(report.problems, [{ name: batchId, code: 'path-unsafe' }])
  assert.deepEqual(t3.list().batches, [])
  for (const id of ['sa1', 'sb1']) assert.ok(existsSync(path.join(moved, 'sessions', world3.wsOf.get(id), id)))
})

test('path attacks: a symlinked trashDir or trashDir component, and a trash inside the sessions tree (or the reverse)', async () => {
  const world = makeWorld('attack-trash')
  const realTrash = path.join(world.root, 'real-trash')
  mkdirSync(realTrash, { mode: 0o700 })
  symlinkSync(realTrash, path.join(world.root, 'link-trash'))
  const linked = trashFor(world, { config: resolveConfig({ dataDir: world.dataDir, trashDir: path.join(world.root, 'link-trash') }, {}) })
  for (const call of [() => linked.acquire(), () => linked.createBatch(world.intent), () => linked.list(), () => linked.recover()]) {
    assert.throws(call, (error) => error instanceof PathError && error.code === 'path-unsafe')
  }
  await assert.rejects(linked.validate(), (error) => error.code === 'path-unsafe')

  const realData = path.join(world.root, 'real-data')
  mkdirSync(realData, { mode: 0o700 })
  symlinkSync(realData, path.join(world.root, 'link-data'))
  const ancestor = trashFor(world, { config: resolveConfig({ dataDir: path.join(world.root, 'link-data') }, {}) })
  assert.throws(() => ancestor.acquire(), (error) => error.code === 'path-unsafe')
  assert.throws(() => ancestor.createBatch(world.intent), (error) => error.code === 'path-unsafe')

  const inside = trashFor(world, { config: resolveConfig({ dataDir: world.dataDir, trashDir: path.join(world.store, 'alpha', 'trash') }, {}) })
  assert.throws(() => inside.acquire(), (error) => error.code === 'path-unsafe')
  assert.throws(() => inside.createBatch(world.intent), (error) => error.code === 'path-unsafe')
  await assert.rejects(inside.validate(), (error) => error.code === 'path-unsafe')
  assert.ok(!existsSync(path.join(world.store, 'alpha', 'trash')), 'nothing is created inside the sessions tree')

  const above = trashFor(world, { config: resolveConfig({ dataDir: world.dataDir, trashDir: path.join(world.root, 'store') }, {}) })
  assert.throws(() => above.acquire(), (error) => error.code === 'path-unsafe')
  assert.deepEqual(treeOf(world.store), world.storeTree)
  assertEachOnce(world, 'attack-trash')
})

test('path attacks: ids with separators or "..", bad project folders and mismatched sources are refused with path-unsafe', () => {
  const world = makeWorld('attack-ids')
  const base = world.intent.sessions.find((s) => s.id === 'sb1')
  const bad = [
    { id: 'a/b', workspaceDir: 'beta' },
    { id: '..', workspaceDir: 'beta' },
    { id: '../sb1', workspaceDir: 'beta' },
    { id: 'x..y', workspaceDir: 'beta' },
    { id: 'a\\b', workspaceDir: 'beta' },
    { id: 'okid1', workspaceDir: '..' },
    { id: 'okid2', workspaceDir: 'x/y' },
    { id: 'okid3', workspaceDir: '.hidden' },
    { id: 'okid4', workspaceDir: 'beta', source: path.join(world.root, 'elsewhere', 'okid4') },
  ]
  const sessions = [
    ...world.intent.sessions.filter((s) => s.id !== 'sb1'),
    ...bad.map((entry) => ({ ...base, ...entry, source: entry.source ?? path.join(world.store, entry.workspaceDir, entry.id) })),
  ]
  const units = [world.intent.units[0], ...bad.map((entry) => ({ rootId: entry.id, memberIds: [entry.id] })), world.intent.units[2]]
  const trash = trashFor(world)
  const batch = trash.createBatch({ planId: 'p', units, sessions })
  assert.deepEqual(batch.refused, bad.map((entry) => ({ rootId: entry.id, reasons: [{ code: 'path-unsafe', sessionId: entry.id }] })))
  assert.deepEqual(batch.units.map((unit) => unit.rootId), ['sa1', 'sc1'])
  const manifest = JSON.parse(readFileSync(path.join(batch.dir, 'manifest.json'), 'utf8'))
  assert.deepEqual(manifest.sessions.map((s) => s.id), ['sa1', 'sa2', 'sa3', 'sc1', 'sc2'])
  for (const unit of batch.units) batch.moveUnit(unit, () => null)
  const result = batch.finish()
  assertApplyResult(result)
  assert.equal(result.skipped.length, bad.length)
  assert.equal(result.state, 'partial')
  assert.ok(!existsSync(path.join(world.root, 'elsewhere')))

  // Nothing accepted: no batch at all.
  const none = trash.createBatch({ units: units.slice(1, 3), sessions: sessions.filter((s) => s.id === 'a/b' || s.id === '..') })
  assert.equal(none.batchId, null)
  const empty = none.finish()
  assertApplyResult(empty)
  assert.equal(empty.batchId, null)
  assert.throws(() => trash.restore('../store'), (error) => error.code === 'path-unsafe')

  // Structural mistakes are programming errors.
  assert.throws(() => trash.createBatch({ units: [{ rootId: 'sa1', memberIds: ['sa1'] }], sessions: [] }), TypeError)
  assert.throws(() => trash.createBatch({ units: [world.intent.units[1], world.intent.units[1]], sessions: [base] }), TypeError)
  assert.throws(() => trash.createBatch({ units: [], sessions: [base] }), TypeError)
})

// ---------------------------------------------------------------------------
// 9. The trash mutex
// ---------------------------------------------------------------------------

test('mutex: .lock is created with wx and records pid and start time; a live holder gives busy', () => {
  const world = makeWorld('mutex')
  const holderId = { pid: 111, startedAt: 5, host: HOST }
  const events = []
  const holder = trashFor(world, { events, identity: holderId, isAlive: (pid) => pid === 111 || pid === process.pid })
  const lock = holder.acquire()
  assert.equal(lock.replaced, null)
  const file = path.join(world.trashDir, '.lock')
  const record = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual([record.pid, record.startedAt, record.host], [111, 5, HOST])
  assert.ok(Number.isSafeInteger(record.acquiredAt))
  assert.match(record.token, /^[0-9a-f]{32}$/)
  assert.equal(modeOf(file), 0o600)
  const open = events.find((event) => event.name === 'openSync' && event.paths[0] === file)
  for (const flag of ['O_CREAT', 'O_EXCL', 'O_NOFOLLOW']) assert.ok(open.flags & constants[flag], flag)

  const other = trashFor(world, { isAlive: (pid) => pid === 111 || pid === process.pid })
  const busy = (error) => error instanceof TrashError && error.code === ERROR.busy
  assert.throws(() => other.acquire(), busy)
  assert.throws(() => other.createBatch(world.intent), busy)
  assert.throws(() => other.recover(), busy)
  const config = resolveConfig({ dataDir: world.dataDir }, {})
  assert.throws(() => trashFor(world, { config, isAlive: () => true }).purge('b-20200101T000000Z-00000000'), busy)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), record, 'the live lock is untouched')
  assertEachOnce(world, 'mutex')

  // Re-entrant in its own instance; released at depth zero.
  const inner = holder.acquire()
  inner.release()
  assert.ok(existsSync(file))
  lock.release()
  lock.release()
  assert.ok(!existsSync(file))
  assert.equal(JSON.parse(readFileSync(path.join(world.trashDir, '.lock.released'), 'utf8')).token, record.token)
  const next = other.acquire()
  next.release()

  // Same host, same pid and same start time: another engine in this process holds it.
  const self = trashFor(world)
  const selfLock = self.acquire()
  assert.throws(() => trashFor(world).acquire(), busy)
  selfLock.release()

  // Another host's lock is never judged: busy even when its pid looks dead here.
  writeFileSync(file, JSON.stringify({ v: 1, pid: 4_000_777, startedAt: 1, acquiredAt: 1, host: `${HOST}-elsewhere`, token: 'ab'.repeat(16) }), { mode: 0o600 })
  assert.throws(() => trashFor(world, { isAlive: () => false }).acquire(), busy)
  rmSync(file)
})

test('mutex: a stale lock (dead pid, reused pid, or unreadable past the grace period) is replaced and the replacement journaled', () => {
  const world = makeWorld('stale')
  const file = path.join(world.trashDir, '.lock')
  const journal = path.join(world.trashDir, '.journal.jsonl')
  mkdirSync(world.trashDir, { recursive: true, mode: 0o700 })
  const stale = { v: 1, pid: 4_000_123, startedAt: 3, acquiredAt: 4, host: HOST, token: 'cd'.repeat(16) }
  writeFileSync(file, JSON.stringify(stale), { mode: 0o600 })
  const trash = trashFor(world)
  const lock = trash.acquire()
  assert.deepEqual(lock.replaced, { pid: 4_000_123, startedAt: 3, acquiredAt: 4, host: HOST, reason: 'dead-pid' })
  const mine = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(mine.pid, process.pid)
  const lines = journalLines(journal)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].op, 'lock-replaced')
  assert.deepEqual(lines[0].stale, lock.replaced)
  assert.equal(lines[0].by.pid, process.pid)
  assert.equal(modeOf(journal), 0o600)
  assert.ok(!readdirSync(world.trashDir).some((name) => name.endsWith('.tmp')), 'no temporary lock file is left')
  lock.release()

  // This pid but another start time: the pid was reused after a crash.
  writeFileSync(file, JSON.stringify({ ...stale, pid: process.pid, startedAt: 1 }), { mode: 0o600 })
  const reused = trashFor(world).acquire()
  assert.equal(reused.replaced.reason, 'pid-reused')
  reused.release()

  // An unreadable lock (a crash between create and write) is busy during the grace period, stale after it.
  for (const content of ['', '{"v":1,"pid":', JSON.stringify({ ...stale, pid: 0 }), JSON.stringify({ ...stale, pid: -1 })]) {
    writeFileSync(file, content, { mode: 0o600 })
    assert.throws(() => trashFor(world, { isAlive: () => false }).acquire(), (error) => error.code === ERROR.busy, JSON.stringify(content))
    const later = trashFor(world, { now: () => Date.now() + LOCK_GRACE_MS + 1000, isAlive: () => { throw new Error('never probe an invalid pid') } }).acquire()
    assert.equal(later.replaced.reason, 'unreadable')
    later.release()
  }
  assert.equal(journalLines(journal).length, 6)

  // A symlinked lock file is never followed.
  const target = path.join(world.root, 'lock-target')
  writeFileSync(target, 'not a lock')
  symlinkSync(target, file)
  assert.throws(() => trashFor(world).acquire(), (error) => error instanceof PathError && error.code === 'path-unsafe')
  assert.equal(readFileSync(target, 'utf8'), 'not a lock')
  rmSync(file)
})

test('mutex across processes: a live child holder gives busy; after it dies its lock is replaced and journaled', async () => {
  const world = makeWorld('cross-process')
  const decoy = path.join(TMP, `decoy-home-${++worlds}`)
  mkdirSync(decoy)
  const script = `
    import { createTrash } from ${JSON.stringify(pathToFileURL(SRC_FILE).href)}
    import { resolveConfig } from ${JSON.stringify(pathToFileURL(CONFIG_FILE).href)}
    const [dataDir, store] = process.argv.slice(1)
    const trash = createTrash({ config: resolveConfig({ dataDir }, {}), sessionsRoot: store })
    trash.acquire()
    process.stdout.write('held\\n')
    setInterval(() => {}, 1000)
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, world.dataDir, world.store], {
    env: { PATH: process.env.PATH, HOME: decoy, DSH_HOME: decoy, XDG_STATE_HOME: decoy },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exited = new Promise((resolve) => child.on('exit', resolve))
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('held')) resolve() })
    child.on('exit', (code) => reject(new Error(`child exited ${code}: ${stderr}`)))
  })
  try {
    const record = JSON.parse(readFileSync(path.join(world.trashDir, '.lock'), 'utf8'))
    assert.equal(record.pid, child.pid)
    assert.ok(Math.abs(record.startedAt - Date.now()) < 120_000, 'the start time of the child process')
    const parent = createTrash({ config: world.config, sessionsRoot: world.store })
    assert.throws(() => parent.acquire(), (error) => error.code === ERROR.busy)
    assert.throws(() => parent.createBatch(world.intent), (error) => error.code === ERROR.busy)
  } finally {
    child.kill('SIGKILL')
    await exited
  }
  const parent = createTrash({ config: world.config, sessionsRoot: world.store })
  const lock = parent.acquire()
  assert.equal(lock.replaced.pid, child.pid)
  assert.equal(lock.replaced.reason, 'dead-pid')
  const lines = journalLines(path.join(world.trashDir, '.journal.jsonl'))
  assert.deepEqual(lines.map((line) => [line.op, line.stale.pid]), [['lock-replaced', child.pid]])
  lock.release()
  assert.deepEqual(readdirSync(decoy), [])
  assertEachOnce(world, 'cross-process')
})

test('mutex: a lock taken over between two renames stops the unit and renames its moved members back', () => {
  const world = makeWorld('takeover')
  const trash = trashFor(world)
  const batch = trash.createBatch(world.intent)
  const file = path.join(world.trashDir, '.lock')
  const thief = { v: 1, pid: 999_999, startedAt: 1, acquiredAt: 1, host: HOST, token: 'ef'.repeat(16) }
  assert.throws(() => batch.moveUnit(batch.units[0], (entry) => {
    if (entry.id === 'sa1') writeFileSync(file, JSON.stringify(thief))
    return null
  }), (error) => error.code === ERROR.busy)
  for (const id of ['sa1', 'sa2', 'sa3']) assert.ok(existsSync(storePath(world, id)))
  assert.throws(() => batch.finish(), (error) => error.code === ERROR.busy)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), thief, 'the new holder keeps its lock')
  assertEachOnce(world, 'takeover')
})

// ---------------------------------------------------------------------------
// 10. Read side and validate()
// ---------------------------------------------------------------------------

test('list() and inspect(): DTO-valid rows from a fold of each journal; validate() checks device and overlap', async () => {
  const world = makeWorld('list')
  const trash = trashFor(world)
  assert.deepEqual(trash.list(), { trashDir: world.trashDir, batches: [] })
  const batchId = applyAll(world)
  const list = trash.list()
  assertTrashList(list)
  assert.deepEqual(list.batches, [{
    batchId, createdAt: list.batches[0].createdAt, units: 3, sessions: 6, bytes: world.intent.sessions.reduce((sum, s) => sum + s.bytes, 0), state: 'complete',
  }])
  const detail = trash.inspect(batchId)
  assert.equal(detail.planId, 'plan-test')
  assert.deepEqual(detail.sessions.map((s) => [s.id, s.location]), world.intent.sessions.map((s) => [s.id, 'trash']))
  assert.deepEqual(detail.units.map((unit) => [unit.rootId, unit.location]), [['sa1', 'trash'], ['sb1', 'trash'], ['sc1', 'trash']])
  assert.equal((await trash.validate()).exists, true)

  const events = []
  const otherDevice = trashFor(world, {
    events,
    override: {
      statSync: (p, ...rest) => {
        const stat = nodeFs.statSync(p, ...rest)
        return p === world.store ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: stat.dev + 1 }) : stat
      },
    },
  })
  await assert.rejects(otherDevice.validate(), (error) => error instanceof TrashError && error.code === ERROR.trashUnusable)
  const fresh = makeWorld('validate-missing')
  assert.equal((await trashFor(fresh).validate()).exists, false)
  assert.ok(!existsSync(fresh.trashDir), 'validate() creates nothing')
})
