// Remote service `sessionsManager` of dsh-plugin-sessions (Host half).
//
// One TypertRemoteService with the eight unary methods of src/contract.js.
// Every method refuses a caller that is not the owner. The read methods
// (overview, archived, trash, plan) never change the store; the four mutating
// ones (apply, unarchive, restore, purge) run one at a time in this process
// (a second one gets `busy`) and under the trash engine's cross-process lock
// (design.md D6; unarchive takes it only where a prune can run at all). A
// failure while reading the store is `store-unreadable`.
//
// Read path: one store snapshot (src/store-index.js over the host adapter),
// cached for snapshotTtlMs and built by one call at a time; `fresh: true`
// bypasses the cache, and every mutation drops it. Only the index's compact
// rows are kept.
//
// Prune (docs/store-safety.md, Plugin rules; design.md D2, D5):
//   recover() -> audit apply-start (abort if it fails) -> re-read every fact
//   -> manifest (trash.createBatch) and the registry hints -> per unit:
//   synchronous re-check of the live ids and the session lock (held across
//   the rename), then the renames -> post-move rule (the backend must no
//   longer list the id, else `stale-backend-entry` and that unit's registry
//   steps wait for a later recover()) -> registry steps of policy at-prune:
//   unpin -> detach (recorded workspace) -> unarchive, each idempotent and
//   journaled in the batch -> audit apply-end.
// Restore: recover() -> move back (exact recorded folder; `workspace-missing`
//   and `conflict` keep the unit in trash) -> verify the log is back (same
//   folder, size and revision file part) -> attach, check membership ->
//   insertSessionBefore the recorded anchor -> archive -> pin (only members
//   that were pinned and not archived), each journaled.
// recover(): the trash engine's recover(), then the registry steps a crash
//   left undone: units wholly in trash get their prune steps, units moved back
//   get their restore steps. It never deletes and never moves toward the trash.
//
// The trash manifest (src/trash.js) records each member's workspace, parent,
// archived and pinned marks, but not its position in the workspace order nor
// its persistence revision and size. Both are written once, before the first
// move, to `registry.json` in the batch folder (HINTS_FILE); purge removes it
// with the batch. Without it a restore still attaches, archives and pins, but
// keeps the attach position and checks only that the log is back.
//
// Host services are reached only through src/host-adapter.js.

import { randomBytes } from 'node:crypto'
import nodeFs, { constants } from 'node:fs'
import path from 'node:path'
import { principalOf, Remote, RemoteError, remoteErrorOf, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { AuditError, createAudit } from './audit.js'
import { clampNumber, DEFAULTS, RANGES, resolveConfig } from './config.js'
import { assertRequest, BATCH_ID_PATTERN, ERROR, ERROR_CODES, METHOD_NAMES, NAMESPACE } from './contract.js'
import { diffPlan, planDigest, selectScope } from './lineage.js'
import { assertDisjoint, PathError } from './paths.js'
import { archivedPage, buildIndex, overview as overviewOf } from './store-index.js'
import { createTrash, isBatchId, MANIFEST_FILE } from './trash.js'

/** Plans kept in memory; an older one reads as expired. */
export const PLANS_KEPT = 5
/** Registry hints of a batch: position, anchors, revision and size of each member. */
export const HINTS_FILE = 'registry.json'
export const HINTS_KIND = 'dsh-plugin-sessions/registry-hints'
const MAX_HINTS_BYTES = 64 * 1024 * 1024
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024
const MINUTE_MS = 60_000
const PRUNE_STEPS = new Set(['unpin', 'detach', 'unarchive'])
const STATE_RANK = Object.freeze({ complete: 0, partial: 1, conflict: 2, 'needs-recovery': 3 })
const STEP_ERROR = /^[A-Za-z0-9_.:-]{1,64}$/
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0
const VIEW_NUMBERS = Object.freeze([
  'recentActivityMinutes', 'listLimit', 'largeSessionBytes', 'indexWarnBytes', 'refreshMs', 'planTtlMinutes', 'snapshotTtlMs',
])

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isId = (value) => typeof value === 'string' && value.length > 0
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const describe = (error) => {
  try {
    return error instanceof Error ? String(error.message) : String(error)
  } catch {
    return 'an unreadable error'
  }
}
const remote = (code, message) => new RemoteError(code, message, {})
const worst = (...states) => states.reduce((a, b) => ((STATE_RANK[b] ?? 0) > (STATE_RANK[a] ?? 0) ? b : a), 'complete')
/** The file part of a persistence revision: dev:ino:size:mtimeNs:ctimeNs (docs/store-safety.md, Doubts). */
const filePart = (revision) => String(revision).split(':').slice(0, 5).join(':')
const errorToken = (error) => {
  for (const candidate of [error?.code, error?.name]) if (typeof candidate === 'string' && STEP_ERROR.test(candidate)) return candidate
  return 'error'
}

/** A contract error for any failure a method lets out; other errors pass unchanged. */
function toRemote(error) {
  if (remoteErrorOf(error) !== undefined) return error
  const code = error?.code
  if (typeof code === 'string' && ERROR_CODES.includes(code)) return remote(code, describe(error))
  if (error instanceof PathError || error instanceof AuditError) return remote(ERROR.trashUnusable, describe(error))
  return error
}

/** Warnings of one call, without duplicates, in first-seen order. */
function warningList() {
  const list = []
  const seen = new Set()
  const add = (code, sessionId = null) => {
    const key = `${code}\u0000${sessionId}`
    if (seen.has(key)) return
    seen.add(key)
    list.push({ code, sessionId })
  }
  return { list, add, merge: (items) => { for (const item of items ?? []) add(item.code, item.sessionId ?? null) } }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const viewOf = (config) => Object.freeze({
  allowPermanentDelete: config.allowPermanentDelete,
  ...Object.fromEntries(VIEW_NUMBERS.map((key) => [key, config[key]])),
})

/**
 * Resolve the plugin config through config.js. An invalid config never
 * throws: `config` is null, `problem` says why, and `view` still holds clamped
 * numbers for the read-only dashboard (permanent delete off unless it was
 * explicitly true).
 * @param {unknown} raw plugin config
 * @param {{ home?: string, platform?: string }} [options] DSH home (profileContext.home)
 * @returns {{ config: object | null, view: object, problem: string | null }}
 */
export function resolveSettings(raw, options = {}) {
  try {
    const config = resolveConfig(raw, { home: options.home, platform: options.platform })
    return { config, view: viewOf(config), problem: null }
  } catch (error) {
    const source = isPlain(raw) ? raw : {}
    const view = Object.freeze({
      allowPermanentDelete: source.allowPermanentDelete === undefined ? DEFAULTS.allowPermanentDelete : source.allowPermanentDelete === true,
      ...Object.fromEntries(VIEW_NUMBERS.map((key) => [key, clampNumber(source[key], DEFAULTS[key], RANGES[key])])),
    })
    return { config: null, view, problem: `invalid plugin config: ${describe(error)}` }
  }
}

// ---------------------------------------------------------------------------
// Small files the service owns: registry hints, and the store root a manifest
// recorded (used only when the store lists no session at all).
// ---------------------------------------------------------------------------

function readBytes(fs, file, cap) {
  let fd
  try {
    fd = fs.openSync(file, constants.O_RDONLY | O_NOFOLLOW)
  } catch {
    return null
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > cap) return null
    const buffer = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < buffer.length) {
      const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset)
      if (read === 0) break
      offset += read
    }
    return buffer.subarray(0, offset)
  } catch {
    return null
  } finally {
    try { fs.closeSync(fd) } catch { /* already closed */ }
  }
}

