// Lineage engine of dsh-plugin-sessions: which stored sessions a prune may take.
//
// A prune unit is the top-most archived session (the root) plus every stored
// descendant over the `parentSession` link, all or nothing (design.md D3).
// buildUnits() finds the units, evaluate() applies the refusal rules (one
// refusal on any member blocks the whole unit), selectScope() narrows them to
// the requested scope, and planDigest()/diffPlan() tell what changed between a
// plan and its apply.
//
// Membership follows the reference cascade (docs/reference/prune-archived-sessions.py:70-81):
// the walk starts at every archived id, also one without a stored log, goes
// down over the children of each stored row, and keeps only stored ids. So the
// stored children of an archived session whose log is gone still form units
// (marked `orphan`, with that id as `anchorId`).
//
// Pure: plain data in, plain data out. No file system, no clock (`now` is a
// parameter), no host service; collectFacts() calls only the HostFacts adapter
// it is given (src/contract.js). Every walk is iterative, so a deep chain or a
// long ring cannot overflow the stack. Output order never depends on the order
// of the input.
import { createHash } from 'node:crypto'
import { ContractError, ERROR, REFUSAL_CODES } from './contract.js'

const DAY_MS = 86_400_000
const MINUTE_MS = 60_000
const CODE_ORDER = new Map(REFUSAL_CODES.map((code, index) => [code, index]))
/** Lock states that do not block: no lock, or a lock whose recorded pid is dead (design.md D6). */
const UNLOCKED = new Set(['none', 'stale'])
const UNKNOWN_LOCK = Object.freeze({ state: 'unknown', pid: null })
const NO_STAT = Object.freeze({ exists: false, isSymlink: false, mtimeMs: 0, bytes: 0, dev: 0 })
const UNSAFE_CHARS = /[\u0000-\u001f\u007f\\]/
const UNSAFE_ID_CHARS = /[/\\\u0000-\u001f\u007f]/

const isId = (value) => typeof value === 'string' && value.length > 0
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const newest = (a, b) => (a === null ? b : b === null ? a : Math.max(a, b))
const isThenable = (value) => value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function'

const push = (map, key, value) => {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/** A Set of the string ids in `value` (an array, Set or other iterable, never a string). */
const idSet = (value, label) => {
  if (value === null || typeof value !== 'object' || typeof value[Symbol.iterator] !== 'function') {
    throw new TypeError(`${label} must be an iterable of session ids`)
  }
  const set = new Set()
  for (const id of value) if (isId(id)) set.add(id)
  return set
}

// ---------------------------------------------------------------------------
// Paths. POSIX only: a location is safe when it is a clean absolute path, the
// session folder is named by the id, the log lies inside the folder, and the
// folder lies strictly inside the store root (when one is given).
// ---------------------------------------------------------------------------

/** A clean absolute POSIX path: no empty, `.` or `..` segment, no control character or backslash. */
const isCleanAbsolute = (path) => {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 4096 || UNSAFE_CHARS.test(path)) return false
  const parts = path.slice(1).split('/')
  return parts.every((part) => part !== '' && part !== '.' && part !== '..')
}

/** One path segment: no separator, no control character, no leading dot, no `..`. */
const isSafeSegment = (id) => (
  isId(id) && id.length <= 255 && !id.startsWith('.') && !id.includes('..') && !UNSAFE_ID_CHARS.test(id)
)

/** 'missing' (no folder or log path), 'unsafe', or 'ok'. Lexical only: it reads nothing. */
const locate = (member, storeRoot) => {
  const { id, dir, logPath } = member
  if (!isId(dir) || !isId(logPath)) return 'missing'
  if (!isSafeSegment(id) || !isCleanAbsolute(dir) || !isCleanAbsolute(logPath)) return 'unsafe'
  if (dir.slice(dir.lastIndexOf('/') + 1) !== id || !logPath.startsWith(`${dir}/`)) return 'unsafe'
  if (storeRoot !== null && (!isCleanAbsolute(storeRoot) || !dir.startsWith(`${storeRoot}/`))) return 'unsafe'
  return 'ok'
}

// ---------------------------------------------------------------------------
// buildUnits
// ---------------------------------------------------------------------------

/** The time a row was last active: the first of mtimeMs, lastActivityMs, lastActivityAt that is a number. */
const rowTime = (row) => [row.mtimeMs, row.lastActivityMs, row.lastActivityAt].find(finite) ?? null

