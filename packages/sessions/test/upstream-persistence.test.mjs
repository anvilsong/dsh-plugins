// Store-safety experiments against the upstream JSONL session persistence
// (docs/store-safety.md). Optional: the suite runs only when DSH_UPSTREAM_DIR
// names a DeepSeek Harness source checkout with its dependencies installed;
// otherwise it reports one skipped test and exits 0.
//
//   export PATH="$HOME/.nvm/versions/node/v24.22.3/bin:$PATH"   # Node >= 24.9
//   DSH_UPSTREAM_DIR=/path/to/deepseek-harness node --test packages/sessions/test/upstream-persistence.test.mjs
//
// The checkout is only read: its TypeScript sources load through its own tsx
// and tsconfig paths. Every store, trash folder, project directory and storage
// root is a fresh fs.mkdtemp under os.tmpdir(). HOME, DSH_HOME and the XDG
// roots point at decoy folders for the whole run, and the last test asserts
// that they stayed empty. Nothing here touches a real profile or session store.
//
// Experiment ids match the tables in docs/store-safety.md:
//   S1-S6  moves under a running backend   L1-L3  session.lock
//   G1-G2  registry ghosts and re-attach   C1     list() cost
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import v8 from 'node:v8'
import vm from 'node:vm'

const UPSTREAM = process.env.DSH_UPSTREAM_DIR?.trim() || undefined

/** Upstream files this suite loads, relative to the checkout. */
const FILES = {
  tsx: 'node_modules/tsx/dist/esm/api/index.mjs',
  tsconfig: 'tsconfig.json',
  cordis: 'vendor/cordis/src/index.ts',
  jsonl: 'packages/session/session-persistence-jsonl/src/index.ts',
  storage: 'packages/storage/storage/src/index.ts',
  storageJson: 'packages/storage/storage-json/src/index.ts',
  storageDomain: 'packages/storage/storage-domain/src/index.ts',
  workspace: 'packages/workspace/workspace/src/index.ts',
}

function skipReason() {
  if (UPSTREAM === undefined) return 'DSH_UPSTREAM_DIR is not set (optional upstream experiments)'
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 24 || (major === 24 && minor < 9)) {
    return `the upstream checkout needs Node >= 24.9 (this is ${process.versions.node})`
  }
  for (const relative of Object.values(FILES)) {
    if (!fs.existsSync(path.join(UPSTREAM, relative))) return `DSH_UPSTREAM_DIR lacks ${relative}`
  }
  return undefined
}

const SKIP = skipReason()

