// Frozen, machine-checked contract of dsh-plugin-sessions.
//
// Everything the Host, the engine modules and the Client agree on lives here:
// the Remote namespace and its methods, the refusal and error codes, plain-JS
// validators for every response DTO (no zod, no dependencies), and the
// HostFacts typedef, which is the only host surface the engine modules see.
// docs/remote-contract.md describes the same contract in prose.
//
// This module is pure: it reads no environment variable, no home directory and
// no file. DTOs carry ids, paths, numbers, flags and a nullable session title,
// never message text.

/** Remote namespace the Host mounts. Never `sessions`: that Cordis key is the host's live-session service. */
export const NAMESPACE = 'sessionsManager'
/** Locale namespace the Client registers. Same name as the Remote namespace, for the same reason. */
export const LOCALE_NS = 'sessionsManager'
export const PACKAGE = 'dsh-plugin-sessions'

const method = (name, mutates) => Object.freeze({ name, unary: true, params: Object.freeze(['request']), mutates })

/**
 * Remote methods. All are unary and take one JSON `request` parameter, and all
 * refuse an agent caller (`sessions-manager/forbidden`). `mutates` marks the
 * methods that change the store or the registry.
 */
export const METHODS = Object.freeze({
  overview: method('overview', false),
  archived: method('archived', false),
  plan: method('plan', false),
  apply: method('apply', true),
  unarchive: method('unarchive', true),
  trash: method('trash', false),
  restore: method('restore', true),
  purge: method('purge', true),
})
export const METHOD_NAMES = Object.freeze(Object.keys(METHODS))

/** Why a session or a unit is excluded from a prune (or an unarchive). */
export const REFUSAL_CODES = Object.freeze([
  'live', 'locked', 'recent', 'kept-descendant', 'parent-kept', 'cycle', 'path-unsafe', 'no-location', 'changed',
  'not-archived', 'cross-device', 'workspace-missing', 'conflict', 'legacy-format',
])

/** Error codes a Remote call can fail with. */
export const ERROR_CODES = Object.freeze([
  'sessions-manager/forbidden',
  'sessions-manager/busy',
  'sessions-manager/plan-expired',
  'sessions-manager/confirmation-mismatch',
  'sessions-manager/purge-disabled',
  'sessions-manager/unsupported-backend',
  'sessions-manager/unsupported-platform',
  'sessions-manager/trash-unusable',
  'sessions-manager/batch-not-found',
  'sessions-manager/invalid-request',
  'sessions-manager/store-unreadable',
])

/** Short names for the error codes, so callers never type the prefix. */
export const ERROR = Object.freeze({
  forbidden: 'sessions-manager/forbidden',
  busy: 'sessions-manager/busy',
  planExpired: 'sessions-manager/plan-expired',
  confirmationMismatch: 'sessions-manager/confirmation-mismatch',
  purgeDisabled: 'sessions-manager/purge-disabled',
  unsupportedBackend: 'sessions-manager/unsupported-backend',
  unsupportedPlatform: 'sessions-manager/unsupported-platform',
  trashUnusable: 'sessions-manager/trash-unusable',
  batchNotFound: 'sessions-manager/batch-not-found',
  invalidRequest: 'sessions-manager/invalid-request',
  storeUnreadable: 'sessions-manager/store-unreadable',
})

/** Why `capabilities.prune` is false. */
export const CAPABILITY_REASONS = Object.freeze([ERROR.unsupportedBackend, ERROR.unsupportedPlatform, ERROR.trashUnusable])
export const WARNING_CODES = Object.freeze([
  'stale-backend-entry', 'registry-step-failed', 'audit-failed', 'restart-recommended', 'recovery-needed',
])
export const BATCH_STATES = Object.freeze(['complete', 'needs-recovery', 'conflict'])
export const APPLY_STATES = Object.freeze(['complete', 'partial', 'needs-recovery', 'conflict'])
export const INDEX_LOADS = Object.freeze(['normal', 'high'])
export const ARCHIVED_SORTS = Object.freeze(['bytes', 'lastActivityAt', 'title'])
export const PLAN_SCOPES = Object.freeze(['all', 'olderThan', 'selection'])
export const UNIT_STATUSES = Object.freeze(['ready', 'blocked'])
export const LOCK_STATES = Object.freeze(['none', 'held', 'stale'])
export const MAX_LARGEST = 10
export const MAX_IDS_PER_REQUEST = 1000
/** A trash batch id is one path segment: it starts with a letter or digit and holds no separator. */
export const BATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * An error carrying one of ERROR_CODES in `code`. Validators and request checks
 * throw it so the Host can pass the code straight to the Remote layer.
 */