/** Sort key of a row, so the canonical row of a duplicated id never depends on the input order. */
const rowKey = (row) => JSON.stringify([
  String(row.dir ?? ''), String(row.logPath ?? ''), String(row.parentId ?? ''), finite(row.bytes) ? row.bytes : null, rowTime(row),
  row.revision ?? null,
])

const toMember = (row, archived, duplicate) => ({
  id: row.id,
  parentId: isId(row.parentId) ? row.parentId : null,
  dir: isId(row.dir) ? row.dir : null,
  logPath: isId(row.logPath) ? row.logPath : null,
  bytes: finite(row.bytes) && row.bytes >= 0 ? Math.floor(row.bytes) : 0,
  mtimeMs: rowTime(row),
  revision: isId(row.revision) || finite(row.revision) ? row.revision : null,
  archived,
  duplicate,
  legacy: row.legacy === true,
})

/**
 * @typedef {object} LineageRow One stored session (a SessionSnapshot or a compact store-index row).
 * @property {string} id
 * @property {string | null} [parentId] The `parentSession` link.
 * @property {string | null} [dir] Session folder.
 * @property {string | null} [logPath] Session log.
 * @property {number} [bytes] On-disk size.
 * @property {number} [mtimeMs] Log mtime; else lastActivityMs, else lastActivityAt.
 * @property {number} [lastActivityMs]
 * @property {number} [lastActivityAt]
 * @property {string | number} [revision] Persistence revision, when the snapshot has one.
 * @property {boolean} [unreadable] Header unreadable: the row exists but is never linked into a unit.
 * @property {boolean} [legacy] The log is in a legacy format (formatStatus 'migration-required'): refused in v1 (design.md D14).
 */

/**
 * @typedef {object} UnitMember
 * @property {string} id
 * @property {string | null} parentId
 * @property {string | null} dir
 * @property {string | null} logPath
 * @property {number} bytes
 * @property {number | null} mtimeMs
 * @property {string | number | null} revision
 * @property {boolean} archived
 * @property {boolean} duplicate True when the store holds more than one row for this id (refused as path-unsafe).
 * @property {boolean} legacy True when the row is flagged legacy (refused as legacy-format).
 */

/**
 * @typedef {object} PruneUnit
 * @property {string} rootId The top-most member: archived, or (orphan) the child of an archived id without a stored log.
 * @property {string | null} anchorId The archived id the unit hangs from: rootId, or the missing parent of an orphan root.
 * @property {boolean} orphan True when the root is not archived itself.
 * @property {boolean} cycle True when the parent links of the unit hold a cycle (a self-parent included).
 * @property {string[]} cycleIds Members on a cycle, sorted.
 * @property {string[]} memberIds Root first, then parents before children (children by id).
 * @property {UnitMember[]} members In memberIds order.
 * @property {{ sessionId: string, parentId: string }[]} externalParents Members whose parent exists in the store outside the unit.
 * @property {number} bytes Sum of the member sizes.
 * @property {number | null} lastActivityMs Newest member activity known from the rows.
 */

/**
 * Splits the stored sessions reached from the archived ids into prune units.
 * Units are pairwise disjoint and closed under children in the store; they are
 * sorted by root id. Ids missing from `rows` are never members; unreadable rows
 * are never members either, but they count as existing parents.
 * @param {LineageRow[]} rows
 * @param {Iterable<string>} archivedIds
 * @returns {PruneUnit[]}
 */
export function buildUnits(rows, archivedIds) {
  if (!Array.isArray(rows)) throw new TypeError('buildUnits: rows must be an array')
  const archived = idSet(archivedIds, 'buildUnits: archivedIds')

  // One canonical readable row per id; every id with any row exists.
  const copies = new Map()
  const readable = new Map()
  const parentSets = new Map()
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || !isId(row.id)) continue
    copies.set(row.id, (copies.get(row.id) ?? 0) + 1)
    if (row.unreadable === true) continue
    const held = readable.get(row.id)
    if (!held || rowKey(row) < rowKey(held)) readable.set(row.id, row)
    if (isId(row.parentId)) {
      const set = parentSets.get(row.id) ?? new Set()
      set.add(row.parentId)
      parentSets.set(row.id, set)
    }
  }
  const parents = new Map([...parentSets].map(([id, set]) => [id, [...set].sort(byString)]))
  const kids = new Map()
  for (const [id, list] of parents) for (const parent of list) push(kids, parent, id)
  for (const list of kids.values()) list.sort(byString)

  // The cascade: every id reachable from an archived id over children.
  const reach = new Set()
  const stack = [...archived].sort(byString)
  while (stack.length > 0) {
    const id = stack.pop()
    if (reach.has(id)) continue
    reach.add(id)
    for (const kid of kids.get(id) ?? []) if (!reach.has(kid)) stack.push(kid)
  }

  // Members are the reached ids with a readable row. A unit is a connected group
  // of members over parent links; in a forest that is one top-most root and its tree.
  const isMember = (id) => reach.has(id) && readable.has(id)
  const ctx = { archived, copies, readable, parents, kids, reach }
  const assigned = new Set()
  const units = []
  for (const start of [...reach].filter(isMember).sort(byString)) {
    if (assigned.has(start)) continue
    const group = []
    const queue = [start]
    assigned.add(start)
    while (queue.length > 0) {
      const id = queue.pop()
      group.push(id)
      for (const next of [...(parents.get(id) ?? []), ...(kids.get(id) ?? [])]) {
        if (isMember(next) && !assigned.has(next)) {
          assigned.add(next)
          queue.push(next)
        }
      }
    }
    units.push(makeUnit(group, ctx))
  }
  return units.sort((a, b) => byString(a.rootId, b.rootId))
}

