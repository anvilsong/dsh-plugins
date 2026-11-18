// Store index of dsh-plugin-sessions: one compact row per stored session, and
// the dashboard figures computed from those rows (overview cards, workspace
// table, largest sessions, archived page).
//
// buildIndex() reads headers and file metadata only, through the HostFacts
// adapter it is given (src/contract.js): the persistence snapshot list, the
// registry ids, the live ids, an lstat of each log, a cheap title, and the
// lock state of the members of archived trees; plus an injected on-disk sum
// of each session folder. It never opens a session log and never calls
// search. Rows hold primitives only (ROW_KEYS), so the index keeps no
// reference to a snapshot or its header. overview(), archivedPage() and
// summarize() are pure functions of the index.
//
// Sizes are on-disk (compressed) bytes. Raw size is never computed.
//
// Prune units come from the lineage engine (src/lineage.js). Two rules from the
// design are added here, so the Reclaimable card, the Archived tab and a plan
// built from index.units agree:
// - kept-descendant follows the header `origin` (docs/store-safety.md,
//   Lineage): a non-archived descendant without origin 'subagent' is a fork and
//   keeps its tree; a subagent child never does, even when a bootstrapped
//   workspace lists it. A row whose source has no header (the contract
//   SessionSnapshot shape) falls back to workspace membership.
// - Sessions in no workspace are not pruned in v1 (design.md D11): a unit whose
//   root has no workspace, own or inherited, is refused with workspace-missing.
import { CAPABILITY_REASONS, ERROR, MAX_LARGEST, REFUSAL_CODES, assertRequest } from './contract.js'
import { buildUnits, collectFacts, evaluate } from './lineage.js'

const DAY_MS = 86_400_000
/** Longest title kept in a row; longer ones end with an ellipsis. Bounds the page size. */
const TITLE_MAX = 120
/** At most this many Unassigned rows in the workspace table; the rest fold into one row without a folder. */
const UNASSIGNED_ROWS_MAX = 50
/** Host lookups in flight at once while the rows are built. */
const CONCURRENCY = 32
const CODE_ORDER = new Map(REFUSAL_CODES.map((code, index) => [code, index]))
const NO_STAT = Object.freeze({ exists: false, isSymlink: false, mtimeMs: 0, bytes: 0, dev: 0 })
const UNKNOWN_LOCK = Object.freeze({ state: 'unknown', pid: null })
const UNSAFE_CHARS = /[\u0000-\u001f\u007f\\]/
const CONTROL_RUNS = /[\s\u0000-\u001f\u007f]+/g
const FACT_METHODS = ['snapshots', 'workspaces', 'archivedIds', 'pinnedIds', 'liveIds', 'lockState', 'statLog', 'titleOf']

/**
 * Keys of a store-index row, the only keys a row has. Names follow the lineage
 * engine, so rows feed buildUnits() directly: `parentId` is the header's
 * `parentSession`, `dir` the session folder and `logPath` the selected log
 * (both from location.path), `workspaceDir` the name of the store folder that
 * holds the session folder (the project directory; the Unassigned grouping).
 */
export const ROW_KEYS = Object.freeze([
  'id', 'parentId', 'createdAt', 'cwd', 'subagent', 'child', 'legacy', 'revision', 'bytes', 'events', 'lastActivityMs',
  'dir', 'logPath', 'workspaceDir', 'workspaceId', 'archived', 'pinned', 'live', 'title', 'unreadable',
])

