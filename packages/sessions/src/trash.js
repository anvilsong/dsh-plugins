// Trash engine of dsh-plugin-sessions.
//
// A prune moves whole session folders out of the session store into one batch
// folder of the trash, by rename only; restore renames them back; purge
// deletes one batch for good. Layout under trashDir (folders 0700, files 0600):
//
//   .lock                    cross-process mutex: created with 'wx', records pid,
//                            process start time, host and a random token
//   .lock.released           record of the last released lock (each release
//                            renames .lock over it)
//   .journal.jsonl           trash-level journal: stale lock replacements
//   <batchId>/manifest.json  the full intent, created with 'wx' and fsynced
//                            before the first rename
//   <batchId>/journal.jsonl  one O_APPEND|O_NOFOLLOW line per state change; the
//                            state of a batch is a fold of these lines. A batch
//                            whose last line is `closed` is wholly back in the
//                            store with nothing left to do: recover() and
//                            list() skip it after one read of the journal's
//                            tail (the Host's check at start, without an
//                            engine: isClosedBatchFolder), and it stays on
//                            disk until a purge
//   <batchId>/sessions/<workspaceDir>/<id>/   a session folder in the trash
//   .staging-<batchId>/      a batch being created; renamed to <batchId> once its
//                            manifest and first journal line are on disk
//   .purge-<batchId>/        a batch being deleted for good
//
// Rules:
// - A move is one renameSync of a session folder. EXDEV is the refusal
//   `cross-device`; there is no copy fallback. A destination that exists, even
//   an empty folder, is `conflict` and is never renamed onto (rename(2)
//   silently replaces an empty folder). After the precheck and right before
//   the rename, the project folder and the session folder are lstat'ed again:
//   one swapped for a symlink or another folder meanwhile is `path-unsafe` and
//   is never renamed (rename(2) would move the link, not the data).
// - A unit (an archived root and all its descendants) moves all or nothing: a
//   failure inside a unit renames its moved members back.
// - Restore targets only the exact folder the manifest recorded. It may create
//   the missing project folder <sessionsRoot>/<workspaceDir> when the manifest
//   recorded it at prune time, and journals that it did. Project folders and
//   the sessions tree are never moved; the sessions tree is never created.
// - recover() never deletes. It compares every manifest entry with the disk,
//   appends the journal lines that are missing, closes interrupted operations,
//   and makes a unit that an interruption left split between store and trash
//   whole again in the store (it only ever renames toward the store). A
//   session the journal places in the store that is in neither place left the
//   store by other means (a newer batch pruned it again, the host took it
//   away): it is not lost to this batch, and nothing is journaled for it, so a
//   restored batch's journal is never written by a later batch's operations.
// - Only purge() deletes, and only <trashDir>/<batchId>. A closed batch is
//   never deleted by closing it: it stays as it is, unlisted.
// - `session.lock` inside a session folder is the host's kernel-lock target:
//   it travels with its folder and is never read, written or replaced here.
// - Every file-system call goes through the injected `fs` object (the tests
//   inject faults at every call index). This module reads no environment
//   variable and no home directory.