const makeUnit = (group, { archived, copies, readable, parents, kids, reach }) => {
  const inside = new Set(group)
  const sorted = [...group].sort(byString)
  const parentsOf = (id) => parents.get(id) ?? []
  const kidsInside = (id) => (kids.get(id) ?? []).filter((kid) => inside.has(kid))

  // Members on a cycle: whatever is left after peeling leaves upward (Kahn).
  const pending = new Map(sorted.map((id) => [id, kidsInside(id).length]))
  const leaves = sorted.filter((id) => pending.get(id) === 0)
  const peeled = new Set()
  while (leaves.length > 0) {
    const id = leaves.pop()
    peeled.add(id)
    for (const parent of parentsOf(id)) {
      if (!inside.has(parent)) continue
      const left = pending.get(parent) - 1
      pending.set(parent, left)
      if (left === 0) leaves.push(parent)
    }
  }
  const cycleIds = sorted.filter((id) => !peeled.has(id))

  // The root: the top-most member (no parent inside), archived first; in a ring,
  // the smallest archived ring member.
  const tops = sorted.filter((id) => !parentsOf(id).some((parent) => inside.has(parent)))
  const pool = tops.length > 0 ? tops : cycleIds
  const rootId = pool.find((id) => archived.has(id)) ?? pool[0]

  // Preorder from the root over children, smallest child first.
  const order = []
  const seen = new Set()
  for (const start of [rootId, ...tops, ...cycleIds, ...sorted]) {
    const walk = [start]
    while (walk.length > 0) {
      const id = walk.pop()
      if (seen.has(id)) continue
      seen.add(id)
      order.push(id)
      const next = kidsInside(id)
      for (let i = next.length - 1; i >= 0; i -= 1) if (!seen.has(next[i])) walk.push(next[i])
    }
  }

  const members = order.map((id) => toMember(readable.get(id), archived.has(id), copies.get(id) > 1))
  const externalParents = []
  for (const id of order) {
    for (const parent of parentsOf(id)) if (!inside.has(parent) && copies.has(parent)) externalParents.push({ sessionId: id, parentId: parent })
  }
  const orphan = !archived.has(rootId)
  const anchorId = orphan ? (parentsOf(rootId).find((parent) => reach.has(parent) && !inside.has(parent)) ?? null) : rootId
  return {
    rootId,
    anchorId,
    orphan,
    cycle: cycleIds.length > 0,
    cycleIds,
    memberIds: order,
    members,
    externalParents,
    bytes: members.reduce((total, member) => total + member.bytes, 0),
    lastActivityMs: members.reduce((time, member) => newest(time, member.mtimeMs), null),
  }
}

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

/**
 * Facts evaluate() reads. They are synchronous and already gathered:
 * collectFacts() builds them from a HostFacts adapter.
 * @typedef {object} LineageFacts
 * @property {Iterable<string>} liveIds Sessions the live-session service holds.
 * @property {{ id: string, sessionIds: string[] }[]} workspaces Registered sessions per workspace.
 * @property {(folder: string) => { state: string, pid: number | null }} lockState Lock of a session folder; only 'none' and 'stale' do not block.
 * @property {(path: string) => { exists: boolean, isSymlink: boolean, mtimeMs: number }} statLog lstat of a log or folder path.
 * @property {string | null} [storeRoot] When set, every session folder must lie strictly inside it.
 * @property {Iterable<string>} [keptIds] Replaces the default user-fork discriminator (registered in a workspace).
 */