export class ContractError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.name = 'ContractError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Tiny schema engine. A schema is a function (value, path) that throws a
// TypeError naming the path; object schemas reject unknown and missing keys.
// ---------------------------------------------------------------------------

const fail = (path, text) => { throw new TypeError(`${path || 'response'}: ${text}`) }
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const str = (value, path) => { if (typeof value !== 'string' || value.length === 0) fail(path, 'expected a non-empty string') }
const bool = (value, path) => { if (typeof value !== 'boolean') fail(path, 'expected a boolean') }
const int = (value, path) => { if (!Number.isSafeInteger(value) || value < 0) fail(path, 'expected a non-negative integer') }
const nullableInt = (value, path) => { if (value !== null) int(value, path) }
const nullable = (inner) => (value, path) => { if (value !== null) inner(value, path) }
const nullableStr = (value, path) => {
  if (value === null) return
  if (typeof value !== 'string') fail(path, 'expected a string or null')
  if (value.length === 0) fail(path, 'expected a non-empty string or null')
}
const oneOf = (list) => (value, path) => { if (!list.includes(value)) fail(path, `expected one of ${list.join(', ')}`) }
const array = (item, { min = 0, max = Infinity, minText } = {}) => (value, path) => {
  if (!Array.isArray(value)) fail(path, 'expected an array')
  if (value.length < min) fail(path, minText ?? `expected at least ${min} items`)
  if (value.length > max) fail(path, `at most ${max} rows`)
  value.forEach((entry, index) => item(entry, `${path}[${index}]`))
}
const object = (shape, { optional = [] } = {}) => (value, path) => {
  if (!isPlain(value)) fail(path, 'expected an object')
  for (const key of Object.keys(value)) if (!Object.hasOwn(shape, key)) fail(path, `unknown key "${key}"`)
  for (const key of Object.keys(shape)) {
    if (!Object.hasOwn(value, key)) {
      if (optional.includes(key)) continue
      fail(path, `missing key "${key}"`)
    }
    const child = path === '' ? key : `${path}.${key}`
    shape[key](value[key], child)
  }
}
const batchId = (value, path) => { if (typeof value !== 'string' || !BATCH_ID_PATTERN.test(value)) fail(path, 'expected a batch id') }
const reason = object({ code: oneOf(REFUSAL_CODES), sessionId: str })
const reasons = array(reason)
const warning = object({ code: oneOf(WARNING_CODES), sessionId: nullableStr })

const OVERVIEW = object({
  generatedAt: int,
  storeDir: nullableStr,
  capabilities: object({ prune: bool, reason: nullable(oneOf(CAPABILITY_REASONS)) }),
  config: object({
    allowPermanentDelete: bool, recentActivityMinutes: int, listLimit: int, refreshMs: int, indexWarnBytes: int,
  }),
  totals: object({
    sessions: int, live: int, archived: int, children: int, unreadable: int, bytes: int, archivedBytes: int,
    archivedRoots: int, archivedChildren: int, reclaimableBytes: int, reclaimableUnits: int, blockedUnits: int,
  }),
  indexLoad: oneOf(INDEX_LOADS),
  workspaces: array(object({
    id: nullableStr, name: nullableStr, path: nullableStr, folder: nullableStr, sessions: int, archived: int, bytes: int,
    lastActivityAt: nullable(int),
  })),
  largest: array(object({
    id: str, title: nullableStr, workspaceId: nullableStr, bytes: int, events: nullableInt, lastActivityAt: int, live: bool,
    archived: bool, child: bool,
  }), { max: MAX_LARGEST }),
})

const ARCHIVED_PAGE = object({
  total: int,
  offset: int,
  limit: int,
  rows: array(object({
    id: str, title: nullableStr, workspaceId: nullableStr, bytes: int, childCount: int, lastActivityAt: int, ageDays: int,
    blocked: bool, reasons, orphan: bool,
  })),
})

const PLAN = object({
  planId: str,
  expiresAt: int,
  digest: str,
  units: array(object({
    rootId: str, memberIds: array(str, { min: 1 }), bytes: int, workspaceId: nullableStr, status: oneOf(UNIT_STATUSES), reasons,
  })),
  totals: object({ units: int, ready: int, blocked: int, sessions: int, readySessions: int, bytes: int, readyBytes: int }),
  byWorkspace: array(object({ workspaceId: nullableStr, units: int, sessions: int, bytes: int })),
})

const skippedUnit = object({
  rootId: str,
  reasons: array(reason, { min: 1, minText: 'at least one reason is required' }),
})

const APPLY_RESULT = object({
  batchId: nullable(batchId),
  trashDir: str,
  state: oneOf(APPLY_STATES),
  moved: object({ units: int, sessions: int, bytes: int }),
  skipped: array(skippedUnit),
  warnings: array(warning),
})