/**
 * @typedef {object} IndexRow One stored session; every value is a primitive.
 * @property {string} id Header id.
 * @property {string | null} parentId Header `parentSession`.
 * @property {number | null} createdAt Header `createdAt`, ms since the epoch.
 * @property {string | null} cwd Header `cwd`.
 * @property {boolean | null} subagent Header `origin === 'subagent'`; null when the source has no header (contract shape without origin).
 * @property {boolean} child Readable, has a parent, and not a fork (subagent is not false).
 * @property {boolean} legacy `formatStatus === 'migration-required'` (design.md D14).
 * @property {string | number | null} revision Persistence revision token.
 * @property {number} bytes On-disk bytes: the injected folder sum, else snapshot.sizeBytes, else the log lstat size.
 * @property {number | null} events snapshot.eventCount, or null (the JSONL backend gives none).
 * @property {number | null} lastActivityMs lstat mtime of the log.
 * @property {string | null} dir Session folder, dirname(location.path).
 * @property {string | null} logPath location.path of a JSONL location.
 * @property {string | null} workspaceDir Name of the store folder above the session folder.
 * @property {string | null} workspaceId Registered workspace, own or inherited from the nearest registered ancestor.
 * @property {boolean} archived Registry.
 * @property {boolean} pinned Registry.
 * @property {boolean} live Live-session service.
 * @property {string | null} title facts.titleOf(id), cleaned and capped; null when unknown.
 * @property {boolean} unreadable No JSONL location, or the header was unreadable.
 */

/**
 * @typedef {object} StoreIndex
 * @property {number} generatedAt `now` of the build.
 * @property {{ allowPermanentDelete: boolean, recentActivityMinutes: number, listLimit: number, refreshMs: number, indexWarnBytes: number }} config
 * @property {string | null} storeRoot Common ancestor of the location paths (storeRootOf), null when there is none.
 * @property {IndexRow[]} rows Sorted by id, then folder.
 * @property {{ id: string, name: string | null, path: string | null }[]} workspaces Registry, sorted by id.
 * @property {object[]} units Evaluated prune units (lineage evaluate() output) with `workspaceId` set to the root's
 *   own or inherited workspace and the D11 refusal added; every reason is kept.
 * @property {{ row: object, lastMs: number | null, fields: string[] }[]} archivedRows One Archived-tab row per unit;
 *   `fields` are the lower-cased root id, title and workspace name the text filter searches.
 * @property {number} missing Archived ids with no stored session.
 * @property {{ count: number, bytes: number }} headerless Snapshots without a readable header id.
 */

const isId = (value) => typeof value === 'string' && value.length > 0
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const size = (value) => (finite(value) && value >= 0 ? Math.floor(value) : null)
const time = (value) => (finite(value) ? Math.floor(value) : null)
const token = (value) => ((isId(value) && value.length <= 512) || finite(value) ? value : null)
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const newest = (a, b) => (a === null ? b : b === null ? a : Math.max(a, b))

/** A clean absolute POSIX path: no empty, `.` or `..` segment, no control character or backslash. */
const isCleanAbsolute = (path) => {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 4096 || UNSAFE_CHARS.test(path)) return false
  return path.slice(1).split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}
const parentOf = (path) => {
  const at = path.lastIndexOf('/')
  return at < 0 ? null : at === 0 ? '/' : path.slice(0, at)
}
const nameOf = (path) => (path === null ? null : path.slice(path.lastIndexOf('/') + 1) || null)