const readFacts = (facts) => {
  if (facts === null || typeof facts !== 'object') throw new TypeError('evaluate: facts must be an object')
  const live = idSet(facts.liveIds, 'evaluate: facts.liveIds')
  if (!Array.isArray(facts.workspaces)) throw new TypeError('evaluate: facts.workspaces must be an array')
  if (typeof facts.lockState !== 'function' || typeof facts.statLog !== 'function') {
    throw new TypeError('evaluate: facts.lockState and facts.statLog must be functions')
  }
  // The workspace of a session: the smallest workspace id that lists it.
  const registered = new Map()
  for (const workspace of facts.workspaces) {
    if (!workspace || !isId(workspace.id) || !Array.isArray(workspace.sessionIds)) continue
    for (const id of workspace.sessionIds) {
      const held = registered.get(id)
      if (held === undefined || byString(workspace.id, held) < 0) registered.set(id, workspace.id)
    }
  }
  const sync = (name, value) => {
    if (isThenable(value)) throw new TypeError(`evaluate: facts.${name} returned a promise; gather the facts with collectFacts() first`)
    return value
  }
  return {
    live,
    registered,
    kept: facts.keptIds === undefined ? null : idSet(facts.keptIds, 'evaluate: facts.keptIds'),
    storeRoot: facts.storeRoot ?? null,
    lockState: (folder) => sync('lockState', facts.lockState(folder)),
    statLog: (path) => sync('statLog', facts.statLog(path)),
  }
}

const judge = (unit, view, windowMs, now) => {
  const found = []
  const indexOf = new Map(unit.memberIds.map((id, index) => [id, index]))
  const add = (code, sessionId) => { found.push({ code, sessionId, at: indexOf.get(sessionId) ?? -1 }) }
  let activity = null

  for (const member of unit.members) {
    const { id } = member
    if (view.live.has(id)) add('live', id)
    if (!member.archived && (view.kept ? view.kept.has(id) : view.registered.has(id))) add('kept-descendant', id)
    if (member.duplicate) add('path-unsafe', id)
    if (member.legacy === true) add('legacy-format', id)
    let time = member.mtimeMs
    const where = locate(member, view.storeRoot)
    if (where === 'missing') add('no-location', id)
    else if (where === 'unsafe') add('path-unsafe', id)
    else {
      const log = view.statLog(member.logPath)
      if (!log || log.exists !== true) add('no-location', id)
      else {
        if (log.isSymlink !== false) add('path-unsafe', id)
        if (finite(log.mtimeMs)) time = newest(time, log.mtimeMs)
      }
      const folder = view.statLog(member.dir)
      if (folder && folder.isSymlink === true) add('path-unsafe', id)
      const lock = view.lockState(member.dir)
      if (!lock || !UNLOCKED.has(lock.state)) add('locked', id)
    }
    if (time !== null && now - time < windowMs) add('recent', id)
    activity = newest(activity, time)
  }
  for (const id of unit.cycleIds) add('cycle', id)
  for (const { sessionId } of unit.externalParents) add('parent-kept', sessionId)

  found.sort((a, b) => a.at - b.at || CODE_ORDER.get(a.code) - CODE_ORDER.get(b.code))
  const reasons = []
  const listed = new Set()
  for (const { code, sessionId } of found) {
    const key = `${code}\u0000${sessionId}`
    if (listed.has(key)) continue
    listed.add(key)
    reasons.push({ code, sessionId })
  }
  return {
    ...unit,
    workspaceId: view.registered.get(unit.rootId) ?? null,
    lastActivityMs: activity,
    status: reasons.length > 0 ? 'blocked' : 'ready',
    reasons,
  }
}

/**
 * Applies the refusal rules to every unit, all or nothing: one refusal on any
 * member blocks the whole unit. Rules: live, locked, recent (log mtime within
 * recentActivityMinutes; a future mtime counts), kept-descendant (a member that
 * is not archived and is registered in a workspace, or in facts.keptIds),
 * parent-kept (a member's parent exists in the store outside the unit), cycle,
 * path-unsafe, no-location, legacy-format (a member row flagged `legacy`:
 * its log needs a migration, which v1 does not do). Returns new units with workspaceId, lastActivityMs,
 * status and reasons [{code, sessionId}] (by member order, then code order).
 * @param {PruneUnit[]} units
 * @param {LineageFacts} facts
 * @param {{ recentActivityMinutes: number }} config
 * @param {number} now ms since the epoch
 */