import { randomBytes } from 'node:crypto'
import nodeFs, { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { BATCH_ID_PATTERN, ERROR, REFUSAL_CODES } from './contract.js'
import { checkedPath } from './config.js'
import { assertDisjoint, PathError, sameDevice, SESSION_ID } from './paths.js'

export const MANIFEST_FILE = 'manifest.json'
export const JOURNAL_FILE = 'journal.jsonl'
export const SESSIONS_FOLDER = 'sessions'
export const LOCK_FILE = '.lock'
export const RELEASED_LOCK_FILE = '.lock.released'
export const TRASH_JOURNAL_FILE = '.journal.jsonl'
export const STAGING_PREFIX = '.staging-'
export const PURGE_PREFIX = '.purge-'
export const MANIFEST_KIND = 'dsh-plugin-sessions/trash-batch'
export const FORMAT_VERSION = 1
/** An unreadable `.lock` younger than this may be a lock being written: it counts as held. */
export const LOCK_GRACE_MS = 60_000
/** The tail of a journal read to find its `closed` line: far longer than that line. */
export const CLOSED_TAIL_BYTES = 512
export const REGISTRY_STEPS = Object.freeze(['unpin', 'detach', 'unarchive', 'attach', 'insert', 'archive', 'pin'])
export const STEP_OUTCOMES = Object.freeze(['ok', 'failed', 'skipped'])
/**
 * Where a session of a batch is: in the store, in the trash, in both
 * (`conflict`), or in neither (`lost`). Only a session the journal does not
 * place in the store can become `lost` (see placeOf).
 */
export const LOCATIONS = Object.freeze(['store', 'trash', 'conflict', 'lost'])

const MAX_MANIFEST_BYTES = 64 * 1024 * 1024
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024
const MAX_LOCK_BYTES = 4096
const DIR_MODE = 0o700
const FILE_MODE = 0o600
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0
const O_DIRECTORY = constants.O_DIRECTORY ?? 0
// 'wx' plus O_NOFOLLOW: create a new file, never through a symlink.
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_TRUNC | O_NOFOLLOW
// 'a' plus O_NOFOLLOW, and read access to check the last byte: never append through a symlink.
const APPEND_FLAGS = constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | O_NOFOLLOW
const READ_FLAGS = constants.O_RDONLY | O_NOFOLLOW
const FOLDER_FLAGS = constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW
// fsync of a folder is not supported everywhere; these codes mean "not supported", not "failed".
const FSYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR', 'EPERM', 'EBADF'])
const NEWLINE = Buffer.from('\n')
const LOCK_TOKEN = /^[0-9a-f]{16,64}$/
const ERROR_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/
/** The file part of a persistence revision: dev:ino:size:mtimeNs:ctimeNs, decimal. */
const REVISION_FILE_PART = /^[0-9]{1,40}(?::[0-9]{1,40}){4}$/
// C0 and C1 controls, Bidi_Control characters, line and paragraph separators, and both separators.
const UNSAFE_SEGMENT = /[\p{Cc}\p{Bidi_Control}\u2028\u2029/\\]/u

/** A failure of a trash operation; `code` is one of the contract's error codes. */
export class TrashError extends Error {
  /** @param {string} code @param {string} message @param {object} [details] */
  constructor(code, message, details) {
    super(message)
    this.name = 'TrashError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

const unsafe = (message) => new PathError('path-unsafe', message)
const errorCode = (error) => (typeof error?.code === 'string' && ERROR_TOKEN.test(error.code) ? error.code : 'EUNKNOWN')
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isCount = (value) => Number.isSafeInteger(value) && value >= 0
const nullableString = (value) => value === null || (typeof value === 'string' && value.length > 0)
const isWithin = (root, target) => {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** A session id that is one safe path segment (paths.js SESSION_ID) and holds no `..`. */
export function isSafeSessionId(id) {
  return typeof id === 'string' && SESSION_ID.test(id) && !id.includes('..')
}

/** A project folder name: one segment, not hidden, no `..`, no separator, control or bidirectional character. */
export function isSafeSegment(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 255 && !name.startsWith('.') && !name.includes('..')
    && name.trim() === name && !UNSAFE_SEGMENT.test(name)
}

/** A batch id of the contract (BATCH_ID_PATTERN) without `..`. */
export function isBatchId(id) {
  return typeof id === 'string' && BATCH_ID_PATTERN.test(id) && !id.includes('..')
}

/** Whether a pid names a live process (EPERM: alive, owned by someone else). Never probes pid <= 0. */
export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

// ---------------------------------------------------------------------------
// Journal: parse and fold (pure)
// ---------------------------------------------------------------------------

/**
 * Parse journal text. A line that is not one JSON object of this format
 * version (a torn last line, a fragment ended by the next append, a foreign
 * line) is skipped and counted.
 * @param {string} text
 * @returns {{ records: object[], skipped: number }}
 */
export function parseJournal(text) {
  const records = []
  let skipped = 0
  for (const line of String(text).split('\n')) {
    if (line === '') continue
    let value
    try {
      value = JSON.parse(line)
    } catch {
      skipped += 1
      continue
    }
    if (!isObject(value) || value.v !== FORMAT_VERSION || typeof value.op !== 'string') {
      skipped += 1
      continue
    }
    records.push(value)
  }
  return { records, skipped }
}

const UNIT_OPS = new Set(['unit-moved', 'unit-skipped', 'unit-failed', 'unit-restored', 'unit-restore-skipped', 'unit-restore-failed'])

/**
 * The state of a batch as a fold of its journal records over its manifest.
 * Every session starts in the store; unknown ops are ignored. `logs`: the
 * last log facts journaled for each session (`logs` lines: the log as it was
 * moved into the trash). `closed`: the last record is this batch's `closed`.
 * @param {{ batchId?: string, sessions: { id: string }[], units: { rootId: string }[] }} manifest
 * @param {object[]} records
 */
export function foldJournal(manifest, records) {
  const ids = new Set(manifest.sessions.map((s) => s.id))
  const roots = new Set(manifest.units.map((unit) => unit.rootId))
  const location = new Map(manifest.sessions.map((s) => [s.id, 'store']))
  const units = new Map()
  const steps = []
  const createdFolders = []
  const logs = new Map()
  let openOp = null
  const set = (id, where) => { if (ids.has(id)) location.set(id, where) }
  for (const record of records) {
    switch (record.op) {
      case 'begin': openOp = 'apply'; break
      case 'restore-start': openOp = 'restore'; break
      case 'purge-start': openOp = 'purge'; break
      case 'end': if (openOp === 'apply') openOp = null; break
      case 'restore-end': if (openOp === 'restore') openOp = null; break
      case 'purge-aborted': if (openOp === 'purge') openOp = null; break
      case 'moved': case 'restore-rolled-back': set(record.id, 'trash'); break
      case 'rolled-back': case 'restored': set(record.id, 'store'); break
      case 'recovered': if (LOCATIONS.includes(record.location)) set(record.id, record.location); break
      case 'folder-created':
        if (typeof record.workspaceDir === 'string' && !createdFolders.includes(record.workspaceDir)) createdFolders.push(record.workspaceDir)
        break
      case 'step':
        if (REGISTRY_STEPS.includes(record.step) && ids.has(record.id) && STEP_OUTCOMES.includes(record.outcome)) {
          steps.push(typeof record.error === 'string' ? { step: record.step, id: record.id, outcome: record.outcome, error: record.error }
            : { step: record.step, id: record.id, outcome: record.outcome })
        }
        break
      case 'logs':
        for (const item of Array.isArray(record.sessions) ? record.sessions : []) {
          if (isLogFacts(item) && ids.has(item.id)) logs.set(item.id, { name: item.name, revision: item.revision, sizeBytes: item.sizeBytes })
        }
        break
      default:
        if (UNIT_OPS.has(record.op) && roots.has(record.rootId)) units.set(record.rootId, record.op)
    }
  }
  const last = records.at(-1)
  const closed = last?.op === 'closed' && typeof last.batchId === 'string' && last.batchId === manifest.batchId
  return { location, openOp, units, steps, createdFolders, logs, closed }
}

/**
 * Whether the journal in the batch folder `dir` ends with this batch's
 * `closed` line: one read of the journal's tail through `fs` (open read-only
 * with O_NOFOLLOW, fstat, read, close), whatever the size of the batch. A torn
 * last line, a line after `closed` or a closed line of another batch id is not
 * closed. Never throws.
 */
function journalEndsClosed(fs, dir, batchId) {
  let fd
  try {
    fd = fs.openSync(path.join(dir, JOURNAL_FILE), READ_FLAGS)
  } catch {
    return false
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size < 2) return false
    const length = Math.min(stat.size, CLOSED_TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    const read = fs.readSync(fd, buffer, 0, length, stat.size - length)
    if (read !== length || buffer[length - 1] !== NEWLINE[0]) return false
    const text = buffer.toString('utf8', 0, length - 1)
    const start = text.lastIndexOf('\n')
    if (start < 0 && stat.size > length) return false
    const value = JSON.parse(text.slice(start + 1))
    return isObject(value) && value.v === FORMAT_VERSION && value.op === 'closed' && value.batchId === batchId
  } catch {
    return false
  } finally {
    try { fs.closeSync(fd) } catch { /* already closed */ }
  }
}

/**
 * Whether `<trashDir>/<batchId>` is a closed batch, for a caller that holds
 * neither the trash lock nor an engine (the Host's check before its recovery
 * at start: a trash that holds only closed batches is nothing to recover).
 * The folder is lstat'ed first: a symbolic link, a non-folder, a missing or
 * unreadable folder is not closed, so a recovery looks at it. Then the same
 * journal-tail read as the engine's (journalEndsClosed). A name that is not a
 * batch id (a `.purge-` or `.staging-` folder, `..`) is not a closed batch.
 * At most five fs calls, all through `fs`; reads only, never throws.
 * @param {object} fs node:fs-compatible sync API
 * @param {string} trashDir absolute trash folder
 * @param {string} batchId
 */
export function isClosedBatchFolder(fs, trashDir, batchId) {
  if (typeof trashDir !== 'string' || !path.isAbsolute(trashDir) || !isBatchId(batchId)) return false
  const dir = path.join(trashDir, batchId)
  try {
    const stat = fs.lstatSync(dir)
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false
  } catch {
    return false
  }
  return journalEndsClosed(fs, dir, batchId)
}

/** One entry of a `logs` line: a session id, the log file name, the revision file part and the size of the log. */
function isLogFacts(item) {
  return isObject(item) && isSafeSessionId(item.id) && isSafeSegment(item.name) && typeof item.revision === 'string'
    && REVISION_FILE_PART.test(item.revision) && isCount(item.sizeBytes)
}

/** Where a unit is: one place for all its members, `split` (store and trash), or `conflict`. */
function unitLocationOf(unit, fold) {
  const where = new Set(unit.memberIds.map((id) => fold.location.get(id)))
  return where.size === 1 ? [...where][0] : where.has('store') && where.has('trash') ? 'split' : 'conflict'
}

/**
 * What the Host needs to find the registry steps a batch still owes (src/service.js): each unit and
 * session with its journal location, the manifest's registry marks, the journaled registry steps.
 */
function detailOf(manifest, fold) {
  return {
    openOp: fold.openOp,
    units: manifest.units.map((unit) => ({ rootId: unit.rootId, memberIds: [...unit.memberIds], location: unitLocationOf(unit, fold) })),
    sessions: manifest.sessions.map((s) => ({ id: s.id, workspaceId: s.workspaceId, archived: s.archived, pinned: s.pinned, location: fold.location.get(s.id) })),
    steps: fold.steps,
  }
}
const NO_DETAIL = Object.freeze({ openOp: null, units: Object.freeze([]), sessions: Object.freeze([]), steps: Object.freeze([]) })

/** complete, needs-recovery (an open operation or a unit split between store and trash) or conflict (conflict, lost, unsafe entry). */
export function batchState(manifest, fold) {
  if (fold.openOp !== null) return 'needs-recovery'
  for (const unit of manifest.units) {
    const where = unit.memberIds.map((id) => fold.location.get(id))
    if (where.includes('store') && where.includes('trash')) return 'needs-recovery'
  }
  for (const s of manifest.sessions) {
    const where = fold.location.get(s.id)
    if (where === 'conflict' || where === 'lost' || s.unsafe) return 'conflict'
  }
  return 'complete'
}

/**
 * What a batch holds now: units wholly in trash; the sessions whose copy is in
 * the batch folder (in trash, or in conflict: a copy at the store place too)
 * and their manifest bytes. purge() deletes every copy in the batch folder, so
 * a conflict copy is counted: the Trash tab and the purge prompt name it.
 */
function heldOf(manifest, fold) {
  let units = 0
  let sessions = 0
  let bytes = 0
  for (const unit of manifest.units) if (unit.memberIds.every((id) => fold.location.get(id) === 'trash')) units += 1
  for (const s of manifest.sessions) {
    const where = fold.location.get(s.id)
    if (where === 'trash' || where === 'conflict') {
      sessions += 1
      bytes += s.bytes
    }
  }
  return { units, sessions, bytes }
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const PUBLIC_FIELDS = ['id', 'workspaceDir', 'workspaceId', 'parent', 'archived', 'pinned', 'bytes', 'source']
const publicEntry = (s) => Object.freeze(Object.fromEntries(PUBLIC_FIELDS.map((key) => [key, s[key]])))

/** Why an entry's paths are unsafe, or null: id and project folder are safe segments, source is exactly <sessionsRoot>/<workspaceDir>/<id>. */
function sessionProblem(s, sessionsRoot) {
  if (!isSafeSessionId(s.id)) return 'the session id is not one safe path segment'
  if (!isSafeSegment(s.workspaceDir)) return 'the project folder is not one safe path segment'
  if (s.source !== path.join(sessionsRoot, s.workspaceDir, s.id)) return 'the source is not <sessionsRoot>/<workspaceDir>/<id>'
  return null
}

function checkedEntry(raw, fail) {
  if (!isObject(raw)) fail('a session entry is not an object')
  const s = {
    id: raw.id, workspaceDir: raw.workspaceDir, workspaceId: raw.workspaceId ?? null, parent: raw.parent ?? null,
    archived: raw.archived, pinned: raw.pinned, bytes: raw.bytes, source: raw.source,
  }
  if (typeof s.id !== 'string' || s.id === '' || typeof s.workspaceDir !== 'string' || typeof s.source !== 'string') fail('id, workspaceDir and source must be strings')
  if (!nullableString(s.workspaceId) || !nullableString(s.parent)) fail('workspaceId and parent must be strings or null')
  if (typeof s.archived !== 'boolean' || typeof s.pinned !== 'boolean') fail('archived and pinned must be booleans')
  if (!isCount(s.bytes)) fail('bytes must be a non-negative integer')
  return s
}

/**
 * Validate a parsed manifest. Structure problems throw TrashError
 * `batch-not-found` (it is not a batch this engine wrote). An entry whose paths
 * are unsafe, or a manifest of another sessions tree, is kept with `unsafe`
 * set: those sessions are never moved, and their units are refused.
 */
function parseManifest(value, batchId, sessionsRoot) {
  const fail = (text) => { throw new TrashError(ERROR.batchNotFound, `batch ${batchId}: invalid manifest (${text})`) }
  if (!isObject(value) || value.v !== FORMAT_VERSION || value.kind !== MANIFEST_KIND) fail('unknown format')
  if (value.batchId !== batchId) fail('another batch id')
  if (!isCount(value.createdAt)) fail('createdAt')
  if (!Array.isArray(value.sessions) || !Array.isArray(value.units) || !Array.isArray(value.workspaceDirs)) fail('lists')
  const workspaceDirs = value.workspaceDirs.filter((name) => typeof name === 'string')
  const otherStore = value.sessionsRoot !== sessionsRoot
  const byId = new Map()
  const sessions = []
  for (const raw of value.sessions) {
    const s = checkedEntry(raw, fail)
    if (byId.has(s.id)) fail(`session ${s.id} is listed twice`)
    let problem = otherStore ? 'the manifest names another sessions tree' : sessionProblem(s, sessionsRoot)
    if (problem === null && !workspaceDirs.includes(s.workspaceDir)) problem = 'the project folder is not recorded in the manifest'
    const entry = Object.freeze({ ...s, unsafe: problem })
    byId.set(s.id, entry)
    sessions.push(entry)
  }
  const assigned = new Set()
  const units = []
  for (const raw of value.units) {
    if (!isObject(raw) || typeof raw.rootId !== 'string' || !Array.isArray(raw.memberIds) || raw.memberIds.length === 0) fail('a unit entry')
    if (raw.memberIds[0] !== raw.rootId) fail(`unit ${raw.rootId} does not start with its root`)
    for (const id of raw.memberIds) {
      if (!byId.has(id) || assigned.has(id)) fail(`unit ${raw.rootId} names an unknown or shared member`)
      assigned.add(id)
    }
    units.push(Object.freeze({
      rootId: raw.rootId, memberIds: Object.freeze([...raw.memberIds]), bytes: isCount(raw.bytes) ? raw.bytes : 0,
      workspaceId: nullableString(raw.workspaceId) ? raw.workspaceId : null,
    }))
  }
  if (assigned.size !== byId.size) fail('a session belongs to no unit')
  return Object.freeze({
    batchId, createdAt: value.createdAt, planId: typeof value.planId === 'string' ? value.planId : null, sessionsRoot: value.sessionsRoot,
    workspaceDirs: Object.freeze(workspaceDirs), sessions: Object.freeze(sessions), units: Object.freeze(units), byId,
  })
}

/** A refusal list from a precheck verdict; null, undefined and an empty list mean "go". */
function refusalsOf(verdict, sessionId) {
  if (verdict === null || verdict === undefined) return []
  if (typeof verdict === 'string') {
    if (!REFUSAL_CODES.includes(verdict)) throw new TypeError(`precheck returned an unknown refusal code: ${verdict}`)
    return [{ code: verdict, sessionId }]
  }
  if (isObject(verdict) && verdict.code === undefined && verdict.reasons === undefined) return []
  const list = Array.isArray(verdict) ? verdict : Array.isArray(verdict.reasons) ? verdict.reasons : [verdict]
  return list.map((reason) => {
    if (typeof reason === 'string' && REFUSAL_CODES.includes(reason)) return { code: reason, sessionId }
    if (!isObject(reason) || !REFUSAL_CODES.includes(reason.code)) throw new TypeError('precheck returned an unknown refusal')
    return { code: reason.code, sessionId: typeof reason.sessionId === 'string' && reason.sessionId !== '' ? reason.sessionId : sessionId }
  })
}

/** A release function a precheck verdict carries: the verdict itself, or its `release` member. */
function releaseOf(verdict) {
  if (typeof verdict === 'function') return verdict
  if (isObject(verdict) && typeof verdict.release === 'function') return verdict.release
  return null
}

function stepRecord(step) {
  if (!isObject(step) || !REGISTRY_STEPS.includes(step.step) || !isSafeSessionId(step.id) || !STEP_OUTCOMES.includes(step.outcome)) {
    throw new TypeError(`a registry step needs step (${REGISTRY_STEPS.join(', ')}), a session id and an outcome (${STEP_OUTCOMES.join(', ')})`)
  }
  if (step.error !== undefined && (typeof step.error !== 'string' || !ERROR_TOKEN.test(step.error))) throw new TypeError('a step error is a short code')
  return step.error === undefined ? { op: 'step', step: step.step, id: step.id, outcome: step.outcome }
    : { op: 'step', step: step.step, id: step.id, outcome: step.outcome, error: step.error }
}

function logsRecord(list) {
  if (!Array.isArray(list) || list.length === 0 || !list.every(isLogFacts)) {
    throw new TypeError('log facts need a list of { id, name (the log file), revision (dev:ino:size:mtimeNs:ctimeNs), sizeBytes }')
  }
  return { op: 'logs', sessions: list.map((item) => ({ id: item.id, name: item.name, revision: item.revision, sizeBytes: item.sizeBytes })) }
}

function isLockRecord(value) {
  return isObject(value) && value.v === FORMAT_VERSION && Number.isSafeInteger(value.pid) && value.pid > 0 && isCount(value.startedAt)
    && isCount(value.acquiredAt) && typeof value.host === 'string' && typeof value.token === 'string' && LOCK_TOKEN.test(value.token)
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * Create the trash engine for one sessions tree and one trash folder. Creating
 * it touches no file.
 * @param {object} options
 * @param {{ trashDir: string, allowPermanentDelete: boolean }} options.config resolved config (config.js resolveConfig)
 * @param {string} options.sessionsRoot absolute sessions tree (<sessionsRoot>/<workspaceDir>/<id>/)
 * @param {object} [options.fs] node:fs-compatible sync API (default node:fs); every call goes through it
 * @param {() => number} [options.now] clock in ms
 * @param {(size: number) => Buffer} [options.random] random bytes (lock tokens, batch ids)
 * @param {{ pid: number, startedAt: number, host: string }} [options.identity] recorded in .lock
 * @param {(pid: number) => boolean} [options.isAlive] liveness of a recorded pid
 * @param {number | null} [options.uid] owner every trash folder must have (default this process's uid)
 */
export function createTrash(options) {
  if (!isObject(options)) throw new TypeError('createTrash needs options')
  const { config } = options
  if (!isObject(config) || typeof config.trashDir !== 'string' || typeof config.allowPermanentDelete !== 'boolean') {
    throw new TypeError('createTrash needs a resolved config with trashDir and allowPermanentDelete')
  }
  const trashDir = checkedPath(config.trashDir, path, 'trashDir')
  const sessionsRoot = checkedPath(options.sessionsRoot, path, 'sessionsRoot')
  const allowPermanentDelete = config.allowPermanentDelete
  const fs = options.fs ?? nodeFs
  const now = options.now ?? Date.now
  const random = options.random ?? randomBytes
  const isAlive = options.isAlive ?? processAlive
  const identity = Object.freeze({
    pid: options.identity?.pid ?? process.pid,
    startedAt: options.identity?.startedAt ?? Math.round(performance.timeOrigin),
    host: options.identity?.host ?? os.hostname(),
  })
  const uid = options.uid !== undefined ? options.uid : (typeof process.getuid === 'function' ? process.getuid() : null)

  /** Batches with an open handle in this instance; recover(), restore() and purge() leave them alone. */
  const active = new Set()
  let pinnedStore = null
  let lockDepth = 0
  let lockToken = null
  /** Tokens of locks this instance created but could not release; it may take them over. */
  const leakedTokens = new Set()

  const timestamp = () => {
    const value = now()
    if (!isCount(value)) throw new TypeError('now() must return integer milliseconds')
    return value
  }
  const record = (fields) => ({ v: FORMAT_VERSION, ts: timestamp(), ...fields })
  const sourceOf = (s) => path.join(sessionsRoot, s.workspaceDir, s.id)
  const destOf = (dir, s) => path.join(dir, SESSIONS_FOLDER, s.workspaceDir, s.id)

  // --- file helpers (all through the injected fs) --------------------------

  function lstatOrNull(target) {
    try {
      return fs.lstatSync(target)
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      if (error?.code === 'ENOTDIR' || error?.code === 'ELOOP') throw unsafe(`${target} cannot be reached (${error.code})`)
      throw error
    }
  }

  function ownerProblem(stat) {
    if (uid !== null && stat.uid !== uid) return `belongs to another user (uid ${stat.uid})`
    if ((stat.mode & 0o022) !== 0) return `is writable by group or others (mode 0${(stat.mode & 0o777).toString(8)})`
    return null
  }

  /** A plugin folder: present, a directory, not a symlink, ours, not writable by others. */
  function ownFolder(target, stat = lstatOrNull(target)) {
    if (stat === null) throw unsafe(`${target} is missing`)
    if (stat.isSymbolicLink()) throw unsafe(`${target} is a symbolic link`)
    if (!stat.isDirectory()) throw unsafe(`${target} is not a directory`)
    const problem = ownerProblem(stat)
    if (problem !== null) throw unsafe(`${target} ${problem}`)
    return stat
  }

  /** Create one folder (never its parents) with mode 0700. */
  function makeFolder(target) {
    fs.mkdirSync(target, { mode: DIR_MODE })
    const stat = fs.lstatSync(target)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafe(`${target} is not the folder just created`)
    if ((stat.mode & 0o777) !== DIR_MODE) fs.chmodSync(target, DIR_MODE)
    return stat
  }

  function openNoFollow(file, flags, mode) {
    try {
      return fs.openSync(file, flags, mode)
    } catch (error) {
      if (error?.code === 'ELOOP' || error?.code === 'EMLINK' || error?.code === 'EFTYPE') throw unsafe(`${file} is a symbolic link`)
      throw error
    }
  }

  /** The bytes of a regular file opened with O_NOFOLLOW, or null when it is missing. */
  function readOptional(file, cap) {
    let fd
    try {
      fd = openNoFollow(file, READ_FLAGS)
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
    try {
      const stat = fs.fstatSync(fd)
      if (!stat.isFile()) throw unsafe(`${file} is not a regular file`)
      if (stat.size > cap) throw new TrashError(ERROR.trashUnusable, `${file} is larger than ${cap} bytes`)
      const buffer = Buffer.alloc(stat.size)
      let offset = 0
      while (offset < buffer.length) {
        const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset)
        if (read === 0) break
        offset += read
      }
      return buffer.subarray(0, offset)
    } finally {
      fs.closeSync(fd)
    }
  }

  /** Create a new file ('wx' + O_NOFOLLOW, 0600), write it whole and fsync it. */
  function writeExclusive(file, text) {
    const buffer = Buffer.from(text, 'utf8')
    const fd = openNoFollow(file, CREATE_FLAGS, FILE_MODE)
    try {
      const stat = fs.fstatSync(fd)
      if ((stat.mode & 0o777) !== FILE_MODE) fs.fchmodSync(fd, FILE_MODE)
      let offset = 0
      while (offset < buffer.length) {
        const written = fs.writeSync(fd, buffer, offset, buffer.length - offset)
        if (!(written > 0)) throw new TrashError(ERROR.trashUnusable, `short write to ${file}`)
        offset += written
      }
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  }

  /**
   * Append one JSON line with a single O_APPEND|O_NOFOLLOW write, then fsync.
   * A torn last line (no newline) is ended first, in the same write, so the
   * new line always starts on its own.
   */
  function appendLine(file, line) {
    const body = Buffer.from(`${JSON.stringify(line)}\n`, 'utf8')
    const fd = openNoFollow(file, APPEND_FLAGS, FILE_MODE)
    try {
      const stat = fs.fstatSync(fd)
      if (!stat.isFile()) throw unsafe(`${file} is not a regular file`)
      const problem = ownerProblem(stat)
      if (problem !== null) throw unsafe(`${file} ${problem}`)
      if ((stat.mode & 0o777) !== FILE_MODE) fs.fchmodSync(fd, FILE_MODE)
      let buffer = body
      if (stat.size > 0) {
        const last = Buffer.alloc(1)
        fs.readSync(fd, last, 0, 1, stat.size - 1)
        if (last[0] !== NEWLINE[0]) buffer = Buffer.concat([NEWLINE, body])
      }
      const written = fs.writeSync(fd, buffer, 0, buffer.length)
      if (written !== buffer.length) {
        if (written > 0) {
          try { fs.writeSync(fd, NEWLINE, 0, 1) } catch { /* readers skip the fragment either way */ }
        }
        throw new TrashError(ERROR.trashUnusable, `short journal append to ${file}`)
      }
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  }

  function fsyncFolder(dir) {
    const fd = fs.openSync(dir, FOLDER_FLAGS)
    try {
      try {
        fs.fsyncSync(fd)
      } catch (error) {
        if (!FSYNC_UNSUPPORTED.has(error?.code)) throw error
      }
    } finally {
      fs.closeSync(fd)
    }
  }

  // --- roots ---------------------------------------------------------------

  /** The real sessions tree, pinned at first use: it must not resolve elsewhere later. */
  function storeRoot() {
    let real
    try {
      real = fs.realpathSync(sessionsRoot)
    } catch (error) {
      throw unsafe(`the sessions tree cannot be resolved (${errorCode(error)})`)
    }
    if (pinnedStore === null) pinnedStore = real
    else if (real !== pinnedStore) throw unsafe('the sessions tree resolves to another folder than before')
    const stat = fs.lstatSync(real)
    if (!stat.isDirectory()) throw unsafe('the sessions tree is not a directory')
    return { real, dev: stat.dev }
  }

  /** Real path of the deepest existing ancestor of `target`, joined with the missing tail. */
  function projectedReal(target) {
    const tail = []
    let current = target
    for (;;) {
      try {
        return path.join(fs.realpathSync(current), ...tail)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw unsafe(`${current} cannot be resolved (${errorCode(error)})`)
        const parent = path.dirname(current)
        if (parent === current) throw unsafe(`${target} cannot be resolved`)
        tail.unshift(path.basename(current))
        current = parent
      }
    }
  }

  /**
   * Check the trash folder: outside the sessions tree (and the reverse), no
   * symlinked component anywhere in its path, a real folder of ours on the
   * store's device. With `create`, a missing folder (and its missing parents)
   * is created 0700, after the overlap and symlink checks. Returns the lstat
   * of the folder, or null when it is missing and `create` is false.
   */
  function trashRoot({ create }) {
    const store = storeRoot()
    const projected = projectedReal(trashDir)
    if (isWithin(store.real, projected)) throw unsafe('the trash folder is inside the sessions tree')
    if (isWithin(projected, store.real)) throw unsafe('the sessions tree is inside the trash folder')
    if (projected !== trashDir) throw unsafe('the trash folder path has a symlinked component')
    let stat = lstatOrNull(trashDir)
    if (stat === null) {
      if (!create) return null
      fs.mkdirSync(trashDir, { recursive: true, mode: DIR_MODE })
      stat = lstatOrNull(trashDir)
    }
    ownFolder(trashDir, stat)
    if (fs.realpathSync(trashDir) !== trashDir) throw unsafe('the trash folder path has a symlinked component')
    if (stat.dev !== store.dev) {
      throw new TrashError(ERROR.trashUnusable, 'the trash folder is on another device than the sessions tree (cross-device)', { reason: 'cross-device' })
    }
    return stat
  }

  function batchFolder(batchId) {
    if (!isBatchId(batchId)) throw unsafe(`not a batch id: ${JSON.stringify(batchId)}`)
    return path.join(trashDir, batchId)
  }

  /** Read and validate the manifest in `dir`: present, a regular file, never through a symlink. */
  function readManifest(dir, batchId) {
    const file = path.join(dir, MANIFEST_FILE)
    const stat = lstatOrNull(file)
    if (stat === null) throw new TrashError(ERROR.batchNotFound, `batch ${batchId} has no manifest`)
    if (stat.isSymbolicLink() || !stat.isFile()) throw unsafe(`the manifest of batch ${batchId} is not a regular file`)
    const bytes = readOptional(file, MAX_MANIFEST_BYTES)
    if (bytes === null) throw new TrashError(ERROR.batchNotFound, `batch ${batchId} has no manifest`)
    let value
    try {
      value = JSON.parse(bytes.toString('utf8'))
    } catch {
      throw new TrashError(ERROR.batchNotFound, `the manifest of batch ${batchId} is unreadable`)
    }
    return parseManifest(value, batchId, sessionsRoot)
  }

  /** A batch folder after its checks (not a symlink, ours, resolves to itself, manifest present), or null when missing. */
  function loadBatchAt(dir, batchId) {
    const stat = lstatOrNull(dir)
    if (stat === null) return null
    ownFolder(dir, stat)
    if (fs.realpathSync(dir) !== dir) throw unsafe(`batch ${batchId} does not resolve inside the trash folder`)
    return { batchId, dir, manifest: readManifest(dir, batchId) }
  }

  function loadBatch(batchId) {
    const dir = batchFolder(batchId)
    if (trashRoot({ create: false }) === null) throw new TrashError(ERROR.batchNotFound, `no batch ${batchId}`)
    const batch = loadBatchAt(dir, batchId)
    if (batch === null) throw new TrashError(ERROR.batchNotFound, `no batch ${batchId}`)
    return batch
  }

  function readFold(batch) {
    const bytes = readOptional(path.join(batch.dir, JOURNAL_FILE), MAX_JOURNAL_BYTES)
    const { records, skipped } = parseJournal(bytes === null ? '' : bytes.toString('utf8'))
    return { ...foldJournal(batch.manifest, records), skippedLines: skipped }
  }

  const journalOf = (dir) => (fields) => appendLine(path.join(dir, JOURNAL_FILE), record(fields))

  /**
   * Whether the last journal line of the batch in `dir` is its `closed` line
   * (journalEndsClosed: one read of the journal's tail, four fs calls,
   * whatever the size of the batch). Never throws.
   */
  const closedAt = (dir, batchId) => journalEndsClosed(fs, dir, batchId)
  const tryJournal = (journal, fields) => {
    try {
      journal(fields)
      return true
    } catch {
      return false
    }
  }

  // --- the trash mutex -------------------------------------------------------

  const lockFile = () => path.join(trashDir, LOCK_FILE)
  const releasedFile = () => path.join(trashDir, RELEASED_LOCK_FILE)

  /** The current .lock: its bytes, its record (null when unreadable), mtime and inode. Never follows a symlink. */
  function readLock() {
    const file = lockFile()
    const stat = lstatOrNull(file)
    if (stat === null) return null
    if (stat.isSymbolicLink() || !stat.isFile()) throw unsafe('the trash lock is not a regular file')
    let raw
    try {
      raw = readOptional(file, MAX_LOCK_BYTES)
    } catch (error) {
      if (!(error instanceof TrashError)) throw error
      raw = Buffer.alloc(0)
    }
    if (raw === null) return null
    let value = null
    try {
      value = JSON.parse(raw.toString('utf8'))
    } catch { /* unreadable */ }
    return { raw, value: isLockRecord(value) ? value : null, mtimeMs: stat.mtimeMs, ino: stat.ino }
  }

  /** Why a present lock is stale, or null while its holder may be alive. */
  function staleReason(lock) {
    const holder = lock.value
    if (holder === null) return timestamp() - lock.mtimeMs >= LOCK_GRACE_MS ? 'unreadable' : null
    if (leakedTokens.has(holder.token)) return 'released-late'
    if (holder.host !== identity.host) return null
    if (holder.pid === identity.pid) return holder.startedAt === identity.startedAt ? null : 'pid-reused'
    return isAlive(holder.pid) ? null : 'dead-pid'
  }

  const busy = (message, holder) => new TrashError(ERROR.busy, message, holder ? { pid: holder.pid, host: holder.host } : undefined)

  /** Exclusive create of a lock file; on a failure after the create, move it aside so it blocks nobody. */
  function createLockFile(file, text, token) {
    try {
      writeExclusive(file, text)
    } catch (error) {
      if (error?.code !== 'EEXIST' && !(error instanceof PathError)) {
        leakedTokens.add(token)
        if (file !== lockFile()) {
          try { fs.renameSync(file, releasedFile()) } catch { /* a temporary file is left */ }
        }
      }
      throw error
    }
  }

  function takeOver(current, text, token, reason) {
    const temp = path.join(trashDir, `${LOCK_FILE}.${token}.tmp`)
    createLockFile(temp, text, token)
    const again = readLock()
    if (again === null || again.ino !== current.ino || !again.raw.equals(current.raw)) {
      try { fs.renameSync(temp, releasedFile()) } catch { /* a temporary file is left */ }
      throw busy('another process replaced the stale trash lock first')
    }
    fs.renameSync(temp, lockFile())
    const mine = readLock()
    if (mine?.value?.token !== token) throw busy('another process replaced the stale trash lock first')
    const stale = current.value
    return { pid: stale?.pid ?? null, startedAt: stale?.startedAt ?? null, acquiredAt: stale?.acquiredAt ?? null, host: stale?.host ?? null, reason }
  }

  function releaseLock() {
    if (lockDepth === 0) return true
    lockDepth -= 1
    if (lockDepth > 0) return true
    const token = lockToken
    lockToken = null
    try {
      const current = readLock()
      if (current?.value?.token !== token) return false
      fs.renameSync(lockFile(), releasedFile())
      return true
    } catch {
      leakedTokens.add(token)
      return false
    }
  }

  function lockHandle(replaced) {
    let released = false
    return Object.freeze({
      replaced,
      release() {
        if (released) return true
        released = true
        return releaseLock()
      },
    })
  }

  /**
   * Take the cross-process trash mutex <trashDir>/.lock (re-entrant within
   * this instance). A live holder gives TrashError `busy`. A stale lock (dead
   * pid, a reused pid of this host, or an unreadable lock older than
   * LOCK_GRACE_MS) is replaced and the replacement is journaled in
   * <trashDir>/.journal.jsonl; `replaced` describes it. A lock of another host
   * is never judged stale.
   */
  function acquire() {
    if (lockDepth > 0) {
      assertHeld()
      lockDepth += 1
      return lockHandle(null)
    }
    trashRoot({ create: true })
    const token = random(16).toString('hex')
    const text = `${JSON.stringify({ v: FORMAT_VERSION, pid: identity.pid, startedAt: identity.startedAt, acquiredAt: timestamp(), host: identity.host, token })}\n`
    let replaced = null
    for (let attempt = 0; ; attempt += 1) {
      try {
        createLockFile(lockFile(), text, token)
        break
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
      const current = readLock()
      if (current === null) {
        if (attempt < 2) continue
        throw busy('the trash lock keeps changing')
      }
      const reason = staleReason(current)
      if (reason === null) throw busy(`the trash is locked by pid ${current.value?.pid ?? 'unknown'}`, current.value)
      replaced = takeOver(current, text, token, reason)
      break
    }
    lockDepth = 1
    lockToken = token
    if (replaced !== null) {
      try {
        appendLine(path.join(trashDir, TRASH_JOURNAL_FILE), record({ op: 'lock-replaced', stale: replaced, by: { pid: identity.pid, host: identity.host } }))
      } catch (error) {
        releaseLock()
        throw error
      }
    }
    return lockHandle(replaced)
  }

  /** Before every rename: this instance still holds the lock (its token is in .lock). */
  function assertHeld() {
    if (lockDepth === 0 || lockToken === null) throw busy('the trash lock is not held')
    const current = readLock()
    if (current?.value?.token !== lockToken) {
      lockDepth = 0
      lockToken = null
      throw busy('the trash lock was taken over by another process')
    }
  }

  function withLock(fn) {
    const lock = acquire()
    try {
      return fn()
    } finally {
      lock.release()
    }
  }

  // --- recovery --------------------------------------------------------------

  /**
   * Where recover() places a session of a batch: what observe() finds, except
   * when the journal places the session in the store and it is in neither
   * place. Then it stays `store`. This batch did not hold it: it was never
   * moved, or it was restored or rolled back, and it then left the store by
   * other means (a newer batch pruned it again, or the host took it away).
   * Only a session the journal places in this batch's trash (or in conflict)
   * can be `lost`. An unsafe entry is never looked at: it keeps its journal place.
   */
  function placeOf(dir, s, journaled) {
    if (s.unsafe) return journaled
    const found = observe(dir, s)
    return found === 'lost' && journaled === 'store' ? 'store' : found
  }

  /** Where a session is on disk. A symlink or a non-folder at either place, or a symlinked folder above it, is `conflict`. */
  function observe(dir, s) {
    try {
      const storeParent = lstatOrNull(path.join(sessionsRoot, s.workspaceDir))
      const trashParent = lstatOrNull(path.join(dir, SESSIONS_FOLDER, s.workspaceDir))
      for (const parent of [storeParent, trashParent]) {
        if (parent !== null && (parent.isSymbolicLink() || !parent.isDirectory())) return 'conflict'
      }
      const source = storeParent === null ? null : lstatOrNull(sourceOf(s))
      const dest = trashParent === null ? null : lstatOrNull(destOf(dir, s))
      if (source !== null && dest !== null) return 'conflict'
      if (source === null && dest === null) return 'lost'
      const found = source ?? dest
      if (found.isSymbolicLink() || !found.isDirectory()) return 'conflict'
      return source !== null ? 'store' : 'trash'
    } catch (error) {
      if (error instanceof PathError) return 'conflict'
      throw error
    }
  }

  /**
   * Create the project folder <sessionsRoot>/<workspaceDir> when it is
   * missing and the manifest recorded it; journal that this plugin created
   * it. Never creates the sessions tree or anything above the project folder.
   */
  function ensureStoreFolder(manifest, s, journal) {
    const folder = path.join(sessionsRoot, s.workspaceDir)
    const stat = lstatOrNull(folder)
    if (stat !== null) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafe(`${folder} is not a real folder`)
      return stat
    }
    if (!manifest.workspaceDirs.includes(s.workspaceDir)) throw unsafe(`${folder} was not recorded at prune time`)
    const created = makeFolder(folder)
    journal({ op: 'folder-created', workspaceDir: s.workspaceDir })
    return created
  }

  function recoverBatch(batch) {
    const { manifest, dir, batchId } = batch
    const sessionsStat = lstatOrNull(path.join(dir, SESSIONS_FOLDER))
    if (sessionsStat !== null) ownFolder(path.join(dir, SESSIONS_FOLDER), sessionsStat)
    const fold = readFold(batch)
    const journal = journalOf(dir)
    let appended = 0
    let moved = 0
    const failures = []
    const note = (fields) => {
      journal(fields)
      appended += 1
    }
    const observed = new Map()
    for (const s of manifest.sessions) observed.set(s.id, placeOf(dir, s, fold.location.get(s.id)))
    // A unit split between store and trash is made whole in the store: only renames toward the store.
    for (const unit of manifest.units) {
      const where = unit.memberIds.map((id) => observed.get(id))
      if (!where.includes('store') || !where.includes('trash')) continue
      for (const id of unit.memberIds) {
        const s = manifest.byId.get(id)
        if (observed.get(id) !== 'trash' || s.unsafe) continue
        try {
          ensureStoreFolder(manifest, s, note)
          if (lstatOrNull(sourceOf(s)) !== null) {
            observed.set(id, 'conflict')
            continue
          }
          fs.renameSync(destOf(dir, s), sourceOf(s))
        } catch (error) {
          failures.push({ id, code: errorCode(error) })
          continue
        }
        observed.set(id, 'store')
        moved += 1
        fold.location.set(id, 'store')
        note({ op: 'recovered', id, location: 'store', moved: true })
      }
    }
    for (const s of manifest.sessions) {
      const where = observed.get(s.id)
      if (where !== undefined && fold.location.get(s.id) !== where) {
        fold.location.set(s.id, where)
        note({ op: 'recovered', id: s.id, location: where })
      }
    }
    if (fold.openOp !== null) {
      note({ op: fold.openOp === 'apply' ? 'end' : fold.openOp === 'restore' ? 'restore-end' : 'purge-aborted', recovered: true })
      fold.openOp = null
    }
    if (appended > 0) journal({ op: 'recover', appended, moved })
    const ids = (where) => manifest.sessions.filter((s) => fold.location.get(s.id) === where).map((s) => s.id)
    return {
      batchId, state: batchState(manifest, fold), appended, moved, conflicts: ids('conflict'), lost: ids('lost'),
      unsafe: manifest.sessions.filter((s) => s.unsafe).map((s) => s.id), failures,
    }
  }

  /**
   * Reconcile every batch with the disk. Never deletes. Returns per batch the
   * state, the number of journal lines appended and of sessions renamed back
   * to the store, the conflicting and lost ids; plus the purge folders
   * (`tombstones`: finish them with purge()), staging folders (`orphans`: a
   * crash before the batch existed; they hold no session) and batches that
   * failed their checks (`problems`). A closed batch is skipped after one read
   * of its journal's tail and only counted (`closed`). A second run with no
   * change in between appends nothing and renames nothing.
   */
  function recover() {
    return withLock(() => {
      const report = { batches: [], tombstones: [], orphans: [], problems: [], closed: 0 }
      if (trashRoot({ create: false }) === null) return report
      for (const name of fs.readdirSync(trashDir).sort()) {
        if (isBatchId(name)) {
          if (active.has(name)) continue
          if (closedAt(path.join(trashDir, name), name)) {
            report.closed += 1
            continue
          }
          let batch
          try {
            batch = loadBatchAt(path.join(trashDir, name), name)
            if (batch !== null) report.batches.push(recoverBatch(batch))
          } catch (error) {
            if (!(error instanceof PathError) && !(error instanceof TrashError && error.code === ERROR.batchNotFound)) throw error
            report.problems.push({ name, code: error.code })
          }
        } else if (name.startsWith(PURGE_PREFIX) && isBatchId(name.slice(PURGE_PREFIX.length))) {
          report.tombstones.push(name.slice(PURGE_PREFIX.length))
        } else if (name.startsWith(STAGING_PREFIX) && isBatchId(name.slice(STAGING_PREFIX.length))) {
          report.orphans.push(name)
        }
      }
      return report
    })
  }

  // --- apply: batches and moves ------------------------------------------------

  function checkIntent(intent) {
    const fail = (text) => { throw new TypeError(`createBatch: ${text}`) }
    if (!isObject(intent) || !Array.isArray(intent.units) || !Array.isArray(intent.sessions)) fail('needs { units, sessions }')
    const planId = intent.planId ?? null
    if (planId !== null && (typeof planId !== 'string' || planId === '' || planId.length > 128)) fail('planId must be a short string')
    const byId = new Map()
    for (const raw of intent.sessions) {
      const s = checkedEntry(raw, fail)
      if (byId.has(s.id)) fail(`session ${s.id} is listed twice`)
      byId.set(s.id, s)
    }
    const assigned = new Set()
    const accepted = []
    const refused = []
    for (const raw of intent.units) {
      if (!isObject(raw) || typeof raw.rootId !== 'string' || !Array.isArray(raw.memberIds) || !raw.memberIds.includes(raw.rootId)) {
        fail('a unit needs a rootId and memberIds that include it')
      }
      const memberIds = [raw.rootId, ...raw.memberIds.filter((id) => id !== raw.rootId)]
      for (const id of memberIds) {
        if (!byId.has(id)) fail(`unit ${raw.rootId} names an unknown session ${id}`)
        if (assigned.has(id)) fail(`session ${id} is in two units`)
        assigned.add(id)
      }
      const members = memberIds.map((id) => byId.get(id))
      const reasons = members.filter((s) => sessionProblem(s, sessionsRoot) !== null).map((s) => ({ code: 'path-unsafe', sessionId: s.id }))
      if (reasons.length > 0) refused.push({ rootId: raw.rootId, reasons })
      else {
        accepted.push({
          rootId: raw.rootId, memberIds, members, bytes: members.reduce((sum, s) => sum + s.bytes, 0), workspaceId: byId.get(raw.rootId).workspaceId,
        })
      }
    }
    if (assigned.size !== byId.size) fail('every session must belong to exactly one unit')
    return { planId, accepted, refused }
  }

  function newBatchId(createdAt) {
    const stamp = new Date(createdAt).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
    const id = `b-${stamp}-${random(4).toString('hex')}`
    if (!isBatchId(id)) throw new TypeError(`cannot form a batch id from ${createdAt}`)
    return id
  }

  /** The ApplyResult of a batch (valid for contract assertApplyResult). */
  function applyResult(batchId, manifestUnits, outcomes, refused) {
    let units = 0
    let sessions = 0
    let bytes = 0
    let split = false
    let conflict = false
    const skipped = []
    const warnings = []
    for (const unit of manifestUnits) {
      const outcome = outcomes.get(unit.rootId)
      if (outcome === undefined) {
        skipped.push({ rootId: unit.rootId, reasons: [{ code: 'changed', sessionId: unit.rootId }] })
        continue
      }
      if (outcome.outcome === 'moved') {
        units += 1
        sessions += outcome.moved
        bytes += outcome.bytes
        continue
      }
      skipped.push({ rootId: unit.rootId, reasons: outcome.reasons })
      if (outcome.split) {
        split = true
        warnings.push({ code: 'recovery-needed', sessionId: unit.rootId })
      }
      if (outcome.reasons.some((reason) => reason.code === 'conflict')) conflict = true
    }
    skipped.push(...refused)
    const state = split ? 'needs-recovery' : conflict ? 'conflict' : skipped.length > 0 ? 'partial' : 'complete'
    return { batchId, trashDir, state, moved: { units, sessions, bytes }, skipped, warnings }
  }

  /**
   * Move one unit's members into the trash, all or nothing. Before each
   * rename: the path checks (the destination must not exist), the lock check,
   * then `precheck(entry)`, then only the lstat re-check of the project folder
   * and the session folder (still the folders the checks saw: see
   * swapProblem), then the renameSync. A failure or refusal renames the moved
   * members back. Every release a precheck returned runs at the end, after the
   * last rename or rollback rename of the unit.
   */
  function moveMembers(ctx, unit, precheck) {
    const { dir, manifest, journal } = ctx
    const moved = []
    const releases = []
    let rolledBack = false
    const rollback = () => {
      rolledBack = true
      let split = false
      for (const s of [...moved].reverse()) {
        try {
          if (lstatOrNull(sourceOf(s)) !== null) throw unsafe(`${sourceOf(s)} is occupied`)
          fs.renameSync(destOf(dir, s), sourceOf(s))
        } catch (error) {
          split = true
          tryJournal(journal, { op: 'rollback-failed', id: s.id, error: errorCode(error) })
          continue
        }
        moved.splice(moved.indexOf(s), 1)
        tryJournal(journal, { op: 'rolled-back', id: s.id })
      }
      return split
    }
    const stop = (reasons, error = null) => {
      const split = rollback()
      tryJournal(journal, error === null ? { op: 'unit-skipped', rootId: unit.rootId, reasons } : { op: 'unit-failed', rootId: unit.rootId, reasons, error })
      const outcome = error === null || error === 'precheck-threw' ? 'skipped' : 'failed'
      return { rootId: unit.rootId, outcome: split ? 'failed' : outcome, moved: moved.length, bytes: 0, reasons, error, split }
    }
    // The lstat of the project folder and of the session folder that the checks of the current member saw.
    let checked = null
    const memberProblem = (s) => {
      checked = null
      if (s.unsafe) return 'path-unsafe'
      const storeParent = lstatOrNull(path.join(sessionsRoot, s.workspaceDir))
      if (storeParent === null) return 'no-location'
      if (storeParent.isSymbolicLink() || !storeParent.isDirectory()) return 'path-unsafe'
      const source = lstatOrNull(sourceOf(s))
      if (source === null) return 'no-location'
      if (source.isSymbolicLink() || !source.isDirectory()) return 'path-unsafe'
      const parent = path.join(dir, SESSIONS_FOLDER, s.workspaceDir)
      const target = lstatOrNull(parent) ?? makeFolder(parent)
      if (target.isSymbolicLink() || !target.isDirectory()) return 'path-unsafe'
      if (lstatOrNull(destOf(dir, s)) !== null) return 'conflict'
      if (source.dev !== target.dev) return 'cross-device'
      checked = { storeParent, source }
      return null
    }
    /**
     * The re-check after the precheck, right before the rename: the project
     * folder and the session folder must still be the real folders the checks
     * saw (a directory, not a link, same device, inode and owner). The precheck
     * probes the session lock inside the folder, and another process can swap
     * the folder for a link meanwhile; rename(2) would then move the link into
     * the trash and leave the data at its target. A folder that is gone is
     * `no-location`; anything else is `path-unsafe`.
     */
    const swapProblem = (s) => {
      for (const [folder, seen] of [[path.join(sessionsRoot, s.workspaceDir), checked.storeParent], [sourceOf(s), checked.source]]) {
        const now = lstatOrNull(folder)
        if (now === null) return 'no-location'
        if (now.isSymbolicLink() || !now.isDirectory() || now.dev !== seen.dev || now.ino !== seen.ino || now.uid !== seen.uid) return 'path-unsafe'
      }
      return null
    }
    try {
      try {
        trashRoot({ create: false })
        ownFolder(dir)
        if (fs.realpathSync(dir) !== dir) throw unsafe(`batch ${ctx.batchId} does not resolve inside the trash folder`)
        ownFolder(path.join(dir, SESSIONS_FOLDER))
      } catch (error) {
        if (error instanceof PathError) return stop([{ code: 'path-unsafe', sessionId: unit.rootId }])
        throw error
      }
      for (const s of unit.memberIds.map((id) => manifest.byId.get(id))) {
        let problem
        try {
          problem = memberProblem(s)
        } catch (error) {
          if (error instanceof PathError) problem = 'path-unsafe'
          else return stop([{ code: 'changed', sessionId: s.id }], errorCode(error))
        }
        if (problem !== null) return stop([{ code: problem, sessionId: s.id }])
        try {
          assertHeld()
        } catch (error) {
          stop([{ code: 'changed', sessionId: s.id }], 'lock-lost')
          throw error
        }
        let verdict
        try {
          verdict = precheck(ctx.entries.get(s.id))
        } catch {
          return stop([{ code: 'changed', sessionId: s.id }], 'precheck-threw')
        }
        const release = releaseOf(verdict)
        if (release !== null) releases.push(release)
        if (verdict !== null && typeof verdict === 'object' && typeof verdict.then === 'function') {
          stop([{ code: 'changed', sessionId: s.id }], 'precheck-async')
          throw new TypeError('precheck must be synchronous: it returned a promise')
        }
        let reasons
        try {
          reasons = typeof verdict === 'function' ? [] : refusalsOf(verdict, s.id)
        } catch (error) {
          stop([{ code: 'changed', sessionId: s.id }], 'precheck-invalid')
          throw error
        }
        if (reasons.length > 0) return stop(reasons)
        // The folders are checked again right after the precheck and right before the rename (as restore checks its destination).
        let swapped
        try {
          swapped = swapProblem(s)
        } catch (error) {
          if (error instanceof PathError) swapped = 'path-unsafe'
          else return stop([{ code: 'changed', sessionId: s.id }], errorCode(error))
        }
        if (swapped !== null) return stop([{ code: swapped, sessionId: s.id }])
        try {
          fs.renameSync(sourceOf(s), destOf(dir, s))
        } catch (error) {
          const code = errorCode(error)
          if (code === 'EXDEV') return stop([{ code: 'cross-device', sessionId: s.id }])
          if (code === 'ENOENT') return stop([{ code: 'no-location', sessionId: s.id }])
          if (code === 'EEXIST' || code === 'ENOTEMPTY') return stop([{ code: 'conflict', sessionId: s.id }])
          return stop([{ code: 'changed', sessionId: s.id }], code)
        }
        moved.push(s)
        try {
          journal({ op: 'moved', id: s.id })
        } catch (error) {
          stop([{ code: 'changed', sessionId: s.id }], errorCode(error))
          throw new TrashError(ERROR.trashUnusable, `the journal of batch ${ctx.batchId} cannot be written (${errorCode(error)})`)
        }
      }
      try {
        journal({ op: 'unit-moved', rootId: unit.rootId })
      } catch (error) {
        stop([{ code: 'changed', sessionId: unit.rootId }], errorCode(error))
        throw new TrashError(ERROR.trashUnusable, `the journal of batch ${ctx.batchId} cannot be written (${errorCode(error)})`)
      }
      return { rootId: unit.rootId, outcome: 'moved', moved: moved.length, bytes: unit.bytes, reasons: [], error: null, split: false }
    } catch (error) {
      if (!rolledBack && moved.length > 0) rollback()
      throw error
    } finally {
      for (const release of releases.reverse()) {
        try { release() } catch { /* a failed release must not hide the outcome */ }
      }
    }
  }

  function batchHandle(dir, manifest, refused, lock) {
    const { batchId } = manifest
    const journal = journalOf(dir)
    const units = new Map(manifest.units.map((unit) => [unit.rootId, unit]))
    const entries = new Map(manifest.sessions.map((s) => [s.id, publicEntry(s)]))
    const outcomes = new Map()
    const ctx = { batchId, dir, manifest, journal, entries }
    let closed = false
    let result = null
    return Object.freeze({
      batchId,
      dir,
      createdAt: manifest.createdAt,
      units: manifest.units,
      refused: Object.freeze(refused),
      get finished() { return closed },
      get result() { return result },
      /**
       * Move one unit (an entry of `units`, or its rootId). `precheck(entry)`
       * is synchronous; it returns null to go on, a refusal (a code, a
       * {code, sessionId} or a list of them), and may return a release
       * function, or an object with `release`, to call once the unit is done.
       */
      moveUnit(unitRef, precheck) {
        if (closed) throw new TypeError(`batch ${batchId} is finished`)
        const rootId = typeof unitRef === 'string' ? unitRef : unitRef?.rootId
        const unit = units.get(rootId)
        if (unit === undefined) throw new TypeError(`unit ${rootId} is not in batch ${batchId}`)
        if (outcomes.has(rootId)) throw new TypeError(`unit ${rootId} was already handled`)
        if (typeof precheck !== 'function') throw new TypeError('moveUnit needs a synchronous precheck function')
        let outcome
        try {
          outcome = moveMembers(ctx, unit, precheck)
        } catch (error) {
          outcomes.set(rootId, { rootId, outcome: 'failed', moved: 0, bytes: 0, reasons: [{ code: 'changed', sessionId: rootId }], error: errorCode(error), split: false })
          throw error
        }
        outcomes.set(rootId, outcome)
        return outcome
      },
      /** Journal one registry step (T9's unpin, detach, unarchive, ...). */
      recordStep(step) {
        if (closed) throw new TypeError(`batch ${batchId} is finished`)
        const line = stepRecord(step)
        assertHeld()
        journal(line)
      },
      /** Journal the log facts of moved sessions (one `logs` line): what a restore must find back. */
      recordLogs(list) {
        if (closed) throw new TypeError(`batch ${batchId} is finished`)
        const line = logsRecord(list)
        assertHeld()
        journal(line)
      },
      /** Close the apply (journal `end`), release the lock and return the ApplyResult. */
      finish() {
        if (closed) throw new TypeError(`batch ${batchId} is already finished`)
        closed = true
        active.delete(batchId)
        try {
          assertHeld()
          journal({ op: 'end' })
        } finally {
          lock.release()
        }
        result = applyResult(batchId, manifest.units, outcomes, refused)
        return result
      },
    })
  }

  function emptyBatch(refused) {
    let closed = false
    let result = null
    return Object.freeze({
      batchId: null,
      dir: null,
      createdAt: null,
      units: Object.freeze([]),
      refused: Object.freeze(refused),
      get finished() { return closed },
      get result() { return result },
      moveUnit() { throw new TypeError('the batch holds no unit') },
      recordStep() { throw new TypeError('the batch holds no unit') },
      finish() {
        closed = true
        result = applyResult(null, [], new Map(), refused)
        return result
      },
    })
  }

  /**
   * Write a new batch: the manifest (the full intent, 'wx', fsynced) and the
   * journal's `begin` line in a staging folder, which is then renamed into
   * place; nothing is moved yet. Units with an unsafe member are left out and
   * returned in `refused`. Takes the lock (re-entrant) until finish().
   * @param {{ planId?: string, units: { rootId: string, memberIds: string[] }[], sessions: object[] }} intent
   *   sessions[]: { id, workspaceDir, workspaceId, parent, archived, pinned, bytes, source }, where source is
   *   the session folder and must equal <sessionsRoot>/<workspaceDir>/<id>
   */
  function createBatch(intent) {
    const { planId, accepted, refused } = checkIntent(intent)
    if (accepted.length === 0) return emptyBatch(refused)
    const lock = acquire()
    let handle = null
    try {
      trashRoot({ create: false })
      const createdAt = timestamp()
      const batchId = newBatchId(createdAt)
      const sessions = accepted.flatMap((unit) => unit.members)
      const manifest = {
        v: FORMAT_VERSION,
        kind: MANIFEST_KIND,
        batchId,
        createdAt,
        planId,
        sessionsRoot,
        workspaceDirs: [...new Set(sessions.map((s) => s.workspaceDir))].sort(),
        units: accepted.map(({ rootId, memberIds, bytes, workspaceId }) => ({ rootId, memberIds, bytes, workspaceId })),
        sessions: sessions.map((s) => Object.fromEntries(PUBLIC_FIELDS.map((key) => [key, s[key]]))),
        totals: { units: accepted.length, sessions: sessions.length, bytes: sessions.reduce((sum, s) => sum + s.bytes, 0) },
      }
      const staging = path.join(trashDir, `${STAGING_PREFIX}${batchId}`)
      makeFolder(staging)
      writeExclusive(path.join(staging, MANIFEST_FILE), `${JSON.stringify(manifest)}\n`)
      makeFolder(path.join(staging, SESSIONS_FOLDER))
      appendLine(path.join(staging, JOURNAL_FILE), record({ op: 'begin', batchId, pid: identity.pid }))
      fsyncFolder(staging)
      const dir = path.join(trashDir, batchId)
      if (lstatOrNull(dir) !== null) throw new TrashError(ERROR.trashUnusable, `batch folder ${batchId} already exists`)
      fs.renameSync(staging, dir)
      fsyncFolder(trashDir)
      active.add(batchId)
      handle = batchHandle(dir, parseManifest(manifest, batchId, sessionsRoot), refused, lock)
      return handle
    } finally {
      if (handle === null) lock.release()
    }
  }

  // --- restore -----------------------------------------------------------------

  /** Why a member cannot go back to its recorded folder now, or null. The destination must not exist. */
  function restoreProblem(dir, s, store) {
    if (s.unsafe) return 'path-unsafe'
    const trashParent = lstatOrNull(path.join(dir, SESSIONS_FOLDER, s.workspaceDir))
    if (trashParent === null) return 'no-location'
    if (trashParent.isSymbolicLink() || !trashParent.isDirectory()) return 'path-unsafe'
    const copy = lstatOrNull(destOf(dir, s))
    if (copy === null) return 'no-location'
    if (copy.isSymbolicLink() || !copy.isDirectory()) return 'path-unsafe'
    const storeParent = lstatOrNull(path.join(sessionsRoot, s.workspaceDir))
    if (storeParent !== null) {
      if (storeParent.isSymbolicLink() || !storeParent.isDirectory()) return 'path-unsafe'
      if (lstatOrNull(sourceOf(s)) !== null) return 'conflict'
    } else if (!store.manifest.workspaceDirs.includes(s.workspaceDir)) return 'path-unsafe'
    if (copy.dev !== (storeParent ?? store).dev) return 'cross-device'
    return null
  }

  function restoreMembers(ctx, unit, precheck) {
    const { dir, manifest, journal, store } = ctx
    const back = []
    const releases = []
    let rolledBack = false
    const undo = () => {
      rolledBack = true
      let split = false
      for (const s of [...back].reverse()) {
        try {
          if (lstatOrNull(destOf(dir, s)) !== null) throw unsafe(`${destOf(dir, s)} is occupied`)
          fs.renameSync(sourceOf(s), destOf(dir, s))
        } catch (error) {
          split = true
          tryJournal(journal, { op: 'restore-rollback-failed', id: s.id, error: errorCode(error) })
          continue
        }
        back.splice(back.indexOf(s), 1)
        tryJournal(journal, { op: 'restore-rolled-back', id: s.id })
      }
      return split
    }
    const stop = (reasons, error = null) => {
      const split = undo()
      tryJournal(journal, error === null ? { op: 'unit-restore-skipped', rootId: unit.rootId, reasons } : { op: 'unit-restore-failed', rootId: unit.rootId, reasons, error })
      return { rootId: unit.rootId, outcome: split || (error !== null && error !== 'precheck-threw') ? 'failed' : 'skipped', reasons, error, split }
    }
    try {
      for (const s of unit.memberIds.map((id) => manifest.byId.get(id))) {
        let problem
        try {
          problem = restoreProblem(dir, s, store)
          if (problem === null) ensureStoreFolder(manifest, s, journal)
        } catch (error) {
          if (error instanceof PathError) problem = 'path-unsafe'
          else return stop([{ code: 'changed', sessionId: s.id }], errorCode(error))
        }
        if (problem !== null) return stop([{ code: problem, sessionId: s.id }])
        try {
          assertHeld()
        } catch (error) {
          stop([{ code: 'changed', sessionId: s.id }], 'lock-lost')
          throw error
        }
        let verdict
        try {
          verdict = precheck(ctx.entries.get(s.id))
        } catch {
          return stop([{ code: 'changed', sessionId: s.id }], 'precheck-threw')
        }
        const release = releaseOf(verdict)
        if (release !== null) releases.push(release)
        if (verdict !== null && typeof verdict === 'object' && typeof verdict.then === 'function') {
          stop([{ code: 'changed', sessionId: s.id }], 'precheck-async')
          throw new TypeError('precheck must be synchronous: it returned a promise')
        }
        let reasons
        try {
          reasons = typeof verdict === 'function' ? [] : refusalsOf(verdict, s.id)
        } catch (error) {
          stop([{ code: 'changed', sessionId: s.id }], 'precheck-invalid')
          throw error
        }
        if (reasons.length > 0) return stop(reasons)
        // The destination is checked again right before the rename: rename(2) would replace an empty folder.
        let occupied
        try {
          occupied = lstatOrNull(sourceOf(s)) !== null
        } catch (error) {
          return stop([{ code: 'changed', sessionId: s.id }], errorCode(error))
        }
        if (occupied) return stop([{ code: 'conflict', sessionId: s.id }])
        try {
          fs.renameSync(destOf(dir, s), sourceOf(s))
        } catch (error) {
          const code = errorCode(error)
          if (code === 'EXDEV') return stop([{ code: 'cross-device', sessionId: s.id }])
          if (code === 'ENOENT') return stop([{ code: 'no-location', sessionId: s.id }])
          if (code === 'EEXIST' || code === 'ENOTEMPTY') return stop([{ code: 'conflict', sessionId: s.id }])
          return stop([{ code: 'changed', sessionId: s.id }], code)
        }
        back.push(s)
        try {
          journal({ op: 'restored', id: s.id })
        } catch (error) {
          stop([{ code: 'changed', sessionId: s.id }], errorCode(error))
          throw new TrashError(ERROR.trashUnusable, `the journal of batch ${ctx.batchId} cannot be written (${errorCode(error)})`)
        }
      }
      try {
        journal({ op: 'unit-restored', rootId: unit.rootId })
      } catch (error) {
        stop([{ code: 'changed', sessionId: unit.rootId }], errorCode(error))
        throw new TrashError(ERROR.trashUnusable, `the journal of batch ${ctx.batchId} cannot be written (${errorCode(error)})`)
      }
      return { rootId: unit.rootId, outcome: 'restored', reasons: [], error: null, split: false }
    } catch (error) {
      if (!rolledBack && back.length > 0) undo()
      throw error
    } finally {
      for (const release of releases.reverse()) {
        try { release() } catch { /* a failed release must not hide the outcome */ }
      }
    }
  }

  /**
   * Move a batch back into the store, unit by unit, all or nothing per unit,
   * each session only to its exact recorded folder. Recovers the batch first.
   * A destination that exists (even an empty or lock-only folder) is
   * `conflict`: the unit stays whole in the trash, nothing is overwritten. A
   * restore with nothing left to do journals nothing. `precheck` works as for
   * moveUnit. Returns an ApplyResult (`moved` counts what came back).
   * @param {string} batchId
   * @param {{ precheck?: (entry: object) => unknown }} [options]
   */
  function restore(batchId, options = {}) {
    const precheck = options.precheck ?? (() => null)
    if (typeof precheck !== 'function') throw new TypeError('restore precheck must be a function')
    batchFolder(batchId)
    return withLock(() => {
      if (active.has(batchId)) throw busy(`batch ${batchId} is still being written`)
      const batch = loadBatch(batchId)
      recoverBatch(batch)
      const store = storeRoot()
      const { manifest, dir } = batch
      ownFolder(path.join(dir, SESSIONS_FOLDER))
      const fold = readFold(batch)
      const journal = journalOf(dir)
      const ctx = { batchId, dir, manifest, journal, store: { ...store, manifest }, entries: new Map(manifest.sessions.map((s) => [s.id, publicEntry(s)])) }
      const skipped = []
      const ready = []
      for (const unit of manifest.units) {
        const where = unit.memberIds.map((id) => fold.location.get(id))
        if (where.every((place) => place === 'store')) continue
        const reasons = []
        for (const id of unit.memberIds) {
          const s = manifest.byId.get(id)
          const place = fold.location.get(id)
          const code = s.unsafe ? 'path-unsafe' : place === 'trash' ? restoreProblem(dir, s, ctx.store)
            : place === 'lost' ? 'no-location' : 'conflict'
          if (code !== null) reasons.push({ code, sessionId: id })
        }
        if (reasons.length > 0) skipped.push({ rootId: unit.rootId, reasons, preflight: true })
        else ready.push(unit)
      }
      let units = 0
      let sessions = 0
      let bytes = 0
      let split = false
      const warnings = []
      if (ready.length > 0) {
        journal({ op: 'restore-start' })
        for (const entry of skipped) journal({ op: 'unit-restore-skipped', rootId: entry.rootId, reasons: entry.reasons })
        for (const unit of ready) {
          const outcome = restoreMembers(ctx, unit, precheck)
          if (outcome.outcome === 'restored') {
            units += 1
            sessions += unit.memberIds.length
            bytes += unit.memberIds.reduce((sum, id) => sum + manifest.byId.get(id).bytes, 0)
          } else {
            skipped.push({ rootId: unit.rootId, reasons: outcome.reasons })
            if (outcome.split) {
              split = true
              warnings.push({ code: 'recovery-needed', sessionId: unit.rootId })
            }
          }
        }
        journal({ op: 'restore-end' })
      }
      const conflict = skipped.some((entry) => entry.reasons.some((reason) => reason.code === 'conflict'))
      return {
        batchId,
        trashDir,
        state: split ? 'needs-recovery' : conflict ? 'conflict' : skipped.length > 0 ? 'partial' : 'complete',
        moved: { units, sessions, bytes },
        skipped: skipped.map(({ rootId, reasons }) => ({ rootId, reasons })),
        warnings,
      }
    })
  }

  // --- purge: the only removal -------------------------------------------------

  /**
   * Delete <trashDir>/<batchId> for good, after these checks: permanent delete
   * is allowed, the id matches the batch id pattern, the folder is not a
   * symlink (lstat), resolves to itself inside the trash folder, and holds its
   * manifest. The batch is first recovered (a split unit goes back whole to
   * the store), then journaled `purge-start` and renamed to
   * .purge-<batchId>, which is then emptied without following any link; a
   * later purge() of the same id finishes an interrupted one.
   * @returns {{ batchId: string, removedSessions: number, removedBytes: number }}
   */
  function purge(batchId) {
    if (allowPermanentDelete !== true) throw new TrashError(ERROR.purgeDisabled, 'permanent delete is disabled (allowPermanentDelete is false)')
    const dir = batchFolder(batchId)
    const tomb = path.join(trashDir, `${PURGE_PREFIX}${batchId}`)
    return withLock(() => {
      if (trashRoot({ create: false }) === null) throw new TrashError(ERROR.batchNotFound, `no batch ${batchId}`)
      if (active.has(batchId)) throw busy(`batch ${batchId} is still being written`)
      const batch = loadBatchAt(dir, batchId)
      if (batch !== null) {
        if (lstatOrNull(tomb) !== null) throw unsafe(`an interrupted purge of ${batchId} is in the way`)
        recoverBatch(batch)
        journalOf(dir)({ op: 'purge-start' })
        fs.renameSync(dir, tomb)
        fsyncFolder(trashDir)
      } else if (lstatOrNull(tomb) === null) {
        throw new TrashError(ERROR.batchNotFound, `no batch ${batchId}`)
      }
      ownFolder(tomb)
      if (fs.realpathSync(tomb) !== tomb) throw unsafe(`the purge folder of ${batchId} does not resolve inside the trash folder`)
      const manifestFile = path.join(tomb, MANIFEST_FILE)
      const manifest = lstatOrNull(manifestFile) === null ? null : readManifest(tomb, batchId)
      if (manifest === null && fs.readdirSync(tomb).length > 0) throw unsafe(`the purge folder of ${batchId} has no manifest and is not empty`)
      let removedSessions = 0
      let removedBytes = 0
      const onDisk = (stat) => (Number.isSafeInteger(stat.blocks) ? stat.blocks * 512 : stat.size)
      // Depth first; a symlink is removed as a link and never followed.
      const removeTree = (folder, counted) => {
        const names = fs.readdirSync(folder).sort()
        const here = fs.lstatSync(folder)
        if (here.isSymbolicLink() || !here.isDirectory() || fs.realpathSync(folder) !== folder) throw unsafe(`${folder} changed during the purge`)
        for (const name of names) {
          const entry = path.join(folder, name)
          const stat = lstatOrNull(entry)
          if (stat === null) continue
          if (stat.isDirectory() && !stat.isSymbolicLink()) removeTree(entry, counted)
          else {
            if (counted) removedBytes += onDisk(stat)
            fs.unlinkSync(entry)
          }
        }
        if (counted) removedBytes += onDisk(here)
        fs.rmdirSync(folder)
      }
      if (manifest !== null) {
        const sessionsDir = path.join(tomb, SESSIONS_FOLDER)
        const sessionsStat = lstatOrNull(sessionsDir)
        if (sessionsStat !== null && sessionsStat.isDirectory() && !sessionsStat.isSymbolicLink()) {
          for (const s of manifest.sessions) {
            if (s.unsafe) continue
            const parent = lstatOrNull(path.join(sessionsDir, s.workspaceDir))
            if (parent === null || parent.isSymbolicLink() || !parent.isDirectory()) continue
            const folder = lstatOrNull(destOf(tomb, s))
            if (folder !== null && folder.isDirectory() && !folder.isSymbolicLink()) removedSessions += 1
          }
          removeTree(sessionsDir, true)
        } else if (sessionsStat !== null) {
          fs.unlinkSync(sessionsDir)
        }
        for (const name of fs.readdirSync(tomb).sort()) {
          if (name === MANIFEST_FILE) continue
          const entry = path.join(tomb, name)
          const stat = lstatOrNull(entry)
          if (stat === null) continue
          if (stat.isDirectory() && !stat.isSymbolicLink()) removeTree(entry, false)
          else fs.unlinkSync(entry)
        }
        fs.unlinkSync(manifestFile)
      }
      fs.rmdirSync(tomb)
      return { batchId, removedSessions, removedBytes }
    })
  }

  // --- read side ---------------------------------------------------------------

  /**
   * The batches in the trash, newest first, as a TrashList (contract
   * assertTrashList): counts are what each batch holds now (manifest sizes of
   * the sessions the journal places in the trash or in conflict, see heldOf);
   * state is the journal fold.
   * An interrupted purge is listed as needs-recovery with zero counts. Folders
   * that fail their checks are not listed (recover() reports them), nor are
   * closed batches (one read of the journal's tail each).
   * @param {{ detail?: boolean }} [options] `detail`: each row also carries
   *   `detail` (detailOf), which is not part of the TrashList contract
   */
  function list(options = {}) {
    const withDetail = options?.detail === true
    if (trashRoot({ create: false }) === null) return { trashDir, batches: [] }
    const names = fs.readdirSync(trashDir).sort()
    const present = new Set(names)
    const batches = []
    for (const name of names) {
      if (isBatchId(name)) {
        if (closedAt(path.join(trashDir, name), name)) continue
        let batch
        try {
          batch = loadBatchAt(path.join(trashDir, name), name)
        } catch (error) {
          if (error instanceof PathError || error instanceof TrashError) continue
          throw error
        }
        if (batch === null) continue
        try {
          const fold = readFold(batch)
          const row = { batchId: name, createdAt: batch.manifest.createdAt, ...heldOf(batch.manifest, fold), state: batchState(batch.manifest, fold) }
          batches.push(withDetail ? { ...row, detail: detailOf(batch.manifest, fold) } : row)
        } catch (error) {
          if (!(error instanceof PathError) && !(error instanceof TrashError)) throw error
          const row = { batchId: name, createdAt: batch.manifest.createdAt, units: 0, sessions: 0, bytes: 0, state: 'conflict' }
          batches.push(withDetail ? { ...row, detail: NO_DETAIL } : row)
        }
      } else if (name.startsWith(PURGE_PREFIX)) {
        const batchId = name.slice(PURGE_PREFIX.length)
        if (!isBatchId(batchId) || present.has(batchId)) continue
        const folder = path.join(trashDir, name)
        const stat = lstatOrNull(folder)
        if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) continue
        let createdAt = 0
        try {
          createdAt = readManifest(folder, batchId).createdAt
        } catch { /* partly deleted */ }
        const row = { batchId, createdAt, units: 0, sessions: 0, bytes: 0, state: 'needs-recovery' }
        batches.push(withDetail ? { ...row, detail: NO_DETAIL } : row)
      }
    }
    batches.sort((a, b) => b.createdAt - a.createdAt || (a.batchId < b.batchId ? 1 : a.batchId > b.batchId ? -1 : 0))
    return { trashDir, batches }
  }

  /** One batch in detail: manifest entries with their journal location, units, registry steps, folders restore created. */
  function inspect(batchId) {
    const batch = loadBatch(batchId)
    const fold = readFold(batch)
    const { manifest } = batch
    const unitLocation = (unit) => unitLocationOf(unit, fold)
    return {
      batchId,
      createdAt: manifest.createdAt,
      planId: manifest.planId,
      state: active.has(batchId) ? 'needs-recovery' : batchState(manifest, fold),
      openOp: fold.openOp,
      held: heldOf(manifest, fold),
      units: manifest.units.map((unit) => ({ ...unit, memberIds: [...unit.memberIds], location: unitLocation(unit) })),
      sessions: manifest.sessions.map((s) => ({ ...publicEntry(s), unsafe: s.unsafe, location: fold.location.get(s.id) })),
      steps: fold.steps,
      logs: [...fold.logs].map(([id, facts]) => ({ id, ...facts })),
      closed: fold.closed,
      createdFolders: fold.createdFolders,
      skippedLines: fold.skippedLines,
    }
  }

  /** Journal one registry step for a batch (for steps after restore, or after a recovery). */
  function recordStep(batchId, step) {
    batchFolder(batchId)
    const line = stepRecord(step)
    return withLock(() => {
      const batch = loadBatch(batchId)
      journalOf(batch.dir)(line)
    })
  }

  /** Journal the log facts of sessions in a batch (a recovery that finds them missing after a crash). */
  function recordLogs(batchId, list) {
    batchFolder(batchId)
    const line = logsRecord(list)
    return withLock(() => {
      const batch = loadBatch(batchId)
      journalOf(batch.dir)(line)
    })
  }

  /**
   * Close a batch: after one verifying pass (recoverBatch), append its
   * `closed` line when the journal places every session in the store and no
   * operation is open. The caller (the Host) closes a batch only when its
   * registry steps are done too. Returns whether the batch is closed now; a
   * closed batch is left as it is. Moves and deletes nothing.
   */
  function close(batchId) {
    batchFolder(batchId)
    return withLock(() => {
      if (active.has(batchId)) return false
      const batch = loadBatch(batchId)
      if (closedAt(batch.dir, batchId)) return true
      recoverBatch(batch)
      const fold = readFold(batch)
      if (fold.openOp !== null) return false
      if (batch.manifest.sessions.some((s) => s.unsafe || fold.location.get(s.id) !== 'store')) return false
      journalOf(batch.dir)({ op: 'closed', batchId })
      return true
    })
  }

  /**
   * Check, without writing, that the trash can be used: the sessions tree
   * resolves, the trash folder is outside it (paths.js assertDisjoint) and
   * the reverse, has no symlinked component, and is (or would be created) on
   * the store's device (paths.js sameDevice). Throws PathError `path-unsafe`
   * or TrashError `trash-unusable`.
   */
  async function validate() {
    storeRoot()
    try {
      await assertDisjoint(sessionsRoot, trashDir)
    } catch (error) {
      throw unsafe(error?.message ?? 'the trash folder and the sessions tree overlap')
    }
    const stat = trashRoot({ create: false })
    let probe = trashDir
    while (stat === null && lstatOrNull(probe) === null) probe = path.dirname(probe)
    if (!(await sameDevice(sessionsRoot, probe, (target) => fs.statSync(target)))) {
      throw new TrashError(ERROR.trashUnusable, 'the trash folder is on another device than the sessions tree (cross-device)', { reason: 'cross-device' })
    }
    return { trashDir, sessionsRoot, exists: stat !== null }
  }

  return Object.freeze({
    trashDir,
    sessionsRoot,
    validate,
    acquire,
    holdsLock: () => lockDepth > 0,
    recover,
    createBatch,
    restore,
    purge,
    list,
    inspect,
    recordStep,
    recordLogs,
    close,
    /** Whether a batch is closed (one read of its journal's tail). */
    isClosed: (batchId) => isBatchId(batchId) && closedAt(path.join(trashDir, batchId), batchId),
  })
}