/** Runs `fn`, sync or async; a throw or rejection gives undefined. */
const attempt = async (fn) => {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

/** Maps `items` through async `fn` with at most `limit` calls in flight; keeps the order. */
const mapLimit = async (items, limit, fn) => {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const at = next
      next += 1
      out[at] = await fn(items[at])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

const cleanTitle = (value) => {
  if (typeof value !== 'string') return null
  const text = value.replace(CONTROL_RUNS, ' ').trim()
  if (text.length === 0) return null
  if (text.length <= TITLE_MAX) return text
  let cut = TITLE_MAX - 1
  const code = text.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1 // never split a surrogate pair
  return `${text.slice(0, cut).trimEnd()}…`
}

const idList = (value, label) => {
  if (value === null || typeof value !== 'object' || typeof value[Symbol.iterator] !== 'function') {
    throw new TypeError(`buildIndex: facts.${label}() must give an iterable of session ids`)
  }
  return [...new Set([...value].filter(isId))].sort(byString)
}

const pickConfig = (config) => {
  if (!isPlain(config)) throw new TypeError('buildIndex: options.config must be the resolved plugin config')
  const int = (key, min) => {
    const value = config[key]
    if (!Number.isSafeInteger(value) || value < min) throw new TypeError(`buildIndex: config.${key} must be an integer of at least ${min}`)
    return value
  }
  if (typeof config.allowPermanentDelete !== 'boolean') throw new TypeError('buildIndex: config.allowPermanentDelete must be a boolean')
  return Object.freeze({
    allowPermanentDelete: config.allowPermanentDelete,
    recentActivityMinutes: int('recentActivityMinutes', 0),
    listLimit: int('listLimit', 1),
    refreshMs: int('refreshMs', 0),
    indexWarnBytes: int('indexWarnBytes', 0),
  })
}

// ---------------------------------------------------------------------------
// Projection. Two snapshot shapes are accepted:
// - the persistence snapshot of the host (docs/store-safety.md, API table):
//   { header: { id, createdAt, cwd?, parentSession?, origin?, … }, formatStatus?,
//     revision, eventCount?, sizeBytes?, location?: { kind, path } };
// - the contract SessionSnapshot (src/contract.js): { id, parentId, dir,
//   logPath, group, bytes, events, createdAt, lastActivityAt, unreadable }.
// A draft holds primitives only; the snapshot is dropped right after.
// ---------------------------------------------------------------------------

const fromPersistence = (snapshot) => {
  const header = isPlain(snapshot.header) ? snapshot.header : null
  const location = isPlain(snapshot.location) ? snapshot.location : null
  const logPath = location !== null && location.kind === 'jsonl' && isId(location.path) ? location.path : null
  const sizeHint = size(snapshot.sizeBytes)
  if (header === null || !isId(header.id)) return { id: null, logPath, sizeHint }
  const dir = logPath === null ? null : parentOf(logPath)
  return {
    id: header.id,
    parentId: isId(header.parentSession) ? header.parentSession : null,
    createdAt: time(header.createdAt),
    cwd: isId(header.cwd) ? header.cwd : null,
    subagent: header.origin === 'subagent',
    legacy: snapshot.formatStatus === 'migration-required',
    revision: token(snapshot.revision),
    events: size(snapshot.eventCount),
    dir,
    logPath,
    workspaceDir: dir === null ? null : nameOf(parentOf(dir)),
    unreadable: logPath === null,
    sizeHint,
    activityHint: null,
  }
}

const fromContract = (snapshot) => {
  const logPath = isId(snapshot.logPath) ? snapshot.logPath : null
  const sizeHint = size(snapshot.bytes) ?? size(snapshot.sizeBytes)
  if (!isId(snapshot.id)) return { id: null, logPath, sizeHint }
  const dir = isId(snapshot.dir) ? snapshot.dir : logPath === null ? null : parentOf(logPath)
  return {
    id: snapshot.id,
    parentId: isId(snapshot.parentId) ? snapshot.parentId : null,
    createdAt: time(snapshot.createdAt),
    cwd: isId(snapshot.cwd) ? snapshot.cwd : null,
    subagent: typeof snapshot.origin === 'string' ? snapshot.origin === 'subagent' : null,
    legacy: snapshot.formatStatus === 'migration-required',
    revision: token(snapshot.revision),
    events: size(snapshot.events) ?? size(snapshot.eventCount),
    dir,
    logPath,
    workspaceDir: isId(snapshot.group) ? snapshot.group : dir === null ? null : nameOf(parentOf(dir)),
    unreadable: snapshot.unreadable === true || logPath === null,
    sizeHint,
    activityHint: time(snapshot.lastActivityAt),
  }
}

const project = (snapshot) => {
  if (!isPlain(snapshot)) return { id: null, logPath: null, sizeHint: null }
  const persistence = Object.hasOwn(snapshot, 'header') || Object.hasOwn(snapshot, 'location')
  return persistence ? fromPersistence(snapshot) : fromContract(snapshot)
}

/**
 * The store root: the common ancestor of the location paths, taken above the
 * project folders of the layout `<root>/<project>/<session>/<log>`, so one
 * session or one project still gives the root. Paths that are not clean
 * absolute paths, or too short for the layout, are ignored (the lineage engine
 * refuses their sessions as path-unsafe). Null when no path qualifies or the
 * paths share nothing below `/`.
 * @param {Iterable<string>} paths
 * @returns {string | null}
 */
export function storeRootOf(paths) {
  let common = null
  for (const path of paths) {
    if (!isCleanAbsolute(path)) continue
    const parts = path.slice(1).split('/')
    if (parts.length < 4) continue
    const base = parts.slice(0, -3)
    if (common === null) {
      common = base
      continue
    }
    let same = 0
    while (same < common.length && same < base.length && common[same] === base[same]) same += 1
    common = common.slice(0, same)
    if (common.length === 0) return null
  }
  return common === null ? null : `/${common.join('/')}`
}

const sortReasons = (reasons, memberIds) => {
  const at = new Map(memberIds.map((id, index) => [id, index]))
  const seen = new Set()
  return reasons
    .filter(({ code, sessionId }) => {
      const key = `${code}\u0000${sessionId}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => (at.get(a.sessionId) ?? -1) - (at.get(b.sessionId) ?? -1) || CODE_ORDER.get(a.code) - CODE_ORDER.get(b.code))
}

/** The first reason of each refusal code, in unit order: what an Archived row shows. */
const firstPerCode = (reasons) => {
  const seen = new Set()
  const out = []
  for (const { code, sessionId } of reasons) {
    if (seen.has(code)) continue
    seen.add(code)
    out.push({ code, sessionId })
  }
  return out
}

// ---------------------------------------------------------------------------
// buildIndex
// ---------------------------------------------------------------------------

/**
 * Builds the store index from a HostFacts adapter. Calls only the read methods
 * snapshots (once), workspaces, archivedIds, pinnedIds, liveIds, statLog (each
 * clean log path, and the folders of archived-tree members), titleOf (each
 * readable row) and lockState (the folders of archived-tree members); a path
 * that is not a clean absolute path is never handed to the host. A failing
 * lookup fails safe: no title, no stat (no-location), an unknown lock (locked).
 * @param {object} facts HostFacts (src/contract.js).
 * @param {{ config: object, now: number, folderBytes?: (dir: string) => number | undefined | Promise<number | undefined> }} options
 *   `config`: the resolved plugin config; `now`: ms since the epoch;
 *   `folderBytes`: on-disk sum of the files of one session folder (lstat of each file), preferred over sizeBytes
 *   because a folder can hold retained historical generations (docs/store-safety.md, Cost).
 * @returns {Promise<StoreIndex>}
 */
export async function buildIndex(facts, options = {}) {
  if (!isPlain(facts)) throw new TypeError('buildIndex: facts must be a HostFacts adapter')
  for (const name of FACT_METHODS) {
    if (typeof facts[name] !== 'function') throw new TypeError(`buildIndex: facts.${name} must be a function`)
  }
  const config = pickConfig(options?.config)
  const { now } = options
  if (!finite(now)) throw new TypeError('buildIndex: options.now must be a finite number of ms')
  const folderBytes = options.folderBytes ?? null
  if (folderBytes !== null && typeof folderBytes !== 'function') throw new TypeError('buildIndex: options.folderBytes must be a function')

  const snapshots = await facts.snapshots()
  if (!Array.isArray(snapshots)) throw new TypeError('buildIndex: facts.snapshots() must give an array')
  const workspaceFacts = await facts.workspaces()
  if (!Array.isArray(workspaceFacts)) throw new TypeError('buildIndex: facts.workspaces() must give an array')
  const archivedList = idList(await facts.archivedIds(), 'archivedIds')
  const pinned = new Set(idList(await facts.pinnedIds(), 'pinnedIds'))
  const liveList = idList(await facts.liveIds(), 'liveIds')
  const archived = new Set(archivedList)
  const live = new Set(liveList)

  // Registry: workspaces by id, and the workspace of each registered id (the
  // smallest workspace id that lists it, as the lineage engine does).
  const workspaces = []
  const registered = new Map()
  const lineageWorkspaces = []
  for (const workspace of workspaceFacts) {
    if (!isPlain(workspace) || !isId(workspace.id)) continue
    const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds.filter(isId) : []
    workspaces.push({ id: workspace.id, name: isId(workspace.name) ? workspace.name : null, path: isId(workspace.path) ? workspace.path : null })
    lineageWorkspaces.push({ id: workspace.id, sessionIds })
    for (const id of sessionIds) {
      const held = registered.get(id)
      if (held === undefined || byString(workspace.id, held) < 0) registered.set(id, workspace.id)
    }
  }
  workspaces.sort((a, b) => byString(a.id, b.id))

  // Projection, then the store root over every JSONL location path.
  const drafts = []
  const headerless = { count: 0, bytes: 0 }
  const locations = []
  for (const snapshot of snapshots) {
    const draft = project(snapshot)
    if (draft.logPath !== null) locations.push(draft.logPath)
    if (draft.id === null) {
      headerless.count += 1
      headerless.bytes += draft.sizeHint ?? 0
    } else drafts.push(draft)
  }
  const storeRoot = storeRootOf(locations)

  // File metadata and titles. The log stats are reused for the lineage checks.
  const stats = new Map()
  const rows = await mapLimit(drafts, CONCURRENCY, async (draft) => {
    let stat = null
    if (draft.logPath !== null && isCleanAbsolute(draft.logPath)) {
      const value = await attempt(() => facts.statLog(draft.logPath))
      stat = isPlain(value) ? { ...value } : NO_STAT
      stats.set(draft.logPath, stat)
    }
    const present = stat !== null && stat.exists === true
    const folder = folderBytes !== null && draft.dir !== null && isCleanAbsolute(draft.dir)
      ? size(await attempt(() => folderBytes(draft.dir)))
      : null
    const title = draft.unreadable ? null : cleanTitle(await attempt(() => facts.titleOf(draft.id)))
    return {
      id: draft.id,
      parentId: draft.parentId,
      createdAt: draft.createdAt,
      cwd: draft.cwd,
      subagent: draft.subagent,
      child: !draft.unreadable && draft.parentId !== null && draft.subagent !== false,
      legacy: draft.legacy,
      revision: draft.revision,
      bytes: folder ?? draft.sizeHint ?? (present ? size(stat.bytes) : null) ?? 0,
      events: draft.events,
      lastActivityMs: (present ? time(stat.mtimeMs) : null) ?? draft.activityHint,
      dir: draft.dir,
      logPath: draft.logPath,
      workspaceDir: draft.workspaceDir,
      workspaceId: null,
      archived: archived.has(draft.id),
      pinned: pinned.has(draft.id),
      live: live.has(draft.id),
      title,
      unreadable: draft.unreadable,
    }
  })
  rows.sort((a, b) => byString(a.id, b.id) || byString(a.dir ?? '', b.dir ?? '') || byString(a.logPath ?? '', b.logPath ?? ''))
  const byId = new Map()
  for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, row)

  // Workspace of each row: its own registration, else the nearest registered
  // ancestor's (a missing ancestor can still be registered: a ghost id).
  const effective = new Map()
  const workspaceOf = (start) => {
    const path = []
    const seen = new Set()
    let current = start
    let found = null
    while (current !== null && !seen.has(current)) {
      if (effective.has(current)) {
        found = effective.get(current)
        break
      }
      seen.add(current)
      path.push(current)
      const own = registered.get(current)
      if (own !== undefined) {
        found = own
        break
      }
      current = byId.get(current)?.parentId ?? null
    }
    for (const id of path) effective.set(id, found)
    return found
  }
  for (const row of rows) row.workspaceId = workspaceOf(row.id)

  // Units: the lineage engine with the origin rule for kept descendants.
  const keptIds = rows
    .filter((row) => !row.unreadable && (row.subagent === null ? registered.has(row.id) : row.subagent === false))
    .map((row) => row.id)
  const host = {
    liveIds: () => liveList,
    workspaces: () => lineageWorkspaces,
    lockState: async (folder) => {
      const value = await attempt(() => facts.lockState(folder))
      return isPlain(value) ? value : UNKNOWN_LOCK
    },
    statLog: async (path) => {
      if (stats.has(path)) return stats.get(path)
      const value = await attempt(() => facts.statLog(path))
      return isPlain(value) ? value : NO_STAT
    },
  }
  const found = buildUnits(rows, archivedList)
  const lineageFacts = await collectFacts(host, found, { storeRoot, keptIds })
  const units = evaluate(found, lineageFacts, { recentActivityMinutes: config.recentActivityMinutes }, now).map((unit) => {
    const workspaceId = workspaceOf(unit.rootId)
    const reasons = workspaceId === null
      ? sortReasons([...unit.reasons, { code: 'workspace-missing', sessionId: unit.rootId }], unit.memberIds)
      : unit.reasons
    return { ...unit, workspaceId, status: reasons.length > 0 ? 'blocked' : 'ready', reasons }
  })

  // One Archived-tab row per unit, with what the filters need.
  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]))
  const archivedRows = units.map((unit) => {
    const root = byId.get(unit.rootId)
    const lastMs = time(unit.lastActivityMs)
    const shown = lastMs ?? root?.createdAt ?? null
    const title = root?.title ?? null
    const name = unit.workspaceId === null ? null : names.get(unit.workspaceId) ?? null
    return {
      row: {
        id: unit.rootId,
        title,
        workspaceId: unit.workspaceId,
        bytes: unit.bytes,
        childCount: unit.memberIds.length - 1,
        lastActivityAt: shown === null ? 0 : Math.max(0, shown),
        ageDays: shown === null ? 0 : Math.max(0, Math.floor((now - shown) / DAY_MS)),
        blocked: unit.status === 'blocked',
        reasons: firstPerCode(unit.reasons),
        orphan: unit.orphan === true,
      },
      lastMs,
      fields: [unit.rootId, title, name].filter(isId).map((value) => value.toLowerCase()),
    }
  })

  return {
    generatedAt: Math.floor(now),
    config,
    storeRoot,
    rows,
    workspaces,
    units,
    archivedRows,
    missing: archivedList.filter((id) => !byId.has(id)).length,
    headerless,
  }
}

// ---------------------------------------------------------------------------
// summarize and overview
// ---------------------------------------------------------------------------

const checkIndex = (index, label) => {
  if (!isPlain(index) || !Array.isArray(index.rows) || !Array.isArray(index.units) || !Array.isArray(index.archivedRows) || !isPlain(index.config)) {
    throw new TypeError(`${label}: index must come from buildIndex()`)
  }
}

const tableRow = (id, name, path, folder) => ({ id, name, path, folder, sessions: 0, archived: 0, bytes: 0, lastActivityAt: null })

/**
 * The dashboard figures, host-side: the five cards, the workspace table with
 * each row's share of the on-disk total (for the bar), the largest sessions
 * and the search-index health. overview() sends the contract subset of it.
 * @param {StoreIndex} index
 */
export function summarize(index) {
  checkIndex(index, 'summarize')
  const total = { sessions: index.rows.length + index.headerless.count, live: 0, archived: 0, children: 0, unreadable: index.headerless.count, missing: index.missing }
  let bytes = index.headerless.bytes
  let events = 0
  let eventsKnown = false

  const registeredRows = new Map(index.workspaces.map((w) => [w.id, tableRow(w.id, w.name, w.path, null)]))
  const looseRows = new Map()
  for (const row of index.rows) {
    if (row.live) total.live += 1
    if (row.archived) total.archived += 1
    if (row.child) total.children += 1
    if (row.unreadable) total.unreadable += 1
    bytes += row.bytes
    if (row.events !== null) {
      events += row.events
      eventsKnown = true
    }
    let entry = row.workspaceId === null ? undefined : registeredRows.get(row.workspaceId)
    if (entry === undefined) {
      const key = row.workspaceDir ?? '\u0000'
      entry = looseRows.get(key)
      if (entry === undefined) {
        entry = tableRow(null, null, null, row.workspaceDir)
        looseRows.set(key, entry)
      }
    }
    entry.sessions += 1
    if (row.archived) entry.archived += 1
    entry.bytes += row.bytes
    entry.lastActivityAt = newest(entry.lastActivityAt, row.lastActivityMs)
  }

  // Unassigned rows: one per store folder, largest first; the row without a
  // folder comes last and also takes the folders beyond UNASSIGNED_ROWS_MAX.
  const bySize = (a, b) => b.bytes - a.bytes || byString(a.name ?? a.folder ?? '', b.name ?? b.folder ?? '') || byString(a.id ?? '', b.id ?? '')
  const named = [...looseRows.values()].filter((entry) => entry.folder !== null).sort(bySize)
  const unnamed = looseRows.get('\u0000') ?? null
  let loose = unnamed === null ? named : [...named, unnamed]
  if (loose.length > UNASSIGNED_ROWS_MAX) {
    const other = tableRow(null, null, null, null)
    for (const entry of [...named.slice(UNASSIGNED_ROWS_MAX - 1), ...(unnamed === null ? [] : [unnamed])]) {
      other.sessions += entry.sessions
      other.archived += entry.archived
      other.bytes += entry.bytes
      other.lastActivityAt = newest(other.lastActivityAt, entry.lastActivityAt)
    }
    loose = [...named.slice(0, UNASSIGNED_ROWS_MAX - 1), other]
  }
  const workspaces = [...[...registeredRows.values()].sort(bySize), ...loose].map((entry) => ({ ...entry, share: bytes > 0 ? entry.bytes / bytes : 0 }))

  const largestRows = [...index.rows].sort((a, b) => b.bytes - a.bytes || byString(a.id, b.id)).slice(0, MAX_LARGEST).map((row) => ({
    id: row.id,
    title: row.title,
    workspaceId: row.workspaceId,
    bytes: row.bytes,
    events: row.events,
    lastActivityAt: Math.max(0, row.lastActivityMs ?? row.createdAt ?? 0),
    live: row.live,
    archived: row.archived,
    child: row.child,
  }))

  const archivedCard = { bytes: 0, roots: index.units.length, children: 0 }
  const reclaimable = { bytes: 0, units: 0, blockedUnits: 0, blockedBytes: 0 }
  for (const unit of index.units) {
    archivedCard.bytes += unit.bytes
    archivedCard.children += unit.memberIds.length - 1
    if (unit.status === 'ready') {
      reclaimable.bytes += unit.bytes
      reclaimable.units += 1
    } else {
      reclaimable.blockedBytes += unit.bytes
      reclaimable.blockedUnits += 1
    }
  }

  return {
    total,
    onDisk: { bytes, basis: 'on-disk' },
    archived: archivedCard,
    reclaimable,
    largest: largestRows[0] ?? null,
    workspaces,
    largestRows,
    health: { bytes, events: eventsKnown ? events : null, tier: bytes >= index.config.indexWarnBytes ? 'warn' : 'normal', basis: 'on-disk' },
  }
}

const pickCapabilities = (index, capabilities) => {
  // No store root is no prune, except for a store that lists nothing at all: the Host may still know the
  // sessions tree from its trash (a batch records it), and then its own verdict stands (service.js rootOf).
  const empty = index.rows.length === 0 && (index.headerless?.count ?? 0) === 0
  if (index.storeRoot === null && !(empty && capabilities !== undefined)) return { prune: false, reason: ERROR.unsupportedBackend }
  if (capabilities === undefined) return { prune: true, reason: null }
  if (!isPlain(capabilities) || typeof capabilities.prune !== 'boolean') throw new TypeError('overview: capabilities must be { prune, reason }')
  if (capabilities.prune) return { prune: true, reason: null }
  if (!CAPABILITY_REASONS.includes(capabilities.reason)) throw new TypeError(`overview: capabilities.reason must be one of ${CAPABILITY_REASONS.join(', ')}`)
  return { prune: false, reason: capabilities.reason }
}

/**
 * The `overview` response (assertOverview in src/contract.js).
 * `capabilities`: the Host's own platform and trash verdict; a null store root
 * gives prune false with sessions-manager/unsupported-backend, unless the store
 * lists no session at all and the Host passed its own verdict (it found the
 * sessions tree in its trash).
 * `storeDir`: the persistence location the Host knows; else the store root;
 * null when there is neither. `largest[].events` is null when the backend gives
 * no event count. `totals.archivedMissing`: archived ids of the registry with
 * no stored log (index.missing); `totals.archived` counts stored sessions only.
 * @param {StoreIndex} index
 * @param {{ capabilities?: { prune: boolean, reason: string | null }, storeDir?: string }} [options]
 */
export function overview(index, options = {}) {
  checkIndex(index, 'overview')
  const summary = summarize(index)
  const { config } = index
  return {
    generatedAt: index.generatedAt,
    storeDir: isId(options.storeDir) ? options.storeDir : index.storeRoot,
    capabilities: pickCapabilities(index, options.capabilities),
    config: {
      allowPermanentDelete: config.allowPermanentDelete,
      recentActivityMinutes: config.recentActivityMinutes,
      listLimit: config.listLimit,
      refreshMs: config.refreshMs,
      indexWarnBytes: config.indexWarnBytes,
    },
    totals: {
      sessions: summary.total.sessions,
      live: summary.total.live,
      archived: summary.total.archived,
      children: summary.total.children,
      unreadable: summary.total.unreadable,
      bytes: summary.onDisk.bytes,
      archivedBytes: summary.archived.bytes,
      archivedRoots: summary.archived.roots,
      archivedChildren: summary.archived.children,
      reclaimableBytes: summary.reclaimable.bytes,
      reclaimableUnits: summary.reclaimable.units,
      blockedUnits: summary.reclaimable.blockedUnits,
      archivedMissing: summary.total.missing,
    },
    indexLoad: summary.health.tier === 'warn' ? 'high' : 'normal',
    workspaces: summary.workspaces.map(({ share, ...entry }) => entry),
    largest: summary.largestRows,
  }
}

// ---------------------------------------------------------------------------
// archivedPage
// ---------------------------------------------------------------------------

const SORTS = {
  bytes: (a, b) => b.row.bytes - a.row.bytes || byString(a.row.id, b.row.id),
  lastActivityAt: (a, b) => b.row.lastActivityAt - a.row.lastActivityAt || byString(a.row.id, b.row.id),
  title: (a, b) => byString((a.row.title ?? a.row.id).toLowerCase(), (b.row.title ?? b.row.id).toLowerCase()) || byString(a.row.id, b.row.id),
}

/**
 * The `archived` response (assertArchivedPage in src/contract.js). Rows are unit
 * roots: the top-most archived session of each tree, or, under an archived id
 * whose log is gone (counted in index.missing, never a row), its top-most
 * stored descendant. Nested archived sessions are counted in their root row.
 * Filters: `workspaceId` (null: Unassigned), `olderThanDays` (newest activity
 * at least that old; unknown activity never matches), `largerThanBytes`
 * (strictly larger), `text` (case-insensitive, in the root id, its title and
 * its workspace name only). A row has `orphan` true exactly when its unit root
 * is an orphan unit (the archived parent has no stored log): the unit is pruned
 * on its own, but Unarchive does not apply. Sort: `bytes` largest first (default),
 * `lastActivityAt` newest first, `title` A to Z (title, else id); ties by id.
 * `limit` defaults to and is capped at config.listLimit. A row lists the first
 * reason of each refusal code; index.units keeps them all.
 * @param {StoreIndex} index
 * @param {object} [request] The `archived` request; invalid ones throw ContractError invalid-request.
 */
export function archivedPage(index, request = {}) {
  checkIndex(index, 'archivedPage')
  assertRequest('archived', request)
  const { listLimit } = index.config
  const limit = Math.min(request.limit ?? listLimit, listLimit)
  const offset = request.offset ?? 0
  const text = (request.text ?? '').trim().toLowerCase()
  const cutoff = request.olderThanDays === undefined ? null : index.generatedAt - request.olderThanDays * DAY_MS
  const filterWorkspace = Object.hasOwn(request, 'workspaceId')

  const matches = index.archivedRows.filter((entry) => (
    (!filterWorkspace || entry.row.workspaceId === request.workspaceId)
    && (cutoff === null || (entry.lastMs !== null && entry.lastMs <= cutoff))
    && (request.largerThanBytes === undefined || entry.row.bytes > request.largerThanBytes)
    && (text === '' || entry.fields.some((field) => field.includes(text)))
  ))
  matches.sort(SORTS[request.sort ?? 'bytes'])
  return {
    total: matches.length,
    offset,
    limit,
    rows: matches.slice(offset, offset + limit).map(({ row }) => ({ ...row, reasons: row.reasons.map((reason) => ({ ...reason })) })),
  }
}