export function evaluate(units, facts, config, now) {
  if (!Array.isArray(units)) throw new TypeError('evaluate: units must be an array')
  if (!finite(now)) throw new TypeError('evaluate: now must be a finite number of ms')
  const minutes = config?.recentActivityMinutes
  if (!finite(minutes) || minutes < 0) throw new TypeError('evaluate: config.recentActivityMinutes must be a non-negative number')
  const view = readFacts(facts)
  return units.map((unit) => judge(unit, view, minutes * MINUTE_MS, now))
}

/**
 * Gathers the facts evaluate() needs from a HostFacts adapter: live ids,
 * workspaces, and the lock and lstat of every member whose location is safe.
 * An unsafe path is never handed to the host. A folder or path that was not
 * gathered reads as locked and missing, so nothing passes by omission.
 * @param {object} host A HostFacts adapter (src/contract.js); only liveIds, workspaces, lockState and statLog are called.
 * @param {PruneUnit[]} units
 * @param {{ storeRoot?: string | null, keptIds?: Iterable<string> }} [options]
 * @returns {Promise<LineageFacts>}
 */
export async function collectFacts(host, units, { storeRoot = null, keptIds } = {}) {
  if (!Array.isArray(units)) throw new TypeError('collectFacts: units must be an array')
  const liveIds = [...(await host.liveIds())]
  const workspaces = (await host.workspaces()).map((workspace) => ({
    id: workspace?.id ?? null, sessionIds: Array.isArray(workspace?.sessionIds) ? [...workspace.sessionIds] : [],
  }))
  const locks = new Map()
  const stats = new Map()
  for (const unit of units) {
    for (const member of unit.members) {
      if (locate(member, storeRoot) !== 'ok') continue
      if (!locks.has(member.dir)) locks.set(member.dir, { ...(await host.lockState(member.dir)) })
      for (const path of [member.logPath, member.dir]) if (!stats.has(path)) stats.set(path, { ...(await host.statLog(path)) })
    }
  }
  return {
    liveIds,
    workspaces,
    storeRoot,
    ...(keptIds === undefined ? {} : { keptIds: [...keptIds] }),
    lockState: (folder) => locks.get(folder) ?? UNKNOWN_LOCK,
    statLog: (path) => stats.get(path) ?? NO_STAT,
  }
}

// ---------------------------------------------------------------------------
// selectScope
// ---------------------------------------------------------------------------

const invalid = (message) => new ContractError(ERROR.invalidRequest, `selectScope: ${message}`)

/**
 * Narrows the units to a plan scope (the shape of the `plan` request):
 * `{scope: 'all'}`; `{scope: 'olderThan', olderThanDays}`, the units whose
 * newest activity is at least that many days before `now` (unknown activity
 * never qualifies); `{scope: 'selection', rootIds}`, unit root ids only. Any
 * other id is rejected with ERROR.invalidRequest (listed in `rejectedIds`),
 * never expanded to the unit that holds it. Keeps the order of `units`.
 * @param {PruneUnit[]} units
 * @param {{ scope: string, olderThanDays?: number, rootIds?: string[] }} scope
 * @param {number} now ms since the epoch
 */
export function selectScope(units, scope, now) {
  if (!Array.isArray(units)) throw new TypeError('selectScope: units must be an array')
  const kind = scope !== null && typeof scope === 'object' ? scope.scope : undefined
  if (kind === 'all') return [...units]
  if (kind === 'olderThan') {
    const days = scope.olderThanDays
    if (!Number.isSafeInteger(days) || days < 0) throw invalid('olderThanDays must be a non-negative integer')
    if (!finite(now)) throw new TypeError('selectScope: now must be a finite number of ms')
    const cutoff = now - days * DAY_MS
    return units.filter((unit) => finite(unit.lastActivityMs) && unit.lastActivityMs <= cutoff)
  }
  if (kind === 'selection') {
    if (!Array.isArray(scope.rootIds)) throw invalid('rootIds must be an array of unit root ids')
    const roots = new Set(units.map((unit) => unit.rootId))
    const rejected = [...new Set(scope.rootIds.filter((id) => !(isId(id) && roots.has(id))).map(String))].sort(byString)
    if (rejected.length > 0) {
      const error = invalid(`not a unit root: ${rejected.slice(0, 20).join(', ')}${rejected.length > 20 ? ', …' : ''}`)
      error.rejectedIds = rejected
      throw error
    }
    const wanted = new Set(scope.rootIds)
    return units.filter((unit) => wanted.has(unit.rootId))
  }
  throw invalid(`unknown scope ${JSON.stringify(kind ?? null)}`)
}