if (SKIP !== undefined) {
  test('upstream JSONL persistence experiments (S1-S6, L1-L3, G1-G2, C1)', { skip: SKIP }, () => {})
} else {
  describe('upstream JSONL persistence store safety', () => {
    /** Every temp folder this run created; removed in after(). */
    const created = []
    const decoys = {}
    const savedEnv = {}
    const disposers = []
    let up

    /** A fresh folder under os.tmpdir(), canonical (macOS /var -> /private/var). */
    const fresh = (label) => {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `sessions-spike-${label}-`)))
      created.push(dir)
      return dir
    }

    before(async () => {
      for (const key of ['HOME', 'DSH_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
        savedEnv[key] = process.env[key]
        decoys[key] = fresh(`decoy-${key.toLowerCase()}`)
        process.env[key] = decoys[key]
      }
      const load = relative => import(pathToFileURL(path.join(UPSTREAM, relative)).href)
      const { register } = await load(FILES.tsx)
      register({ tsconfig: path.join(UPSTREAM, FILES.tsconfig) })
      up = {
        Context: (await load(FILES.cordis)).Context,
        Jsonl: await load(FILES.jsonl),
        Storage: (await load(FILES.storage)).default,
        StorageJson: await load(FILES.storageJson),
        StorageDomain: await load(FILES.storageDomain),
        Workspace: await load(FILES.workspace),
      }
    })

    after(async () => {
      for (const dispose of disposers.splice(0).reverse()) await dispose().catch(() => {})
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      for (const dir of created) fs.rmSync(dir, { recursive: true, force: true })
    })

    // --- helpers -----------------------------------------------------------

    async function mountBackend(root, config = {}) {
      const ctx = new up.Context()
      await ctx.plugin(up.Jsonl, { root, compression: 'zstd', ...config })
      const dispose = () => ctx.fiber.dispose()
      disposers.push(dispose)
      return { ctx, P: ctx.sessionPersistence, dispose }
    }

    /** Boot the host's own registry composition (storage-json, domain, JSONL, workspace). */
    async function bootRegistry(base) {
      const ctx = new up.Context()
      await ctx.plugin(up.Storage)
      await ctx.plugin(up.StorageJson, { root: path.join(base, 'storages') })
      await ctx.plugin(up.StorageDomain, { backend: 'json' })
      await ctx.plugin(up.Jsonl, { root: path.join(base, 'sessions'), compression: 'zstd' })
      await ctx.plugin(up.Workspace.default)
      const dispose = () => ctx.fiber.dispose()
      disposers.push(dispose)
      return { ctx, P: ctx.sessionPersistence, R: ctx.workspaceRegistry, dispose }
    }

    const message = (id, role, text) => ({
      id, role, content: [{ type: 'text', text }],
      source: role === 'user' ? { kind: 'user' } : { kind: 'model', provider: 'mock', model: 'mock' },
    })

    /** One complete turn (6 events) starting at `base`; `text` sizes the user message. */
    function turn(base, text = 'hi') {
      const n = base / 6 + 1
      return [
        { type: 'turn/start', seq: base, time: base + 1, data: { turn: n } },
        { type: 'user/message', seq: base + 1, time: base + 2, data: message(`u-${base}`, 'user', text), surfaceOp: 'append' },
        { type: 'step/start', seq: base + 2, time: base + 3, data: { turn: n, step: 1 } },
        { type: 'assistant/message', seq: base + 3, time: base + 4, surfaceOp: 'append', data: {
          turn: n, step: 1, message: message(`a-${base}`, 'assistant', 'hello'),
          stream: [
            { type: 'chunk', time: base + 3, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
            { type: 'text-chunks', time0: base + 3, index: 0, dt: [], texts: ['hello'] },
            { type: 'chunk', time: base + 4, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } } },
            { type: 'chunk', time: base + 4, chunk: { type: 'finish', reason: { kind: 'stop' } } },
          ],
        } },
        { type: 'step/end', seq: base + 4, time: base + 5, data: { turn: n, step: 1 } },
        { type: 'turn/end', seq: base + 5, time: base + 6, data: { turn: n, reason: { kind: 'completed' } } },
      ]
    }

    /** Store one closed (cold) session through the backend; returns its header. */
    async function seed(P, { cwd, id = `session-${randomUUID()}`, turns = 1, createdAt = Date.now(), text, ...lineage } = {}) {
      const header = { version: 4, id, createdAt, isSeeded: false, ...(cwd === undefined ? {} : { cwd }), ...lineage }
      const handle = await P.create(header)
      for (let index = 0; index < turns; index += 1) await handle.append(turn(index * 6, text))
      await handle.close()
      return header
    }

    async function snapshotOf(P, id) {
      return (await P.list()).find(snapshot => snapshot.header.id === id)
    }

    /** Session folder of a listed snapshot: <root>/<project>/<encoded id>/. */
    const folderOf = snapshot => path.dirname(snapshot.location.path)

    /** Rename-only move, the plugin's only allowed transfer. */
    function move(from, to) {
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 })
      fs.renameSync(from, to)
    }

    const trashPath = (root, trash, folder) => path.join(trash, path.relative(root, folder))

    async function eventCount(P, id) {
      const handle = await P.open(id, 'read')
      try {
        return (await handle.read()).events.length
      } finally {
        await handle.close()
      }
    }

    const outcome = promise => promise.then(
      value => ({ ok: true, value }),
      error => ({ ok: false, name: error?.name, code: error?.code, message: String(error?.message ?? error) }),
    )

    const O_EXLOCK = 0x20 // darwin <fcntl.h>; flock(2) semantics taken at open(2)

    /**
     * Non-blocking exclusive flock probe of a session.lock without native code
     * (darwin only). Opens read-only, so the file is never created or truncated.
     * @returns 'free', 'held', 'absent' or 'unsupported'.
     */
    function probeLock(lockPath, { hold = false } = {}) {
      if (process.platform !== 'darwin') return { state: 'unsupported' }
      try {
        const fd = fs.openSync(lockPath, fs.constants.O_RDONLY | O_EXLOCK | fs.constants.O_NONBLOCK)
        if (hold) return { state: 'free', fd }
        fs.closeSync(fd)
        return { state: 'free' }
      } catch (error) {
        if (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK') return { state: 'held' }
        if (error.code === 'ENOENT') return { state: 'absent' }
        throw error
      }
    }

    /**
     * Count the bytes the backend reads while `run` executes: header reads go
     * through FileHandle.read, whole-log reads through fs.promises.readFile
     * (the backend's named import follows syncBuiltinESMExports).
     */
    async function withReadCounters(run) {
      const handle = await fs.promises.open(os.tmpdir(), 'r')
      const FileHandleProto = Object.getPrototypeOf(handle)
      await handle.close()
      const originalRead = FileHandleProto.read
      const originalReadFile = fs.promises.readFile
      const tally = { handleBytes: 0, handleCalls: 0, readFileBytes: 0, readFileCalls: 0 }
      const reset = () => Object.assign(tally, { handleBytes: 0, handleCalls: 0, readFileBytes: 0, readFileCalls: 0 })
      FileHandleProto.read = async function countedRead(...args) {
        const result = await originalRead.apply(this, args)
        tally.handleCalls += 1
        tally.handleBytes += result.bytesRead
        return result
      }
      fs.promises.readFile = async function countedReadFile(...args) {
        const result = await originalReadFile.apply(this, args)
        tally.readFileCalls += 1
        tally.readFileBytes += result.length
        return result
      }
      syncBuiltinESMExports()
      try {
        return await run(tally, reset)
      } finally {
        FileHandleProto.read = originalRead
        fs.promises.readFile = originalReadFile
        syncBuiltinESMExports()
      }
    }

    const gc = (() => {
      v8.setFlagsFromString('--expose-gc')
      return vm.runInNewContext('gc')
    })()

    // --- S: moves under a running backend ------------------------------------

    test('S1 cold session moved: list() and stat() drop it, open() reports not found', async (t) => {
      const root = fresh('s1-store')
      const trash = fresh('s1-trash')
      const cwd = fresh('s1-cwd')
      assert.equal(fs.statSync(root).dev, fs.statSync(trash).dev, 'trash must share the store device')
      const { P } = await mountBackend(root)
      const a = await seed(P, { cwd })
      const b = await seed(P, { cwd })
      const snapA = await snapshotOf(P, a.id)
      assert.ok(snapA, 'seeded session is listed (primes the listing header cache)')
      move(folderOf(snapA), trashPath(root, trash, folderOf(snapA)))

      const ids = (await P.list()).map(snapshot => snapshot.header.id)
      const stat = await P.stat(a.id)
      const open = await outcome(P.open(a.id, 'read'))
      const other = await P.stat(b.id)
      const second = await mountBackend(root)
      const secondIds = (await second.P.list()).map(snapshot => snapshot.header.id)
      t.diagnostic(JSON.stringify({ S1: { listed: ids.includes(a.id), stat: stat ?? null, open, siblingStat: other !== undefined } }))
      assert.ok(!ids.includes(a.id) && ids.includes(b.id))
      assert.equal(stat, undefined)
      assert.equal(open.name, 'SessionPersistenceNotFoundError')
      assert.ok(other)
      assert.ok(!secondIds.includes(a.id), 'a second backend instance agrees')
    })

    test('S2 session held in the cold-log memo moved: no stale serve, new and open read handles fail', async (t) => {
      const root = fresh('s2-store')
      const trash = fresh('s2-trash')
      const cwd = fresh('s2-cwd')
      const { P } = await mountBackend(root)
      const a = await seed(P, { cwd, turns: 2 })
      const folder = folderOf(await snapshotOf(P, a.id))
      const reader = await P.open(a.id, 'read')
      const first = (await reader.read()).events.length // decoded and memoized
      assert.equal(first, 12)
      move(folder, trashPath(root, trash, folder))

      const reopen = await outcome(P.open(a.id, 'read'))
      const reread = await outcome(reader.read())
      await reader.close()
      move(trashPath(root, trash, folder), folder)
      // Back at the same path with the same revision: the memo answers without a body read.
      const { back, bodyReads } = await withReadCounters(async (tally) => {
        const count = await eventCount(P, a.id)
        return { back: count, bodyReads: tally.readFileCalls }
      })
      t.diagnostic(JSON.stringify({ S2: { before: first, reopenAfterMove: reopen, openHandleReadAfterMove: reread, afterMoveBack: back, bodyReadsAfterMoveBack: bodyReads } }))
      assert.equal(reopen.name, 'SessionPersistenceNotFoundError')
      assert.equal(reread.name, 'SessionPersistenceNotFoundError')
      assert.equal(back, 12)
      assert.equal(bodyReads, 0, 'the memo still held the decoded log; it is keyed by id and file revision')
    })

    test('S3 open write handle moved: append fails ENOENT, flush stays silent, nothing is recreated', async (t) => {
      const root = fresh('s3-store')
      const trash = fresh('s3-trash')
      const cwd = fresh('s3-cwd')
      const { P } = await mountBackend(root)
      const a = await seed(P, { cwd })
      const folder = folderOf(await snapshotOf(P, a.id))
      const moved = trashPath(root, trash, folder)
      const writer = await P.open(a.id, 'write')
      move(folder, moved)
      const logName = fs.readdirSync(moved).find(name => name.startsWith('session.v'))
      const sizeBefore = fs.statSync(path.join(moved, logName)).size

      const lockTravels = probeLock(path.join(moved, 'session.lock')).state
      const append = await outcome(writer.append(turn(6)))
      const handleFlush = await outcome(writer.flush())
      const serviceFlush = await outcome(P.flush())
      const close = await outcome(writer.close())
      const recreated = fs.existsSync(folder)
      const sizeAfter = fs.statSync(path.join(moved, logName)).size
      move(moved, folder)
      const back = await eventCount(P, a.id)
      t.diagnostic(JSON.stringify({ S3: { lockAtTrashPathWhileWriterOpen: lockTravels, append, handleFlush: handleFlush.ok, serviceFlush: serviceFlush.ok, close: close.ok, oldFolderRecreated: recreated, sizeBefore, sizeAfter, eventsAfterMoveBack: back } }))
      assert.equal(append.code, 'ENOENT')
      assert.ok(handleFlush.ok && serviceFlush.ok, 'flush gives no signal that the log moved')
      assert.ok(close.ok)
      assert.equal(recreated, false)
      assert.equal(sizeAfter, sizeBefore)
      assert.equal(back, 6, 'the failed append never reached either path')
      if (process.platform === 'darwin') assert.equal(lockTravels, 'held')
    })

    test('S4 / L1-L3 session.lock: empty, never removed, liveness only by a non-blocking flock', async (t) => {
      const root = fresh('s4-store')
      const trash = fresh('s4-trash')
      const cwd = fresh('s4-cwd')
      const hostA = await mountBackend(root)
      const hostB = await mountBackend(root) // a second host process sharing the store
      const a = await seed(hostA.P, { cwd })
      const folder = folderOf(await snapshotOf(hostA.P, a.id))
      const lock = path.join(folder, 'session.lock')

      // L1 stale: present after a closed writer, 0 bytes, no pid, not held.
      const stale = { exists: fs.existsSync(lock), bytes: fs.statSync(lock).size, probe: probeLock(lock).state }
      const bWrite = await outcome(hostB.P.open(a.id, 'write'))
      if (bWrite.ok) await bWrite.value.close()

      // L2 held by host A's write handle.
      const writer = await hostA.P.open(a.id, 'write')
      const held = {
        bytes: fs.statSync(lock).size,
        probe: probeLock(lock).state,
        hostBWrite: await outcome(hostB.P.open(a.id, 'write')),
        hostBRead: await outcome(hostB.P.open(a.id, 'read').then(handle => handle.close())),
      }
      await writer.close()
      const released = { exists: fs.existsSync(lock), probe: probeLock(lock).state }

      // L3 the plugin holds the flock across the rename: writers are excluded meanwhile.
      const probe = probeLock(lock, { hold: true })
      let duringHold = { skipped: 'flock probe unsupported on this platform' }
      if (probe.fd !== undefined) {
        duringHold = {
          hostAWrite: await outcome(hostA.P.open(a.id, 'write')),
          hostBWrite: await outcome(hostB.P.open(a.id, 'write')),
        }
        move(folder, trashPath(root, trash, folder))
        duringHold.afterRenameHostBWrite = await outcome(hostB.P.open(a.id, 'write'))
        fs.closeSync(probe.fd)
        move(trashPath(root, trash, folder), folder)
      }

      // Leftover of the open(write)/rename race: lease acquire mkdirs the old folder.
      const leftoverRoot = fresh('s4-leftover')
      const leftoverFolder = path.join(leftoverRoot, path.relative(root, folder))
      fs.mkdirSync(leftoverFolder, { recursive: true })
      fs.writeFileSync(path.join(leftoverFolder, 'session.lock'), '')
      const leftoverHost = await mountBackend(leftoverRoot)
      const leftover = { listed: (await leftoverHost.P.list()).length, stat: (await leftoverHost.P.stat(a.id)) ?? null }

      t.diagnostic(JSON.stringify({ L1: stale, hostBWriteWhenStale: bWrite.ok, L2: held, released, L3: duringHold, lockOnlyFolder: leftover }))
      assert.deepEqual([stale.exists, stale.bytes], [true, 0])
      assert.ok(bWrite.ok, 'a stale lock file never blocks another host')
      assert.equal(held.bytes, 0, 'the lock file never records a pid or expiry')
      assert.equal(held.hostBWrite.name, 'SessionAlreadyOwnedError')
      assert.ok(held.hostBRead.ok, 'readers never touch the lock')
      assert.equal(released.exists, true, 'release never removes the lock file')
      assert.deepEqual(leftover, { listed: 0, stat: null })
      if (process.platform === 'darwin') {
        assert.equal(stale.probe, 'free')
        assert.equal(held.probe, 'held')
        assert.equal(released.probe, 'free')
        assert.equal(duringHold.hostAWrite.name, 'SessionAlreadyOwnedError')
        assert.equal(duringHold.hostBWrite.name, 'SessionAlreadyOwnedError')
        assert.equal(duringHold.afterRenameHostBWrite.name, 'SessionPersistenceNotFoundError')
      }
    })

    test('S5 move back to the exact folder: same revision, size and event count; misplacement breaks list()', async (t) => {
      const root = fresh('s5-store')
      const trash = fresh('s5-trash')
      const cwd = fresh('s5-cwd')
      const { P } = await mountBackend(root)
      const a = await seed(P, { cwd, turns: 2 })
      await seed(P, { cwd })
      const before = await snapshotOf(P, a.id)
      const eventsBefore = await eventCount(P, a.id)
      const folder = folderOf(before)
      move(folder, trashPath(root, trash, folder))
      const absent = (await snapshotOf(P, a.id)) === undefined
      move(trashPath(root, trash, folder), folder)
      const afterBack = await snapshotOf(P, a.id)
      const fresher = await mountBackend(root)
      const afterBackOtherInstance = await snapshotOf(fresher.P, a.id)
      const eventsAfter = await eventCount(P, a.id)
      const writer = await P.open(a.id, 'write')
      await writer.append(turn(12))
      await writer.close()
      const afterWrite = await snapshotOf(P, a.id)

      // Misplacement: the same folder under another project directory.
      const elsewhere = path.join(root, '--elsewhere--', path.basename(folder))
      move(folder, elsewhere)
      const misplacedList = await outcome(P.list())
      const misplacedStat = await outcome(P.stat(a.id))
      move(elsewhere, folder)
      const repaired = await outcome(P.list())

      // rename(2) silently replaces an existing empty directory.
      const scratch = fresh('s5-rename')
      fs.mkdirSync(path.join(scratch, 'src'))
      fs.writeFileSync(path.join(scratch, 'src', 'log'), 'x')
      fs.mkdirSync(path.join(scratch, 'empty-dst'))
      const ontoEmpty = await outcome(fs.promises.rename(path.join(scratch, 'src'), path.join(scratch, 'empty-dst')))
      fs.mkdirSync(path.join(scratch, 'busy-dst'))
      fs.writeFileSync(path.join(scratch, 'busy-dst', 'session.lock'), '')
      const ontoBusy = await outcome(fs.promises.rename(path.join(scratch, 'empty-dst'), path.join(scratch, 'busy-dst')))

      t.diagnostic(JSON.stringify({ S5: {
        revisionBefore: before.revision, revisionAfterMoveBack: afterBack.revision,
        sameRevision: before.revision === afterBack.revision,
        sameRevisionOtherInstance: before.revision === afterBackOtherInstance.revision,
        sizeBefore: before.sizeBytes, sizeAfter: afterBack.sizeBytes, eventsBefore, eventsAfter, absentWhileMoved: absent,
        revisionChangesOnAppend: afterWrite.revision !== afterBack.revision,
        misplacedList, misplacedStat, listAfterRepair: repaired.ok, renameOntoEmptyDir: ontoEmpty, renameOntoNonEmptyDir: ontoBusy,
      } }))
      assert.ok(absent)
      assert.equal(afterBack.revision, before.revision)
      assert.equal(afterBackOtherInstance.revision, before.revision)
      assert.equal(afterBack.sizeBytes, before.sizeBytes)
      assert.equal(afterBack.location.path, before.location.path)
      assert.equal(eventsAfter, eventsBefore)
      assert.notEqual(afterWrite.revision, afterBack.revision)
      assert.equal(misplacedList.ok, false, 'one misplaced folder rejects the whole listing')
      assert.match(misplacedList.message, /header id .* and cwd identify/)
      assert.equal(misplacedStat.ok, false)
      assert.ok(repaired.ok)
      assert.ok(ontoEmpty.ok, 'rename onto an empty directory overwrites it: check the destination first')
      assert.ok(['ENOTEMPTY', 'EEXIST'].includes(ontoBusy.code))
    })

    test('S6 list() concurrent with session-folder moves; a vanishing project directory rejects it', async (t) => {
      const root = fresh('s6-store')
      const trash = fresh('s6-trash')
      const cwds = [fresh('s6-cwd-a'), fresh('s6-cwd-b'), fresh('s6-cwd-c')]
      const { P } = await mountBackend(root)
      const headers = []
      for (let index = 0; index < 60; index += 1) headers.push(await seed(P, { cwd: cwds[index % 3] }))
      const snapshots = new Map((await P.list()).map(snapshot => [snapshot.header.id, snapshot]))
      const listings = []
      for (const header of headers.slice(0, 30)) {
        listings.push(outcome(P.list()))
        await nextTurn()
        const folder = folderOf(snapshots.get(header.id))
        move(folder, trashPath(root, trash, folder))
      }
      const results = await Promise.all(listings)
      const final = await P.list()
      const sizes = results.map(result => (result.ok ? result.value.length : result.name))

      // Deterministic project-directory removal between the root and project reads.
      const fsPromises = fs.promises
      const originalReaddir = fsPromises.readdir
      const victim = path.dirname(folderOf(snapshots.get(headers[59].id)))
      const parked = path.join(trash, 'parked-project')
      let fired = false
      fsPromises.readdir = async function patched(target, ...rest) {
        const entries = await originalReaddir.call(this, target, ...rest)
        if (!fired && path.resolve(String(target)) === root) {
          fired = true
          fs.renameSync(victim, parked)
        }
        return entries
      }
      syncBuiltinESMExports()
      let vanished
      try {
        vanished = await outcome(P.list())
      } finally {
        fsPromises.readdir = originalReaddir
        syncBuiltinESMExports()
        if (fired) fs.renameSync(parked, victim)
      }
      const recovered = await outcome(P.list())
      t.diagnostic(JSON.stringify({ S6: { concurrentListings: results.length, rejected: results.filter(r => !r.ok).length, sizes, finalCount: final.length, projectVanishedMidList: { hookFired: fired, ...vanished, value: undefined }, recovered: recovered.ok } }))
      assert.ok(results.every(result => result.ok), 'moving session folders never rejects a concurrent list()')
      assert.ok(results.every(result => result.value.length >= 30 && result.value.length <= 60))
      assert.equal(final.length, 30)
      assert.ok(fired)
      assert.equal(vanished.ok, false)
      assert.equal(vanished.code, 'ENOENT')
      assert.ok(recovered.ok)
    })

    // --- G: registry ghosts and the official re-attach ------------------------

    /** Durable workspace records as the storage-json backend wrote them. */
    function durableWorkspace(base) {
      const document = JSON.parse(fs.readFileSync(path.join(base, 'storages', 'workspace.json'), 'utf8'))
      const records = Object.values(document.tables.workspaces)
      return { sessionIds: records[0].sessionIds, archived: document.global.archivedSessionIds, pinned: document.global.pinnedSessionIds }
    }

    async function seedTree(base) {
      const cwd = path.join(base, 'project') // base is canonical already
      fs.mkdirSync(cwd)
      const seeder = await mountBackend(path.join(base, 'sessions'))
      const K = await seed(seeder.P, { cwd, id: 'session-kept', createdAt: 4000 })
      const C = await seed(seeder.P, { cwd, id: 'session-child', createdAt: 3000, parentSession: 'session-archived', origin: 'subagent', delegationDepth: 1 })
      const A = await seed(seeder.P, { cwd, id: 'session-archived', createdAt: 2000 })
      const N = await seed(seeder.P, { cwd, id: 'session-pinned', createdAt: 1000 })
      await seeder.dispose()
      return { cwd, K: K.id, C: C.id, A: A.id, N: N.id }
    }

    async function folders(P, ids) {
      const byId = new Map((await P.list()).map(snapshot => [snapshot.header.id, folderOf(snapshot)]))
      return ids.map(id => byId.get(id))
    }

    test('G1 registry untouched while logs are in trash (at-purge): ghosts, host prune, lost membership', async (t) => {
      const base = fresh('g1')
      const trash = fresh('g1-trash')
      const root = path.join(base, 'sessions')
      const ids = await seedTree(base)
      const { K, C, A, N } = ids
      const steps = {}

      let host = await bootRegistry(base)
      let workspace = host.R.list()[0]
      steps.g1_bootstrap = { sessionIds: [...workspace.sessionIds] }
      await host.R.archiveSession(A)
      await host.R.pinSession(N)
      const original = [...workspace.sessionIds]
      const moved = await folders(host.P, [A, C, N])
      for (const folder of moved) move(folder, trashPath(root, trash, folder))
      steps.g2_sameRunAfterMove = {
        sessionIds: [...workspace.sessionIds], archived: [...host.R.archivedSessionIds], pinned: [...host.R.pinnedSessionIds],
        listed: (await host.P.list()).map(snapshot => snapshot.header.id),
      }
      await host.dispose()

      host = await bootRegistry(base)
      workspace = host.R.list()[0]
      steps.g3_afterRestart = {
        sessionIds: [...workspace.sessionIds], archived: [...host.R.archivedSessionIds], pinned: [...host.R.pinnedSessionIds],
        durable: durableWorkspace(base),
        archiveGhost: await outcome(host.R.archiveSession(N)),
        pinGhost: await outcome(host.R.pinSession(C)),
        unarchiveUnknown: await outcome(host.R.unarchiveSession('session-never-existed')),
        unpinUnknown: await outcome(host.R.unpinSession('session-never-existed')),
      }
      await workspace.setTitle('any mutation')
      steps.g4_afterMutation = {
        durable: durableWorkspace(base),
        attachGhostAfterPrune: await outcome(workspace.attachSession(A)),
      }
      for (const folder of moved) move(trashPath(root, trash, folder), folder)
      steps.g5_afterMoveBack = {
        sessionIds: [...workspace.sessionIds], listed: (await host.P.list()).length,
        archived: [...host.R.archivedSessionIds], pinned: [...host.R.pinnedSessionIds],
      }
      t.diagnostic(JSON.stringify({ G1: steps }))

      assert.deepEqual(steps.g1_bootstrap.sessionIds, [K, C, A, N], 'bootstrap accounts every stored header by cwd, subagent children included')
      assert.deepEqual(steps.g2_sameRunAfterMove.sessionIds, original, 'same run: the header cache keeps moved ids as members')
      assert.deepEqual(steps.g2_sameRunAfterMove.listed, [K])
      assert.deepEqual(steps.g3_afterRestart.sessionIds, [K], 'restart filters members whose header is missing')
      assert.deepEqual(steps.g3_afterRestart.archived, [A], 'the archive set is never pruned')
      assert.deepEqual(steps.g3_afterRestart.pinned, [N], 'the pin set is never pruned')
      assert.deepEqual(steps.g3_afterRestart.durable.sessionIds, [K, C, A, N], 'filtering alone does not write')
      assert.equal(steps.g3_afterRestart.archiveGhost.name, 'WorkspaceUnknownSessionError')
      assert.equal(steps.g3_afterRestart.pinGhost.name, 'WorkspaceUnknownSessionError')
      assert.ok(steps.g3_afterRestart.unarchiveUnknown.ok && steps.g3_afterRestart.unpinUnknown.ok)
      assert.deepEqual(steps.g4_afterMutation.durable.sessionIds, [K], 'the next mutation of that workspace prunes the ghosts durably')
      assert.match(steps.g4_afterMutation.attachGhostAfterPrune.message, /session persistence holds no such session/)
      assert.deepEqual(steps.g5_afterMoveBack.sessionIds, [K], 'a pure move back does not regain membership')
      assert.equal(steps.g5_afterMoveBack.listed, 4)
    })

    test('G1b attach of a ghost still on the durable account resolves without attaching', async (t) => {
      const base = fresh('g1b')
      const trash = fresh('g1b-trash')
      const root = path.join(base, 'sessions')
      const { K, C, A, N } = await seedTree(base)
      let host = await bootRegistry(base)
      const moved = await folders(host.P, [A])
      for (const folder of moved) move(folder, trashPath(root, trash, folder))
      await host.dispose()
      host = await bootRegistry(base)
      const workspace = host.R.list()[0]
      const before = { sessionIds: [...workspace.sessionIds], durable: durableWorkspace(base).sessionIds }
      const attach = await outcome(workspace.attachSession(A))
      const afterAttach = { sessionIds: [...workspace.sessionIds], durable: durableWorkspace(base).sessionIds }
      for (const folder of moved) move(trashPath(root, trash, folder), folder)
      const afterMoveBack = { listed: Boolean(await host.P.stat(A)), sessionIds: [...workspace.sessionIds] }
      const reattach = await outcome(workspace.attachSession(A))
      const afterReattach = [...workspace.sessionIds]
      t.diagnostic(JSON.stringify({ G1b: { before, attach, afterAttach, afterMoveBack, reattach, afterReattach } }))
      assert.deepEqual(before, { sessionIds: [K, C, N], durable: [K, C, A, N] })
      assert.ok(attach.ok, 'attach resolves: the raw account already holds the id, so validation is skipped')
      assert.deepEqual(afterAttach, { sessionIds: [K, C, N], durable: [K, C, N] }, '…and its mutation prunes the id instead')
      assert.deepEqual(afterMoveBack, { listed: true, sessionIds: [K, C, N] })
      assert.ok(reattach.ok)
      assert.deepEqual(afterReattach, [A, K, C, N], 'attach prepends; insertSessionBefore restores the recorded slot')
    })

    test('G2 at-prune cycle with the official calls: unpin, detach, unarchive; restore by attach, reorder, archive, pin', async (t) => {
      const base = fresh('g2')
      const trash = fresh('g2-trash')
      const root = path.join(base, 'sessions')
      const { K, C, A, N } = await seedTree(base)
      const steps = {}

      let host = await bootRegistry(base)
      let workspace = host.R.list()[0]
      await host.R.archiveSession(A)
      await host.R.pinSession(N)
      const original = { sessionIds: [...workspace.sessionIds], archived: [...host.R.archivedSessionIds], pinned: [...host.R.pinnedSessionIds] }

      // Manifest facts recorded before the move: membership order, archive and pin sets.
      const unit = [A, C]
      const manifest = unit.map(id => ({
        id,
        member: original.sessionIds.includes(id),
        archived: original.archived.includes(id),
        pinned: original.pinned.includes(id),
      }))
      const moved = await folders(host.P, unit)
      for (const folder of moved) move(folder, trashPath(root, trash, folder))
      for (const entry of manifest) if (entry.pinned) await host.R.unpinSession(entry.id)
      for (const entry of manifest) await workspace.detachSession(entry.id)
      for (const entry of manifest) if (entry.archived) await host.R.unarchiveSession(entry.id)
      steps.pruned = { sessionIds: [...workspace.sessionIds], archived: [...host.R.archivedSessionIds], durable: durableWorkspace(base) }
      // Same run: the registry's header cache still validates the moved id, so
      // attach succeeds although its log is in trash (undone right away).
      steps.sameRunAttachWithoutLog = await outcome(workspace.attachSession(A))
      await workspace.detachSession(A)
      await host.dispose()

      host = await bootRegistry(base)
      workspace = host.R.list()[0]
      steps.prunedAfterRestart = { sessionIds: [...workspace.sessionIds], archived: [...host.R.archivedSessionIds] }
      steps.attachBeforeMoveBack = await outcome(workspace.attachSession(A))

      // Restore: move back, verify, attach, restore order, archive, pin.
      for (const folder of moved) move(trashPath(root, trash, folder), folder)
      for (const entry of manifest) assert.ok(await host.P.stat(entry.id), `${entry.id} is back in the store`)
      for (const entry of [...manifest].reverse()) {
        if (!entry.member) continue
        await workspace.attachSession(entry.id)
        const index = original.sessionIds.indexOf(entry.id)
        const anchor = original.sessionIds.slice(index + 1).find(id => workspace.sessionIds.includes(id))
        await workspace.insertSessionBefore(entry.id, anchor)
      }
      for (const entry of manifest) if (entry.archived) await host.R.archiveSession(entry.id)
      for (const entry of manifest) if (entry.pinned && !entry.archived) await host.R.pinSession(entry.id)
      steps.restored = { sessionIds: [...workspace.sessionIds], archived: [...host.R.archivedSessionIds], pinned: [...host.R.pinnedSessionIds] }
      steps.pinArchived = await outcome(host.R.pinSession(A))
      await host.dispose()

      host = await bootRegistry(base)
      workspace = host.R.list()[0]
      steps.restoredAfterRestart = { sessionIds: [...workspace.sessionIds], archived: [...host.R.archivedSessionIds], pinned: [...host.R.pinnedSessionIds], durable: durableWorkspace(base) }
      t.diagnostic(JSON.stringify({ G2: { original, ...steps } }))

      assert.deepEqual(steps.pruned.sessionIds, [K, N])
      assert.deepEqual(steps.pruned.archived, [])
      assert.deepEqual(steps.pruned.durable.sessionIds, [K, N])
      assert.ok(steps.sameRunAttachWithoutLog.ok, 'same run: attach does not prove the log exists')
      assert.deepEqual(steps.prunedAfterRestart, { sessionIds: [K, N], archived: [] })
      assert.match(steps.attachBeforeMoveBack.message, /session persistence holds no such session/, 'after a restart attach refuses an absent log')
      assert.deepEqual(steps.restored, original)
      assert.equal(steps.pinArchived.name, 'WorkspaceArchivedSessionPinError')
      assert.deepEqual(steps.restoredAfterRestart.sessionIds, original.sessionIds)
      assert.deepEqual(steps.restoredAfterRestart.archived, original.archived)
      assert.deepEqual(steps.restoredAfterRestart.pinned, original.pinned)
      assert.deepEqual(steps.restoredAfterRestart.durable.sessionIds, original.sessionIds)
    })

    // --- C: list() cost -----------------------------------------------------

    test('C1 list() cost (400 sessions by default): header-only reads, cold and warm', async (t) => {
      const root = fresh('c1-store')
      const cwds = Array.from({ length: 8 }, (_, index) => fresh(`c1-cwd-${index}`))
      const count = Number(process.env.SPIKE_SESSIONS ?? 400)
      const payload = Number(process.env.SPIKE_PAYLOAD_BYTES ?? 32 * 1024)
      const seeder = await mountBackend(root)
      const seedStart = performance.now()
      for (let index = 0; index < count; index += 1) {
        // Incompressible text so on-disk size tracks the payload.
        await seed(seeder.P, { cwd: cwds[index % cwds.length], turns: 2, text: randomBytes(payload / 2).toString('base64') })
      }
      const seedMs = performance.now() - seedStart
      await seeder.dispose()
      let storeBytes = 0
      for (const project of fs.readdirSync(root)) {
        for (const session of fs.readdirSync(path.join(root, project))) {
          for (const file of fs.readdirSync(path.join(root, project, session))) storeBytes += fs.statSync(path.join(root, project, session, file)).size
        }
      }

      const { cold, warm, control } = await withReadCounters(async (tally, reset) => {
        // A fresh backend instance: its listing header cache starts empty.
        const { P } = await mountBackend(root)
        const measure = async () => {
          reset()
          gc()
          const heapBefore = process.memoryUsage().heapUsed
          const start = performance.now()
          const listed = await P.list()
          const ms = performance.now() - start
          const heapAfter = process.memoryUsage().heapUsed // includes garbage: no gc yet
          gc()
          const heapRetained = process.memoryUsage().heapUsed
          return {
            listed: listed.length, ms: Math.round(ms), heapDeltaBytes: heapAfter - heapBefore,
            heapRetainedBytes: heapRetained - heapBefore, ...tally,
          }
        }
        const first = await measure()
        const second = await measure()
        const id = (await P.list())[0].header.id
        reset()
        await eventCount(P, id)
        return { cold: first, warm: second, control: { ...tally } }
      })
      const result = { sessions: count, payloadBytes: payload, storeBytes, seedMs: Math.round(seedMs), cold, warm, controlOneOpen: control }
      t.diagnostic(JSON.stringify({ C1: result }))
      assert.equal(cold.listed, count)
      assert.equal(cold.readFileCalls, 0, 'list() never reads a whole log')
      assert.ok(cold.handleBytes < storeBytes / 4, 'list() reads only header frames')
      assert.equal(warm.handleCalls, 0, 'an unchanged store is listed from the header cache (stat only)')
      assert.ok(control.readFileCalls >= 1, 'the counters see a body read (control)')
    })

    // --- decoys ---------------------------------------------------------------

    test('decoy HOME, DSH_HOME and XDG roots stayed empty', () => {
      for (const [key, dir] of Object.entries(decoys)) {
        assert.equal(process.env[key], dir)
        assert.deepEqual(fs.readdirSync(dir), [], `${key} decoy must stay empty`)
      }
    })
  })
}