function readJson(fs, file, cap) {
  const bytes = readBytes(fs, file, cap)
  if (bytes === null) return null
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
}

/** Create the hints file of a batch ('wx' + O_NOFOLLOW, 0600), write it whole and fsync it. */
function writeHints(fs, dir, record) {
  const buffer = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8')
  const fd = fs.openSync(path.join(dir, HINTS_FILE), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600)
  try {
    let offset = 0
    while (offset < buffer.length) {
      const written = fs.writeSync(fd, buffer, offset, buffer.length - offset)
      if (!(written > 0)) throw new Error(`short write to ${HINTS_FILE}`)
      offset += written
    }
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

const isHint = (value) => isPlain(value) && isId(value.id) && (value.workspaceId === null || isId(value.workspaceId))
  && (value.position === null || (Number.isSafeInteger(value.position) && value.position >= 0))
  && Array.isArray(value.anchors) && value.anchors.every(isId)
  && (value.revision === null || isId(value.revision) || Number.isFinite(value.revision))
  && (value.sizeBytes === null || (Number.isSafeInteger(value.sizeBytes) && value.sizeBytes >= 0))

/** The hints of a batch by session id, or null when the file is missing or not valid. */
function readHints(fs, trashDir, batchId) {
  if (!BATCH_ID_PATTERN.test(batchId) || batchId.includes('..')) return null
  const value = readJson(fs, path.join(trashDir, batchId, HINTS_FILE), MAX_HINTS_BYTES)
  if (!isPlain(value) || value.v !== 1 || value.kind !== HINTS_KIND || value.batchId !== batchId || !Array.isArray(value.sessions)) return null
  if (!value.sessions.every(isHint)) return null
  return new Map(value.sessions.map((hint) => [hint.id, hint]))
}

const CLEAN_ABSOLUTE = (value) => typeof value === 'string' && value.startsWith('/') && value.length <= 4096
  && !/[\u0000-\u001f\u007f\\]/.test(value) && value.slice(1).split('/').every((part) => part !== '' && part !== '.' && part !== '..')

/**
 * The sessions tree the newest batch recorded, when it is still a folder. The
 * root comes from the persistence locations; with an empty store this is the
 * only way to find it again, so a batch can still be restored.
 */
function recordedRoot(fs, trashDir) {
  let names
  try {
    names = fs.readdirSync(trashDir)
  } catch {
    return null
  }
  let best = null
  for (const name of [...names].sort()) {
    if (!BATCH_ID_PATTERN.test(name) || name.includes('..')) continue
    const value = readJson(fs, path.join(trashDir, name, MANIFEST_FILE), MAX_MANIFEST_BYTES)
    if (!isPlain(value) || !CLEAN_ABSOLUTE(value.sessionsRoot) || !Number.isSafeInteger(value.createdAt)) continue
    if (best === null || value.createdAt > best.createdAt) best = value
  }
  if (best === null) return null
  try {
    return fs.lstatSync(best.sessionsRoot).isDirectory() ? best.sessionsRoot : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The core: all state of one service, shared by every receiver of its methods
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {object} options.adapter the host adapter (src/host-adapter.js)
 * @param {{ config: object | null, view: object, problem: string | null }} options.settings resolveSettings() output
 * @param {object} [options.fs] node:fs-compatible sync API for the trash engine and the hints (default node:fs)
 * @param {() => number} [options.clock] ms since the epoch (default Date.now)
 * @param {(size: number) => Buffer} [options.random] random bytes (plan ids)
 * @param {object} [options.trashOptions] extra createTrash options (identity, isAlive, uid, random)
 * @param {string} [options.pluginVersion] recorded in the audit log
 */
function createCore(options) {
  const { adapter, settings } = options
  if (!isPlain(settings) || !isPlain(settings.view)) throw new TypeError('SessionsManagerService needs resolved settings')
  if (adapter === null || typeof adapter !== 'object' || typeof adapter.facts !== 'function') throw new TypeError('SessionsManagerService needs a host adapter')
  const fs = options.fs ?? nodeFs
  const clock = options.clock ?? Date.now
  const random = options.random ?? randomBytes
  const trashOptions = options.trashOptions ?? {}
  const { config, view } = settings
  const now = () => Math.floor(clock())

  const state = {
    mutating: null,
    generation: 0,
    cache: null,
    building: null,
    plans: new Map(),
    engine: null,
    audit: null,
    logged: new Set(),
  }

  const logOnce = (message) => {
    if (state.logged.has(message)) return
    state.logged.add(message)
    adapter.warn(`sessions-manager: ${message}`)
  }
  if (settings.problem !== null) logOnce(`${settings.problem}; the dashboard stays read-only`)

  function audit() {
    if (config === null) throw new AuditError('no usable dataDir')
    state.audit ??= createAudit(config.dataDir, { now: () => new Date(now()), pluginVersion: options.pluginVersion })
    return state.audit
  }
  if (config !== null) {
    const problem = audit().writableProblem()
    if (problem !== undefined) logOnce(`the audit log in dataDir is ${problem}; pruning stays off until it is fixed`)
  }

  /** Append one audit line; a failure becomes an audit-failed warning. Returns whether it was written. */
  async function note(record, warnings) {
    let result
    try {
      result = await audit().append(record)
    } catch {
      result = { ok: false }
    }
    if (!result.ok) warnings?.add('audit-failed', null)
    return result.ok
  }

  function engineFor(root) {
    if (state.engine?.root === root) return state.engine.trash
    const trash = createTrash({
      ...trashOptions,
      config: { trashDir: config.trashDir, allowPermanentDelete: config.allowPermanentDelete },
      sessionsRoot: root,
      fs,
      now,
    })
    state.engine = { root, trash }
    return trash
  }

  // --- read path -------------------------------------------------------------

  /**
   * One read of the store. Any failure while reading it (the backend's
   * listing rejects, for example when a project folder vanishes during the
   * listing, docs/store-safety.md S6) is `store-unreadable`, with a message
   * that names no path: the backend's own message may hold one.
   */
  async function readStore() {
    try {
      return await buildIndex(adapter.facts(), { config: view, now: now(), folderBytes: adapter.folderBytes })
    } catch (error) {
      if (remoteErrorOf(error) !== undefined) throw error
      throw remote(ERROR.storeUnreadable, `the session store cannot be read now (${errorToken(error)}); try again`)
    }
  }

  /** Why the trash cannot be used with this sessions tree, or null. Logged once per distinct reason. */
  async function trashProblem(root) {
    if (config === null) return settings.problem
    let problem = null
    const auditProblem = audit().writableProblem()
    if (auditProblem !== undefined) problem = `the audit log in dataDir is ${auditProblem}`
    if (problem === null) {
      try {
        await assertDisjoint(root, config.dataDir)
      } catch (error) {
        problem = `dataDir: ${describe(error)}`
      }
    }
    if (problem === null) {
      try {
        await engineFor(root).validate()
      } catch (error) {
        problem = `trashDir: ${describe(error)}`
      }
    }
    if (problem !== null) logOnce(`${problem}; pruning stays off (the dashboard is read-only)`)
    return problem
  }

  const backendReady = () => {
    const present = adapter.services()
    return present.persistence && present.registry && present.live
  }

  /**
   * The sessions tree of a store read: the store root of its listing; when
   * the store lists no session at all, the one the newest batch recorded (so
   * its sessions can still be restored, and the dashboard says so); else null.
   */
  const rootOf = (index) => (index.storeRoot === null && index.rows.length === 0 && config !== null ? recordedRoot(fs, config.trashDir) : index.storeRoot)

  async function capabilitiesOf(root) {
    if (!adapter.lockProbeSupported) return { prune: false, reason: ERROR.unsupportedPlatform }
    if (!backendReady() || root === null) return { prune: false, reason: ERROR.unsupportedBackend }
    if ((await trashProblem(root)) !== null) return { prune: false, reason: ERROR.trashUnusable }
    return { prune: true, reason: null }
  }

  async function buildSnapshot() {
    const at = now()
    const index = await readStore()
    const root = rootOf(index)
    return { index, root, capabilities: await capabilitiesOf(root), at }
  }

  /** The cached snapshot, or one new build shared by every caller of this generation. */
  function snapshot({ fresh = false } = {}) {
    const cached = state.cache
    if (!fresh && cached !== null && now() - cached.at < view.snapshotTtlMs) return Promise.resolve(cached)
    const { generation } = state
    if (state.building !== null && state.building.generation === generation) return state.building.promise
    const promise = buildSnapshot().then((built) => {
      if (state.generation === generation) state.cache = built
      return built
    })
    const entry = { generation, promise }
    state.building = entry
    const clear = () => { if (state.building === entry) state.building = null }
    promise.then(clear, clear)
    return promise
  }

  const invalidate = () => {
    state.generation += 1
    state.cache = null
  }

  /** Run one mutation; a second one while it runs gets busy. Every mutation drops the snapshot. */
  async function mutate(name, fn) {
    if (state.mutating !== null) throw remote(ERROR.busy, `sessions manager: ${state.mutating} is still running`)
    state.mutating = name
    invalidate()
    try {
      return await fn()
    } finally {
      state.mutating = null
      invalidate()
    }
  }

  /** Checks shared by the trash mutations; returns the sessions tree and its trash engine. */
  async function mutationContext({ needStoreRoot }) {
    if (!adapter.lockProbeSupported) {
      throw remote(ERROR.unsupportedPlatform, 'the session lock probe is not available on this platform; the dashboard is read-only')
    }
    if (config === null) throw remote(ERROR.trashUnusable, settings.problem)
    if (!backendReady()) throw remote(ERROR.unsupportedBackend, 'session persistence, the live-session service or the workspace registry is not available')
    const index = await readStore()
    let root = index.storeRoot
    if (root === null && !needStoreRoot && index.rows.length === 0) root = recordedRoot(fs, config.trashDir)
    if (root === null) throw remote(ERROR.unsupportedBackend, 'the persistence backend gives no JSONL session folders')
    const problem = await trashProblem(root)
    if (problem !== null) throw remote(ERROR.trashUnusable, problem)
    return { index, root, trash: engineFor(root) }
  }

  const acquire = (trash) => {
    try {
      return trash.acquire()
    } catch (error) {
      throw toRemote(error)
    }
  }

  /**
   * A batch id the trash engine accepts. The request pattern (BATCH_ID_PATTERN)
   * lets `..` through, which no batch can be named with (trash.js isBatchId):
   * such an id names no batch, before any lock, recovery or audit line.
   */
  const assertBatchId = (batchId) => {
    if (!isBatchId(batchId)) throw remote(ERROR.batchNotFound, 'no batch has this id')
  }

  // --- registry steps ----------------------------------------------------------

  /** Run one registry step and journal its outcome; a journal failure propagates. */
  async function runStep(record, step, id, fn, warnings) {
    let outcome = 'ok'
    let error
    try {
      const value = await fn()
      if (value === 'skipped') outcome = 'skipped'
      else if (value === 'workspace-missing') {
        outcome = 'skipped'
        error = 'workspace-missing'
      } else if (typeof value === 'string' && value !== 'ok') {
        outcome = 'failed'
        error = value
      }
    } catch (failure) {
      outcome = 'failed'
      error = errorToken(failure)
    }
    if (outcome === 'failed' || error === 'workspace-missing') warnings.add('registry-step-failed', id)
    record(error === undefined ? { step, id, outcome } : { step, id, outcome, error })
    return outcome
  }

  const detachDone = (history) => history.some((s) => s.step === 'detach' && s.outcome !== 'failed')
  const pruneNeeded = (entry, history) => adapter.isPinned(entry.id) || (entry.workspaceId !== null && !detachDone(history))
    || adapter.isArchived(entry.id)

  /** The at-prune steps one moved member still needs: unpin, detach (recorded workspace), unarchive. */
  async function completePrune(entry, history, record, warnings) {
    const { id } = entry
    let count = 0
    if (adapter.isPinned(id)) {
      await runStep(record, 'unpin', id, () => adapter.unpin(id), warnings)
      count += 1
    }
    if (entry.workspaceId !== null && !detachDone(history)) {
      await runStep(record, 'detach', id, () => adapter.detach(id, entry.workspaceId), warnings)
      count += 1
    }
    if (adapter.isArchived(id)) {
      await runStep(record, 'unarchive', id, () => adapter.unarchive(id), warnings)
      count += 1
    }
    return count
  }

  /** Ids the backend still lists (or cannot answer for): the post-move rule failed for them. */
  async function stillListed(ids) {
    const out = []
    for (const id of ids) {
      let found
      try {
        found = await adapter.stat(id)
      } catch {
        found = null
      }
      if (found !== undefined) out.push(id)
    }
    return out
  }

  /** 'ok', 'changed' (back, but not the recorded log) or 'missing' (the backend does not list it at the recorded folder). */
  async function verify(entry, hint) {
    let found
    try {
      found = await adapter.stat(entry.id)
    } catch {
      return 'missing'
    }
    if (found === undefined || found.path === null || path.dirname(found.path) !== entry.source) return 'missing'
    if (hint === null || hint.revision === null) return 'ok'
    if (filePart(found.revision) !== filePart(hint.revision)) return 'changed'
    if (hint.sizeBytes !== null && found.sizeBytes !== hint.sizeBytes) return 'changed'
    return 'ok'
  }

  /** Steps after the last prune step of an id: what its restore already did. */
  const restorePhase = (history) => {
    let last = -1
    history.forEach((s, at) => { if (PRUNE_STEPS.has(s.step)) last = at })
    return history.slice(last + 1)
  }

  /**
   * The restore steps the given members still need, members with a later
   * recorded position first, so that each recorded anchor is back before the
   * member that goes in front of it. A step is needed until the batch journal
   * holds it (ok or skipped), never because of the registry's state now: once
   * a restore is done, the user may unarchive, unpin or move the session, and
   * a later recover() must not undo that. `strict`: a log that is back but not
   * the recorded one is not attached (the restore itself); recovery accepts it,
   * since the session may have been used since.
   */
  async function completeRestore(entries, histories, hints, record, warnings, { strict }) {
    const items = entries.map((entry) => ({ entry, hint: hints?.get(entry.id) ?? null, history: restorePhase(histories.get(entry.id) ?? []) }))
    items.sort((a, b) => {
      const aw = a.entry.workspaceId
      const bw = b.entry.workspaceId
      if ((aw === null) !== (bw === null)) return aw === null ? 1 : -1
      if (aw !== bw) return byString(aw, bw)
      const ap = a.hint?.position ?? -1
      const bp = b.hint?.position ?? -1
      return bp - ap || byString(a.entry.id, b.entry.id)
    })
    let count = 0
    for (const { entry, hint, history } of items) {
      const { id, workspaceId } = entry
      const done = (step) => history.some((s) => s.step === step && s.outcome !== 'failed')
      const gone = history.some((s) => s.step === 'attach' && s.error === 'workspace-missing')
      const needAttach = workspaceId !== null && !done('attach')
      const needInsert = workspaceId !== null && !gone && !done('insert')
      const needArchive = entry.archived && !done('archive')
      const needPin = entry.pinned && !entry.archived && !done('pin')
      if (!needAttach && !needInsert && !needArchive && !needPin) continue
      const verdict = await verify(entry, hint)
      if (verdict === 'missing' || (strict && verdict === 'changed')) {
        warnings.add('recovery-needed', id)
        continue
      }
      let attached = !needAttach && !gone
      if (needAttach) {
        attached = (await runStep(record, 'attach', id, () => adapter.attach(id, workspaceId), warnings)) === 'ok'
        count += 1
      }
      if (attached && needInsert) {
        await runStep(record, 'insert', id, () => (hint === null ? 'skipped' : adapter.insertBefore(id, workspaceId, hint.anchors)), warnings)
        count += 1
      }
      if (needArchive) {
        await runStep(record, 'archive', id, () => adapter.archive(id), warnings)
        count += 1
      }
      if (needPin && !adapter.isArchived(id)) {
        await runStep(record, 'pin', id, () => adapter.pin(id), warnings)
        count += 1
      }
    }
    return count
  }

  const historiesOf = (steps) => {
    const out = new Map()
    for (const s of steps) {
      const list = out.get(s.id)
      if (list) list.push(s)
      else out.set(s.id, [s])
    }
    return out
  }

  /** Registry steps a crash left undone in one batch (inspect() output). Returns how many ran. */
  async function completeBatch(trash, info, warnings) {
    const hints = readHints(fs, trash.trashDir, info.batchId)
    const record = (step) => trash.recordStep(info.batchId, step)
    const entries = new Map(info.sessions.map((s) => [s.id, s]))
    const histories = historiesOf(info.steps)
    let count = 0
    for (const unit of info.units) {
      if (unit.location !== 'trash') continue
      const members = unit.memberIds.map((id) => entries.get(id))
      if (!members.some((entry) => pruneNeeded(entry, histories.get(entry.id) ?? []))) continue
      const listed = await stillListed(unit.memberIds)
      if (listed.length > 0) {
        for (const id of listed) warnings.add('stale-backend-entry', id)
        warnings.add('restart-recommended', null)
        continue
      }
      for (const entry of members) count += await completePrune(entry, histories.get(entry.id) ?? [], record, warnings)
    }
    const back = []
    for (const unit of info.units) {
      if (unit.location !== 'store') continue
      for (const id of unit.memberIds) {
        if ((histories.get(id) ?? []).some((s) => PRUNE_STEPS.has(s.step) && s.outcome === 'ok')) back.push(entries.get(id))
      }
    }
    count += await completeRestore(back, histories, hints, record, warnings, { strict: false })
    return count
  }

  /** recover() with the trash lock held by the caller. */
  async function recoverLocked(trash, warnings) {
    const report = trash.recover()
    const batches = []
    const problems = [...report.problems]
    let steps = 0
    for (const item of report.batches) {
      let info
      try {
        info = trash.inspect(item.batchId)
      } catch (error) {
        problems.push({ name: item.batchId, code: error?.code ?? 'error' })
        continue
      }
      const done = await completeBatch(trash, info, warnings)
      steps += done
      batches.push({
        batchId: item.batchId, state: info.state, appended: item.appended, moved: item.moved, conflicts: item.conflicts, lost: item.lost, steps: done,
      })
    }
    const appended = report.batches.reduce((sum, item) => sum + item.appended, 0)
    const moved = report.batches.reduce((sum, item) => sum + item.moved, 0)
    if (appended > 0 || moved > 0 || steps > 0) {
      await note({ op: 'recover', counts: { batches: batches.length, appended, moved, steps } }, warnings)
    }
    return { batches, tombstones: report.tombstones, orphans: report.orphans, problems, warnings: warnings.list }
  }

  // --- plan ----------------------------------------------------------------------

  function planDto(planId, expiresAt, units) {
    const dtoUnits = units.map((unit) => ({
      rootId: unit.rootId,
      memberIds: [...unit.memberIds],
      bytes: unit.bytes,
      workspaceId: unit.workspaceId ?? null,
      status: unit.status,
      reasons: unit.reasons.map(({ code, sessionId }) => ({ code, sessionId })),
    }))
    const ready = dtoUnits.filter((unit) => unit.status === 'ready')
    const sum = (list, pick) => list.reduce((total, unit) => total + pick(unit), 0)
    const groups = new Map()
    for (const unit of ready) {
      const group = groups.get(unit.workspaceId) ?? { workspaceId: unit.workspaceId, units: 0, sessions: 0, bytes: 0 }
      group.units += 1
      group.sessions += unit.memberIds.length
      group.bytes += unit.bytes
      groups.set(unit.workspaceId, group)
    }
    const byWorkspace = [...groups.values()].sort((a, b) => b.bytes - a.bytes
      || (a.workspaceId === null ? 1 : 0) - (b.workspaceId === null ? 1 : 0) || byString(a.workspaceId ?? '', b.workspaceId ?? ''))
    return {
      planId,
      expiresAt,
      digest: planDigest(units),
      units: dtoUnits,
      totals: {
        units: dtoUnits.length,
        ready: ready.length,
        blocked: dtoUnits.length - ready.length,
        sessions: sum(dtoUnits, (unit) => unit.memberIds.length),
        readySessions: sum(ready, (unit) => unit.memberIds.length),
        bytes: sum(dtoUnits, (unit) => unit.bytes),
        readyBytes: sum(ready, (unit) => unit.bytes),
      },
      byWorkspace,
    }
  }

  function remember(plan) {
    const at = now()
    for (const [id, held] of state.plans) if (held.expiresAt <= at) state.plans.delete(id)
    state.plans.set(plan.planId, plan)
    while (state.plans.size > PLANS_KEPT) state.plans.delete(state.plans.keys().next().value)
  }

  async function plan(request) {
    const snap = await snapshot({ fresh: true })
    if (!snap.capabilities.prune) throw remote(snap.capabilities.reason, 'pruning is not available here; the dashboard is read-only')
    const issued = now()
    const selected = selectScope(snap.index.units, request, issued)
    const planId = `p-${random(9).toString('hex')}`
    const dto = planDto(planId, issued + view.planTtlMinutes * MINUTE_MS, selected)
    remember({
      planId,
      expiresAt: dto.expiresAt,
      digest: dto.digest,
      readySessions: dto.totals.readySessions,
      units: selected.filter((unit) => unit.status === 'ready'),
    })
    const { totals } = dto
    await note({
      op: 'plan', planId, digest: dto.digest,
      counts: { units: totals.units, ready: totals.ready, blocked: totals.blocked, sessions: totals.sessions, readySessions: totals.readySessions },
      bytes: totals.readyBytes,
    })
    return dto
  }

  // --- apply -----------------------------------------------------------------------

  /** Units of the plan that still qualify after a fresh read, and the ones skipped with their reasons. */
  async function requalify(planned, index) {
    const archivedIds = index.rows.filter((row) => row.archived).map((row) => row.id)
    const skipped = new Map(diffPlan(planned, index.units, { archivedIds }).map((entry) => [entry.rootId, entry]))
    const freshByRoot = new Map(index.units.map((unit) => [unit.rootId, unit]))
    const rows = new Map()
    for (const row of index.rows) if (!rows.has(row.id)) rows.set(row.id, row)
    const out = { units: [], skipped: [], stats: new Map() }
    const skip = (rootId, code, sessionId) => out.skipped.push({ rootId, reasons: [{ code, sessionId }] })
    for (const old of planned) {
      if (skipped.has(old.rootId)) {
        out.skipped.push(skipped.get(old.rootId))
        continue
      }
      const unit = freshByRoot.get(old.rootId)
      if (unit === undefined) {
        skip(old.rootId, 'changed', old.rootId)
        continue
      }
      if (unit.status !== 'ready') {
        out.skipped.push({ rootId: unit.rootId, reasons: unit.reasons.map(({ code, sessionId }) => ({ code, sessionId })) })
        continue
      }
      let problem = null
      for (const id of unit.memberIds) {
        const row = rows.get(id)
        if (row === undefined || !isId(row.dir) || !isId(row.workspaceDir)) {
          problem = ['path-unsafe', id]
          break
        }
        let found
        try {
          found = await adapter.stat(id)
        } catch {
          found = null
        }
        if (found === undefined || found === null || found.path === null || path.dirname(found.path) !== row.dir) problem = ['changed', id]
        else if (found.formatStatus === 'migration-required') problem = ['legacy-format', id]
        else if (String(found.revision) !== String(row.revision)) problem = ['changed', id]
        if (problem !== null) break
        out.stats.set(id, found)
      }
      if (problem !== null) skip(unit.rootId, problem[0], problem[1])
      else out.units.push({ unit, rows: unit.memberIds.map((id) => rows.get(id)) })
    }
    return out
  }

  /**
   * The synchronous last check before each rename: live, still archived, and
   * the session lock (held across the rename). A folder the probe refuses as
   * a link (or swapped for one while it probed) is `path-unsafe`, not `locked`.
   */
  const prunePrecheck = (entry) => {
    if (adapter.isLive(entry.id)) return 'live'
    if (entry.archived && !adapter.isArchived(entry.id)) return 'not-archived'
    const lock = adapter.holdLock(entry.source)
    if (lock.detail === 'path-unsafe') return 'path-unsafe'
    if (lock.state !== 'none' && lock.state !== 'stale') return 'locked'
    return lock.release ?? null
  }

  async function applyLocked(trash, planned) {
    const warnings = warningList()
    await recoverLocked(trash, warnings)
    try {
      await audit().appendStart({ planId: planned.planId, digest: planned.digest, counts: { units: planned.units.length, sessions: planned.readySessions } })
    } catch (error) {
      throw remote(ERROR.trashUnusable, `the audit log cannot be written (${describe(error)}); nothing was moved`)
    }
    const index = await readStore()
    const fresh = await requalify(planned.units, index)
    const order = adapter.workspaceOrder()
    const entries = new Map()
    const intent = { planId: planned.planId, units: [], sessions: [] }
    for (const { unit, rows } of fresh.units) {
      intent.units.push({ rootId: unit.rootId, memberIds: [...unit.memberIds] })
      for (const row of rows) {
        const entry = {
          id: row.id, workspaceDir: row.workspaceDir, workspaceId: order.get(row.id)?.workspaceId ?? null, parent: row.parentId ?? null,
          archived: row.archived === true, pinned: row.pinned === true, bytes: row.bytes, source: row.dir,
        }
        entries.set(row.id, entry)
        intent.sessions.push(entry)
      }
    }
    const batch = trash.createBatch(intent)
    let result = null
    let fatal = false
    const outcomes = []
    try {
      if (batch.batchId !== null) {
        try {
          writeHints(fs, batch.dir, {
            v: 1, kind: HINTS_KIND, batchId: batch.batchId,
            sessions: intent.sessions.map((s) => {
              const held = order.get(s.id)
              const found = fresh.stats.get(s.id)
              return {
                id: s.id, workspaceId: s.workspaceId, position: held?.position ?? null, anchors: held?.anchors ?? [],
                revision: found?.revision ?? null, sizeBytes: found?.sizeBytes ?? null,
              }
            }),
          })
        } catch (error) {
          throw remote(ERROR.trashUnusable, `the registry hints of batch ${batch.batchId} cannot be written (${describe(error)}); nothing was moved`)
        }
      }
      for (const unit of batch.units) {
        let outcome
        try {
          outcome = batch.moveUnit(unit, prunePrecheck)
        } catch {
          warnings.add('recovery-needed', unit.rootId)
          fatal = true
          break
        }
        outcomes.push(outcome)
        if (outcome.outcome !== 'moved') {
          await note({ op: 'unit-skipped', batchId: batch.batchId, planId: planned.planId, reasons: outcome.reasons }, warnings)
          continue
        }
        const members = unit.memberIds.map((id) => entries.get(id))
        await note({ op: 'unit-moved', batchId: batch.batchId, planId: planned.planId, sessions: members, bytes: unit.bytes }, warnings)
        const listed = await stillListed(unit.memberIds)
        if (listed.length > 0) {
          for (const id of listed) warnings.add('stale-backend-entry', id)
          warnings.add('restart-recommended', null)
          continue
        }
        const before = warnings.list.length
        let steps = 0
        try {
          for (const entry of members) steps += await completePrune(entry, [], (step) => batch.recordStep(step), warnings)
        } catch {
          warnings.add('recovery-needed', unit.rootId)
          fatal = true
          break
        }
        const failed = warnings.list.slice(before).filter((w) => w.code === 'registry-step-failed').length
        await note({ op: 'registry-step', batchId: batch.batchId, counts: { steps, failed }, outcome: failed > 0 ? 'failed' : 'ok' }, warnings)
      }
    } finally {
      if (!batch.finished) {
        try {
          result = batch.finish()
        } catch {
          fatal = true
          warnings.add('recovery-needed', null)
        }
      }
    }
    if (result === null) {
      const moved = outcomes.filter((o) => o.outcome === 'moved')
      result = {
        batchId: batch.batchId,
        trashDir: trash.trashDir,
        state: 'needs-recovery',
        moved: { units: moved.length, sessions: moved.reduce((n, o) => n + o.moved, 0), bytes: moved.reduce((n, o) => n + o.bytes, 0) },
        skipped: [...batch.refused, ...outcomes.filter((o) => o.outcome !== 'moved').map((o) => ({ rootId: o.rootId, reasons: o.reasons }))],
        warnings: [],
      }
    }
    warnings.merge(result.warnings)
    const skipped = [...fresh.skipped, ...result.skipped]
    const registryFailed = warnings.list.some((w) => w.code === 'registry-step-failed' || w.code === 'recovery-needed')
    const final = {
      batchId: result.batchId,
      trashDir: result.trashDir,
      state: worst(result.state, skipped.length > 0 ? 'partial' : 'complete', fatal || registryFailed ? 'needs-recovery' : 'complete'),
      moved: { ...result.moved },
      skipped,
      warnings: warnings.list,
    }
    await note({
      op: 'apply-end', planId: planned.planId, batchId: final.batchId ?? undefined,
      counts: { units: final.moved.units, sessions: final.moved.sessions, skipped: skipped.length }, bytes: final.moved.bytes, outcome: final.state,
    }, warnings)
    return { ...final, warnings: warnings.list }
  }

  async function apply(request) {
    return mutate('apply', async () => {
      const held = state.plans.get(request.planId)
      if (held === undefined || now() >= held.expiresAt) {
        state.plans.delete(request.planId)
        throw remote(ERROR.planExpired, 'the plan is unknown or expired; review the prune again')
      }
      if (request.confirmCount !== held.readySessions) throw remote(ERROR.confirmationMismatch, 'the typed count does not match the plan')
      const { trash } = await mutationContext({ needStoreRoot: true })
      const lock = acquire(trash)
      try {
        state.plans.delete(request.planId)
        return await applyLocked(trash, held)
      } finally {
        lock.release()
      }
    })
  }

  // --- restore -----------------------------------------------------------------------

  async function restore(request) {
    return mutate('restore', async () => {
      const { batchId } = request
      const { trash } = await mutationContext({ needStoreRoot: false })
      assertBatchId(batchId)
      const lock = acquire(trash)
      try {
        const warnings = warningList()
        await recoverLocked(trash, warnings)
        let before
        try {
          before = trash.inspect(batchId)
        } catch (error) {
          throw toRemote(error)
        }
        if (!(await note({ op: 'restore-start', batchId }, warnings))) {
          throw remote(ERROR.trashUnusable, 'the audit log cannot be written; nothing was moved')
        }
        const pending = before.sessions.filter((s) => s.location === 'trash')
        const pendingIds = new Set(pending.map((s) => s.id))
        const missing = new Set()
        for (const workspaceId of new Set(pending.map((s) => s.workspaceId).filter(isId))) {
          if ((await adapter.workspaceStatus(workspaceId)) !== 'ok') missing.add(workspaceId)
        }
        const listed = new Set(await stillListed(pending.map((s) => s.id)))
        const precheck = (entry) => {
          if (entry.workspaceId !== null && (missing.has(entry.workspaceId) || adapter.workspace(entry.workspaceId) === undefined)) return 'workspace-missing'
          if (listed.has(entry.id)) return 'conflict'
          return null
        }
        let result
        try {
          result = trash.restore(batchId, { precheck })
        } catch (error) {
          throw toRemote(error)
        }
        const after = trash.inspect(batchId)
        const back = after.sessions.filter((s) => s.location === 'store' && pendingIds.has(s.id))
        let fatal = false
        try {
          const hints = readHints(fs, trash.trashDir, batchId)
          await completeRestore(back, historiesOf(after.steps), hints, (step) => trash.recordStep(batchId, step), warnings, { strict: true })
        } catch {
          fatal = true
          warnings.add('recovery-needed', null)
        }
        warnings.merge(result.warnings)
        const registryFailed = warnings.list.some((w) => w.code === 'registry-step-failed' || w.code === 'recovery-needed')
        const final = {
          batchId: result.batchId,
          trashDir: result.trashDir,
          state: worst(result.state, fatal || registryFailed ? 'needs-recovery' : 'complete'),
          moved: { ...result.moved },
          skipped: result.skipped,
          warnings: warnings.list,
        }
        await note({
          op: 'restore-end', batchId, counts: { units: final.moved.units, sessions: final.moved.sessions, skipped: final.skipped.length },
          bytes: final.moved.bytes, outcome: final.state,
        }, warnings)
        return { ...final, warnings: warnings.list }
      } finally {
        lock.release()
      }
    })
  }

  // --- purge, unarchive, trash list ----------------------------------------------------

  async function purge(request) {
    return mutate('purge', async () => {
      const { batchId, confirm } = request
      if (confirm !== batchId) throw remote(ERROR.confirmationMismatch, 'the typed batch id does not match')
      if (config === null) throw remote(ERROR.trashUnusable, settings.problem)
      if (config.allowPermanentDelete !== true) throw remote(ERROR.purgeDisabled, 'permanent delete is disabled (allowPermanentDelete is false)')
      const { trash } = await mutationContext({ needStoreRoot: false })
      assertBatchId(batchId)
      const lock = acquire(trash)
      try {
        const warnings = warningList()
        await recoverLocked(trash, warnings)
        // No existence check here: trash.purge() also finishes an interrupted purge, whose batch folder is already gone.
        if (!(await note({ op: 'purge-start', batchId }, warnings))) throw remote(ERROR.trashUnusable, 'the audit log cannot be written; nothing was deleted')
        let result
        try {
          result = trash.purge(batchId)
        } catch (error) {
          await note({ op: 'purge-failed', batchId, errorCode: errorToken(error) }, warnings)
          throw toRemote(error)
        }
        await note({ op: 'purge-end', batchId, counts: { sessions: result.removedSessions }, bytes: result.removedBytes, outcome: 'ok' }, warnings)
        return { batchId: result.batchId, removedSessions: result.removedSessions, removedBytes: result.removedBytes }
      } finally {
        lock.release()
      }
    })
  }

  /**
   * The trash lock for unarchive. design.md D6: the trash lock serializes
   * every mutation, so an unarchive never runs while another process applies,
   * restores or purges with the same trash (it gets `busy`), and none of them
   * starts while it runs. Finding the trash engine takes one store read, for
   * the sessions tree. null where no process can prune with this trash, so
   * there is no lock to share: no lock probe on this platform (design.md D18),
   * no usable config or backend, no JSONL sessions tree, or a trash that fails
   * its checks (the dashboard is read-only then, and unarchive still works).
   */
  async function unarchiveLock() {
    if (!adapter.lockProbeSupported || config === null || !backendReady()) return null
    const index = await readStore()
    let root = index.storeRoot
    if (root === null && index.rows.length === 0) root = recordedRoot(fs, config.trashDir)
    if (root === null || (await trashProblem(root)) !== null) return null
    return acquire(engineFor(root))
  }

  /** The host's own unarchive, under the trash lock; otherwise registry-only (no move, no audit line, no journal). */
  async function unarchive(request) {
    return mutate('unarchive', async () => {
      const lock = await unarchiveLock()
      try {
        const unarchived = []
        const skipped = []
        for (const id of new Set(request.ids)) {
          if (!adapter.isArchived(id)) {
            skipped.push({ id, code: 'not-archived' })
            continue
          }
          if (adapter.isLive(id)) {
            skipped.push({ id, code: 'live' })
            continue
          }
          try {
            await adapter.unarchive(id)
            unarchived.push(id)
          } catch {
            skipped.push({ id, code: 'changed' })
          }
        }
        return { unarchived, skipped }
      } finally {
        lock?.release()
      }
    })
  }

  async function trashList(request) {
    if (config === null) throw remote(ERROR.trashUnusable, settings.problem)
    const snap = await snapshot({ fresh: request.fresh === true })
    const { root } = snap
    if (root === null) return { trashDir: config.trashDir, batches: [] }
    let list
    try {
      list = engineFor(root).list()
    } catch (error) {
      throw toRemote(error)
    }
    // A batch that holds nothing and needs nothing (fully restored, or nothing
    // moved) is not listed: the Trash tab shows what the trash holds.
    const batches = list.batches
      .filter((b) => !(b.state === 'complete' && b.sessions === 0))
      .map(({ batchId, createdAt, units, sessions, bytes, state: batchStateOf }) => ({ batchId, createdAt, units, sessions, bytes, state: batchStateOf }))
    return { trashDir: list.trashDir, batches }
  }

  const handlers = {
    async overview(request) {
      const snap = await snapshot({ fresh: request.fresh === true })
      // With an empty store the sessions tree comes from the trash (rootOf); the overview names it.
      return overviewOf(snap.index, { capabilities: snap.capabilities, storeDir: snap.root ?? undefined })
    },
    async archived(request) {
      const snap = await snapshot()
      return archivedPage(snap.index, request)
    },
    plan,
    apply,
    unarchive,
    trash: trashList,
    restore,
    purge,
  }

  return Object.freeze({
    /** One Remote call: owner check, request check, then the method; failures carry contract codes. */
    async call(ctx, name, request) {
      let principal
      try {
        principal = principalOf(ctx?.invocation)
      } catch {
        principal = { kind: 'unknown' }
      }
      if (principal !== undefined) throw remote(ERROR.forbidden, 'the sessions manager is for the owner of this machine only')
      try {
        assertRequest(name, request)
      } catch (error) {
        throw toRemote(error)
      }
      try {
        return await handlers[name](request)
      } catch (error) {
        throw toRemote(error)
      }
    },
    /** Reconcile the trash and the registry now (not a Remote method). */
    recover() {
      return mutate('recover', async () => {
        const { trash } = await mutationContext({ needStoreRoot: false })
        const lock = acquire(trash)
        try {
          return await recoverLocked(trash, warningList())
        } finally {
          lock.release()
        }
      })
    },
    /** Test and diagnostics view of the in-memory state: no row content, only its shape. */
    inspectState() {
      const rows = state.cache?.index.rows ?? []
      return {
        mutating: state.mutating,
        plans: [...state.plans.keys()],
        cached: state.cache !== null,
        rows: {
          count: rows.length,
          keys: [...new Set(rows.flatMap((row) => Object.keys(row)))],
          primitive: rows.every((row) => Object.values(row).every((value) => value === null || typeof value !== 'object')),
        },
      }
    },
  })
}

/** The Remote service `sessionsManager`. Construct it with the plugin context and createCore options. */
export class SessionsManagerService extends TypertRemoteService {
  static provide = NAMESPACE

  constructor(ctx, options = {}) {
    super(ctx)
    for (const name of METHOD_NAMES) Remote(this[name], { name, addInitializer: (fn) => fn.call(this) })
    Object.defineProperty(this, 'core', { value: createCore(options), enumerable: false })
  }

  overview(request) { return this.core.call(this.ctx, 'overview', request) }
  archived(request) { return this.core.call(this.ctx, 'archived', request) }
  plan(request) { return this.core.call(this.ctx, 'plan', request) }
  apply(request) { return this.core.call(this.ctx, 'apply', request) }
  unarchive(request) { return this.core.call(this.ctx, 'unarchive', request) }
  trash(request) { return this.core.call(this.ctx, 'trash', request) }
  restore(request) { return this.core.call(this.ctx, 'restore', request) }
  purge(request) { return this.core.call(this.ctx, 'purge', request) }

  /** Not a Remote method: finish what a crash left in the trash and the registry. Only in-process code calls it. */
  recover() { return this.core.recover() }
}