// ---------------------------------------------------------------------------
// planDigest and diffPlan
// ---------------------------------------------------------------------------

const sha256 = (value) => `sha256-${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`

const memberRecord = (member) => [
  member.id, member.parentId ?? null, member.dir ?? null, member.logPath ?? null, member.bytes ?? null, member.mtimeMs ?? null,
  member.revision ?? null, member.archived === true, member.duplicate === true, member.legacy === true,
]
const memberRecords = (unit) => unit.members.map(memberRecord).sort((a, b) => byString(a[0], b[0]))
const unitRecord = (unit) => [unit.rootId, unit.cycle === true, memberRecords(unit)]

/**
 * Digest of one unit's facts: root, cycle mark, and per member id, parent,
 * folder, log, bytes, mtimeMs, revision, archived, duplicate and legacy marks. Status
 * and reasons are not covered. Independent of member order.
 * @param {PruneUnit} unit
 */
export function unitDigest(unit) {
  return sha256(['lineage-unit/1', unitRecord(unit)])
}

/**
 * Digest of a set of units: every unitDigest field (so id, bytes, mtimeMs and
 * revision of every member) plus, for evaluated units, status and reasons.
 * Independent of unit and member order.
 * @param {PruneUnit[]} units
 */
export function planDigest(units) {
  if (!Array.isArray(units)) throw new TypeError('planDigest: units must be an array')
  const records = units.map((unit) => [
    ...unitRecord(unit),
    unit.status ?? null,
    (unit.reasons ?? []).map((reason) => [reason.code, reason.sessionId]).sort((a, b) => byString(a.join('\u0000'), b.join('\u0000'))),
  ])
  records.sort((a, b) => byString(a[0], b[0]))
  return sha256(['lineage-plan/1', records])
}

/** The first member id, in id order, whose facts differ between two units; the root when only the shape differs. */
const firstDifference = (old, fresh) => {
  const before = new Map(memberRecords(old).map((record) => [record[0], JSON.stringify(record)]))
  const after = new Map(memberRecords(fresh).map((record) => [record[0], JSON.stringify(record)]))
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort(byString)
  return ids.find((id) => before.get(id) !== after.get(id)) ?? old.rootId
}

/**
 * Compares the units of a plan with units built from fresh facts. Returns, in
 * the order of `old`, `{rootId, reasons: [{code, sessionId}]}` for every unit
 * that must be skipped: `not-archived` when the root lost its archived mark (or
 * no archived tree holds it any more), `changed` when any member fact differs,
 * the membership differs, or the root now hangs below another root. A root that
 * is in no fresh unit is `changed` when `options.archivedIds` says it is still
 * archived (it left the store), else `not-archived`.
 * @param {PruneUnit[]} old
 * @param {PruneUnit[]} fresh
 * @param {{ archivedIds?: Iterable<string> }} [options]
 * @returns {{ rootId: string, reasons: { code: 'changed' | 'not-archived', sessionId: string }[] }[]}
 */
export function diffPlan(old, fresh, options = {}) {
  if (!Array.isArray(old) || !Array.isArray(fresh)) throw new TypeError('diffPlan: old and fresh must be arrays of units')
  const archived = options.archivedIds === undefined ? null : idSet(options.archivedIds, 'diffPlan: archivedIds')
  const freshByRoot = new Map(fresh.map((unit) => [unit.rootId, unit]))
  const freshMembers = new Map()
  for (const unit of fresh) for (const member of unit.members) freshMembers.set(member.id, member)

  const out = []
  const skip = (rootId, code, sessionId) => { out.push({ rootId, reasons: [{ code, sessionId }] }) }
  for (const unit of old) {
    const { rootId } = unit
    const wasArchived = unit.members.find((member) => member.id === rootId)?.archived === true
    const now = freshMembers.get(rootId)
    if (!now) skip(rootId, archived !== null && archived.has(rootId) ? 'changed' : 'not-archived', rootId)
    else if (wasArchived && now.archived !== true) skip(rootId, 'not-archived', rootId)
    else if (!freshByRoot.has(rootId)) skip(rootId, 'changed', rootId)
    else if (unitDigest(unit) !== unitDigest(freshByRoot.get(rootId))) skip(rootId, 'changed', firstDifference(unit, freshByRoot.get(rootId)))
  }
  return out
}