const TRASH_LIST = object({
  trashDir: str,
  batches: array(object({ batchId, createdAt: int, units: int, sessions: int, bytes: int, state: oneOf(BATCH_STATES) })),
})

const UNARCHIVE_RESULT = object({
  unarchived: array(str),
  skipped: array(object({ id: str, code: oneOf(REFUSAL_CODES) })),
})

const PURGE_RESULT = object({ batchId, removedSessions: int, removedBytes: int })

const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0)

/** Throws a TypeError when `dto` is not a valid overview response. */
export function assertOverview(dto) {
  OVERVIEW(dto, '')
  const { capabilities } = dto
  if (capabilities.prune && capabilities.reason !== null) fail('capabilities.reason', 'reason must be null when prune is true')
  if (!capabilities.prune && capabilities.reason === null) fail('capabilities.reason', 'reason is required when prune is false')
}

/** Throws a TypeError when `dto` is not a valid archived page response. */
export function assertArchivedPage(dto) {
  ARCHIVED_PAGE(dto, '')
  dto.rows.forEach((row, index) => {
    const path = `rows[${index}].reasons`
    if (row.blocked && row.reasons.length === 0) fail(path, 'blocked rows need at least one reason')
    if (!row.blocked && row.reasons.length > 0) fail(path, 'unblocked rows have no reasons')
  })
}

/** Throws a TypeError when `dto` is not a valid plan response. */
export function assertPlan(dto) {
  PLAN(dto, '')
  dto.units.forEach((unit, index) => {
    const path = `units[${index}]`
    if (!unit.memberIds.includes(unit.rootId)) fail(`${path}.memberIds`, 'memberIds must include rootId')
    if (unit.status === 'blocked' && unit.reasons.length === 0) fail(`${path}.reasons`, 'blocked units need at least one reason')
    if (unit.status === 'ready' && unit.reasons.length > 0) fail(`${path}.reasons`, 'ready units have no reasons')
  })
  const ready = dto.units.filter((unit) => unit.status === 'ready')
  const expected = {
    units: dto.units.length,
    ready: ready.length,
    blocked: dto.units.length - ready.length,
    sessions: sum(dto.units, (unit) => unit.memberIds.length),
    readySessions: sum(ready, (unit) => unit.memberIds.length),
    bytes: sum(dto.units, (unit) => unit.bytes),
    readyBytes: sum(ready, (unit) => unit.bytes),
  }
  for (const [key, value] of Object.entries(expected)) {
    if (dto.totals[key] !== value) throw new TypeError(`totals.${key} does not match the units`)
  }
}

/** Throws a TypeError when `dto` is not a valid apply (or restore) response. */
export function assertApplyResult(dto) { APPLY_RESULT(dto, '') }

/** Throws a TypeError when `dto` is not a valid trash list response. */
export function assertTrashList(dto) { TRASH_LIST(dto, '') }

/** Throws a TypeError when `dto` is not a valid unarchive response. */
export function assertUnarchiveResult(dto) { UNARCHIVE_RESULT(dto, '') }

/** Throws a TypeError when `dto` is not a valid purge response. */
export function assertPurgeResult(dto) { PURGE_RESULT(dto, '') }

// ---------------------------------------------------------------------------
// Requests. Strict like the responses; a failure carries ERROR.invalidRequest.
// ---------------------------------------------------------------------------

const idList = array(str, { min: 1, max: MAX_IDS_PER_REQUEST })
const REQUESTS = {
  overview: object({ fresh: bool }, { optional: ['fresh'] }),
  archived: object({
    workspaceId: nullableStr, olderThanDays: int, largerThanBytes: int,
    text: (value, path) => { if (typeof value !== 'string' || value.length > 200) fail(path, 'expected a string of at most 200 characters') },
    sort: oneOf(ARCHIVED_SORTS), offset: int, limit: (value, path) => { int(value, path); if (value < 1) fail(path, 'expected an integer of at least 1') },
  }, { optional: ['workspaceId', 'olderThanDays', 'largerThanBytes', 'text', 'sort', 'offset', 'limit'] }),
  plan: object({ scope: oneOf(PLAN_SCOPES), olderThanDays: int, rootIds: idList }, { optional: ['olderThanDays', 'rootIds'] }),
  apply: object({ planId: str, confirmCount: int }),
  unarchive: object({ ids: idList }),
  trash: object({ fresh: bool }, { optional: ['fresh'] }),
  restore: object({ batchId }),
  purge: object({ batchId, confirm: str }),
}

/**
 * Throws a ContractError (code ERROR.invalidRequest) when `request` is not a
 * valid request for Remote method `name`.
 * @param {string} name
 * @param {unknown} request
 */
export function assertRequest(name, request) {
  const schema = Object.hasOwn(REQUESTS, name) ? REQUESTS[name] : null
  try {
    if (!schema) fail(name, 'unknown method')
    schema(request, '')
    if (name === 'plan') {
      const { scope } = request
      if ((scope === 'olderThan') !== Object.hasOwn(request, 'olderThanDays')) fail('plan.olderThanDays', 'required for, and only allowed with, scope olderThan')
      if ((scope === 'selection') !== Object.hasOwn(request, 'rootIds')) fail('plan.rootIds', 'required for, and only allowed with, scope selection')
    }
  } catch (error) {
    if (error instanceof TypeError) throw new ContractError(ERROR.invalidRequest, error.message)
    throw error
  }
}

// ---------------------------------------------------------------------------
// HostFacts: the only host surface the engine modules (lineage, trash, audit,
// store index) see. The Host adapter implements it over the official services;
// tests implement it over a fake. Every method may return a value or a promise;
// callers always await. The engines never import a host module, read the
// environment, or open a session log body.
// ---------------------------------------------------------------------------

/**
 * One stored session, from the persistence snapshot (headers and file metadata only).
 * @typedef {object} SessionSnapshot
 * @property {string} id Session id.
 * @property {string | null} parentId `parentSession` link, null for a top-level session.
 * @property {string} dir Absolute path of the session folder.
 * @property {string} logPath Absolute path of the session log file.
 * @property {string} group Name of the store folder that holds the session (used for the Unassigned row).
 * @property {number} bytes On-disk (compressed) size of the session folder.
 * @property {number} events Event count from the header.
 * @property {number} createdAt Creation time, ms since the epoch.
 * @property {number} lastActivityAt Last activity time, ms since the epoch.
 * @property {boolean} unreadable True when the header could not be read.
 */

/**
 * @typedef {object} WorkspaceFact
 * @property {string} id
 * @property {string} name
 * @property {string} path
 * @property {string[]} sessionIds Sessions registered in the workspace.
 */

/**
 * @typedef {object} LogStat
 * @property {boolean} exists
 * @property {boolean} isSymlink From lstat: a symbolic link is never followed.
 * @property {number} mtimeMs
 * @property {number} bytes
 * @property {number} dev Device id; compared with the trash device to refuse a cross-device move.
 */

/**
 * @typedef {object} LockStatus
 * @property {'none' | 'held' | 'stale'} state `none`: the folder has no session.lock; `held`: a lock probe found the lock held; `stale`: the file exists and the lock is free (the file records no pid and never expires).
 * @property {number | null} pid Always null in this build: the backend's lock file records no pid.
 */

/**
 * The adapter the engines program against.
 * @typedef {object} HostFacts
 * @property {() => Promise<SessionSnapshot[]> | SessionSnapshot[]} snapshots All stored sessions.
 * @property {() => Promise<WorkspaceFact[]> | WorkspaceFact[]} workspaces Workspaces with their registered session ids.
 * @property {() => Promise<string[]> | string[]} archivedIds Ids the registry marks archived.
 * @property {() => Promise<string[]> | string[]} pinnedIds Ids the registry marks pinned.
 * @property {() => Promise<string[]> | string[]} liveIds Ids of sessions the live-session service holds.
 * @property {(folder: string) => Promise<LockStatus> | LockStatus} lockState Lock status of a session folder.
 * @property {(path: string) => Promise<LogStat> | LogStat} statLog lstat of a log path; a missing path gives exists false.
 * @property {(id: string) => Promise<string | null> | string | null} titleOf Cheap title for an id, or null. Never reads a log body.
 * @property {(id: string) => Promise<void> | void} unpin Registry step: remove the pin.
 * @property {(id: string) => Promise<void> | void} detach Registry step: remove the session from its workspace.
 * @property {(id: string) => Promise<void> | void} unarchive Registry step: clear the archived mark.
 * @property {(id: string, workspaceId: string) => Promise<void> | void} attach Registry step: register the session in a workspace again.
 * @property {(id: string) => Promise<void> | void} archive Registry step: set the archived mark.
 * @property {(id: string) => Promise<void> | void} pin Registry step: set the pin.
 */

/** Names of the HostFacts methods, for adapters and tests that check the surface. */
export const HOST_FACTS_METHODS = Object.freeze([
  'snapshots', 'workspaces', 'archivedIds', 'pinnedIds', 'liveIds', 'lockState', 'statLog', 'titleOf', 'unpin', 'detach',
  'unarchive', 'attach', 'archive', 'pin',
])
