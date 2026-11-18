// Host adapter of dsh-plugin-sessions: the only module that touches host
// services. The service (src/service.js) and the engines see the host only
// through the object createHostAdapter() returns: the HostFacts read surface
// of src/contract.js (one fresh view per store read), the synchronous checks
// the trash precheck needs, the persistence stat of one id, the session lock
// probe, and the registry steps.
//
// Every service is read lazily with ctx.get() on each call, so a service that
// restarts or appears later is picked up and a missing one reads as "no data".
// The calls used are exactly the ones recorded in docs/store-safety.md (API
// table):
// - sessionPersistence: list() and stat(id); headers and file metadata only.
// - sessions: list() and get(id); the live sessions of this host.
// - workspaceRegistry: list(), get(id), archivedSessionIds, pinnedSessionIds,
//   archiveSession (never with stopActivity), unarchiveSession, pinSession,
//   unpinSession; a Workspace: sessionIds, attachSession, detachSession,
//   insertSessionBefore, status().
// - sessionProjectionCache: cachedSnapshot(header, ['title']) and
//   cachedPredecessorTitle(header); synchronous, no I/O (the title source).
// - profileContext: home.
// It never reads a session log body, never writes the registry's own file or
// the projection-cache folder, and never creates, writes, replaces or removes
// a session.lock: the probe opens it read-only and never creates it.
//
// Session locks (docs/store-safety.md, Locks): session.lock is the target of
// the backend's kernel flock. On darwin the probe opens it with
// O_RDONLY | O_EXLOCK | O_NONBLOCK | O_NOFOLLOW: EAGAIN means another holder
// (`held`), success means present and free (`stale`), ENOENT means the file was
// never written (`none`). A `*.tmp` file in the folder means a publish is in
// flight and counts as held. The folder itself is never followed: a folder
// that is a symbolic link, or that is swapped for one while the probe runs
// (lstat before and after the open), is held with detail `path-unsafe`.
// Elsewhere there is no lock probe, so every folder reads as held and the
// dashboard is read-only (design.md D18).

import nodeFs, { constants } from 'node:fs'
import path from 'node:path'

export const SESSION_LOCK_FILE = 'session.lock'
/** Platforms with a session lock probe. */
export const LOCK_PROBE_PLATFORMS = Object.freeze(['darwin'])
/** darwin <fcntl.h>: O_EXLOCK, an exclusive flock(2) taken by the open itself. */
const O_EXLOCK = 0x20
/** How many following ids of a workspace are recorded as restore anchors. */
export const ANCHORS_MAX = 32
/** Depth of the sub-folders folderBytes() descends into below a session folder. */
const FOLDER_DEPTH = 3
const NO_STAT = Object.freeze({ exists: false, isSymlink: false, mtimeMs: 0, bytes: 0, dev: 0 })
/** Probe detail of a folder that is a symbolic link, not a directory, or swapped during the probe (the refusal code). */
const UNSAFE = 'path-unsafe'

const isId = (value) => typeof value === 'string' && value.length > 0
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const onDisk = (stat) => (Number.isSafeInteger(stat.blocks) && stat.blocks >= 0 ? stat.blocks * 512 : Math.max(0, stat.size || 0))
const ids = (value) => {
  if (value === null || typeof value !== 'object' || typeof value[Symbol.iterator] !== 'function') return []
  return [...value].filter(isId)
}

/** A primitive-only copy of a persistence snapshot: the fields store-index reads, nothing else. */
function compactSnapshot(snapshot) {
  if (!isPlain(snapshot)) return { header: null }
  const header = isPlain(snapshot.header) ? snapshot.header : null
  const location = isPlain(snapshot.location) ? snapshot.location : null
  const out = {
    header: header === null ? null : {
      id: header.id,
      createdAt: header.createdAt,
      ...(isId(header.cwd) ? { cwd: header.cwd } : {}),
      ...(isId(header.parentSession) ? { parentSession: header.parentSession } : {}),
      ...(isId(header.origin) ? { origin: header.origin } : {}),
      isSeeded: header.isSeeded === true,
    },
    revision: snapshot.revision,
  }
  if (snapshot.formatStatus !== undefined) out.formatStatus = snapshot.formatStatus
  if (snapshot.eventCount !== undefined) out.eventCount = snapshot.eventCount
  if (snapshot.sizeBytes !== undefined) out.sizeBytes = snapshot.sizeBytes
  if (location !== null) out.location = { kind: location.kind, path: location.path }
  return out
}

/**
 * Create the host adapter over a Cordis context.
 * @param {object} ctx plugin context; only ctx.get(name) and ctx.logger are read
 * @param {{ fs?: object, platform?: string }} [options] `fs`: node:fs-compatible sync API used by
 *   the lock probe and the folder sizes (default node:fs); `platform`: default process.platform
 */
export function createHostAdapter(ctx, options = {}) {
  const fs = options.fs ?? nodeFs
  const platform = options.platform ?? process.platform
  const lockProbeSupported = LOCK_PROBE_PLATFORMS.includes(platform)
  const PROBE_FLAGS = constants.O_RDONLY | O_EXLOCK | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)

  /** One host service, read now; undefined when it is missing or its lookup throws. */
  const service = (name) => {
    try {
      const value = ctx?.get?.(name)
      return value === null ? undefined : value
    } catch {
      return undefined
    }
  }
  const persistence = () => service('sessionPersistence')
  const registry = () => service('workspaceRegistry')
  const liveSessions = () => service('sessions')
  const projections = () => service('sessionProjectionCache')

  const needRegistry = () => {
    const value = registry()
    if (value === undefined) throw Object.assign(new Error('the workspace registry is not available'), { code: 'registry-missing' })
    return value
  }

  // --- registry reads (synchronous) -----------------------------------------

  /** Workspaces as plain data; a registry whose list() throws reads as none. */
  function workspaceList() {
    const value = registry()
    if (value === undefined || typeof value.list !== 'function') return []
    let list
    try {
      list = value.list()
    } catch {
      return []
    }
    if (!Array.isArray(list)) return []
    const out = []
    for (const workspace of list) {
      if (workspace === null || typeof workspace !== 'object') continue
      const id = workspace.id
      if (!isId(id)) continue
      const where = isId(workspace.path) ? workspace.path : null
      const title = isId(workspace.title) ? workspace.title : where === null ? null : path.basename(where) || where
      out.push({ id, name: title, path: where, sessionIds: ids(workspace.sessionIds) })
    }
    return out
  }

  const archivedIds = () => {
    try {
      return ids(registry()?.archivedSessionIds)
    } catch {
      return []
    }
  }
  const pinnedIds = () => {
    try {
      return ids(registry()?.pinnedSessionIds)
    } catch {
      return []
    }
  }

  /**
   * The registry order of every registered session: its workspace (the
   * smallest workspace id that lists it, as the lineage engine picks), its
   * position there, and the ids that follow it (the restore anchors).
   * @returns {Map<string, { workspaceId: string, position: number, anchors: string[] }>}
   */
  function workspaceOrder() {
    const out = new Map()
    for (const workspace of [...workspaceList()].sort((a, b) => byString(a.id, b.id))) {
      workspace.sessionIds.forEach((id, position) => {
        if (out.has(id)) return
        out.set(id, { workspaceId: workspace.id, position, anchors: workspace.sessionIds.slice(position + 1, position + 1 + ANCHORS_MAX) })
      })
    }
    return out
  }

  /** One workspace as plain data, or undefined. */
  function workspace(id) {
    if (!isId(id)) return undefined
    try {
      const found = registry()?.get?.(id)
      if (found === undefined || found === null) return undefined
      return { id, sessionIds: ids(found.sessionIds) }
    } catch {
      return undefined
    }
  }

  // --- live sessions (synchronous) ------------------------------------------

  const liveIds = () => {
    const value = liveSessions()
    if (value === undefined || typeof value.list !== 'function') return []
    try {
      return ids((value.list() ?? []).map((session) => session?.id))
    } catch {
      return []
    }
  }

  /** Whether the host holds `id` live. Fails closed: no live-session service, or a throw, reads as live. */
  function isLive(id) {
    const value = liveSessions()
    if (value === undefined || typeof value.get !== 'function') return true
    try {
      return value.get(id) !== undefined
    } catch {
      return true
    }
  }

  // --- file metadata ---------------------------------------------------------

  /** lstat of a path; a symbolic link is reported, never followed. Any failure reads as missing. */
  function statLog(target) {
    try {
      const stat = fs.lstatSync(target)
      return { exists: true, isSymlink: stat.isSymbolicLink(), mtimeMs: stat.mtimeMs, bytes: stat.size, dev: stat.dev }
    } catch {
      return { ...NO_STAT }
    }
  }

  /** On-disk bytes of the files of a session folder (lstat only; links are not followed); undefined when unreadable. */
  function folderBytes(dir) {
    const walk = (folder, depth) => {
      let total = 0
      for (const name of fs.readdirSync(folder)) {
        const entry = path.join(folder, name)
        let stat
        try {
          stat = fs.lstatSync(entry)
        } catch {
          continue
        }
        if (stat.isFile()) total += onDisk(stat)
        else if (stat.isDirectory() && depth < FOLDER_DEPTH) {
          try {
            total += walk(entry, depth + 1)
          } catch { /* an unreadable sub-folder counts as empty */ }
        }
      }
      return total
    }
    try {
      return walk(dir, 0)
    } catch {
      return undefined
    }
  }

  // --- session locks -----------------------------------------------------------

  /**
   * Probe the session lock of a folder (rule above). With `hold`, a free lock
   * stays taken until the returned release() runs: no host can open the
   * session for writing meanwhile. Synchronous, for the trash precheck.
   *
   * The folder is never followed. It is lstat'ed first: a symbolic link, or
   * anything but a directory, is refused unprobed. The lock file is opened
   * with O_NOFOLLOW, which guards only its own name, so the folder is lstat'ed
   * again after the open: a folder swapped for a link (or another folder)
   * while the probe ran is refused, and the descriptor opened through it is
   * closed. Every such refusal is `held` with detail `path-unsafe`; the trash
   * precheck answers it with the refusal `path-unsafe`.
   * @returns {{ state: 'none' | 'stale' | 'held', detail: string, release: (() => void) | null }}
   */
  function probeLock(folder, hold) {
    const held = (detail) => ({ state: 'held', detail, release: null })
    const absent = () => ({ state: 'none', detail: 'absent', release: null })
    if (!lockProbeSupported) return held('unsupported-platform')
    if (!isId(folder) || !path.isAbsolute(folder)) return held('bad-path')
    let first
    try {
      first = fs.lstatSync(folder)
    } catch (error) {
      if (error?.code === 'ENOENT') return { state: 'none', detail: 'no-folder', release: null }
      return held(error?.code === 'ENOTDIR' || error?.code === 'ELOOP' ? UNSAFE : 'unreadable')
    }
    if (first.isSymbolicLink() || !first.isDirectory()) return held(UNSAFE)
    /** The folder is still the real folder the first lstat saw (same device and inode, not a link). */
    const unchanged = () => {
      try {
        const now = fs.lstatSync(folder)
        return !now.isSymbolicLink() && now.isDirectory() && now.dev === first.dev && now.ino === first.ino
      } catch {
        return false
      }
    }
    let names
    try {
      names = fs.readdirSync(folder)
    } catch (error) {
      return error?.code === 'ENOENT' ? { state: 'none', detail: 'no-folder', release: null } : held('unreadable')
    }
    if (names.some((name) => name.endsWith('.tmp'))) return held('busy')
    if (!names.includes(SESSION_LOCK_FILE)) return unchanged() ? absent() : held(UNSAFE)
    let fd
    try {
      fd = fs.openSync(path.join(folder, SESSION_LOCK_FILE), PROBE_FLAGS)
    } catch (error) {
      if (error?.code === 'ENOENT') return unchanged() ? absent() : held(UNSAFE)
      if (error?.code === 'EAGAIN' || error?.code === 'EWOULDBLOCK') return held('held')
      return held('unknown')
    }
    let closed = false
    const release = () => {
      if (closed) return
      closed = true
      try { fs.closeSync(fd) } catch { /* already closed */ }
    }
    try {
      if (!fs.fstatSync(fd).isFile()) {
        release()
        return held('not-a-file')
      }
    } catch {
      release()
      return held('unknown')
    }
    if (!unchanged()) {
      release()
      return held(UNSAFE)
    }
    if (!hold) {
      release()
      return { state: 'stale', detail: 'free', release: null }
    }
    return { state: 'stale', detail: 'free', release }
  }

  // --- persistence -------------------------------------------------------------

  /** A compact persistence stat of one id, or undefined when the backend does not list it. Rejections propagate. */
  async function stat(id) {
    const value = persistence()
    if (value === undefined || typeof value.stat !== 'function') {
      throw Object.assign(new Error('session persistence is not available'), { code: 'persistence-missing' })
    }
    const snapshot = await value.stat(id)
    if (snapshot === undefined || snapshot === null) return undefined
    const location = isPlain(snapshot.location) ? snapshot.location : null
    return {
      id: snapshot.header?.id ?? id,
      revision: snapshot.revision ?? null,
      sizeBytes: Number.isSafeInteger(snapshot.sizeBytes) ? snapshot.sizeBytes : null,
      path: location !== null && location.kind === 'jsonl' && isId(location.path) ? location.path : null,
      formatStatus: snapshot.formatStatus ?? null,
    }
  }

  /** The cheap title of a header: the projection-cache row, else the pre-migration row; null on a miss. */
  function titleOf(header) {
    if (!isPlain(header)) return null
    const cache = projections()
    if (cache === undefined) return null
    try {
      const row = cache.cachedSnapshot?.(header, ['title'])
      const title = row?.values?.title
      if (typeof title === 'string') return title
      const previous = cache.cachedPredecessorTitle?.(header)?.values?.title
      return typeof previous === 'string' ? previous : null
    } catch {
      return null
    }
  }

  /**
   * One HostFacts view (src/contract.js) for one store read. The headers it
   * sees live only in this view, for the title lookup, and go with it.
   */
  function facts() {
    const headers = new Map()
    return {
      async snapshots() {
        const value = persistence()
        if (value === undefined || typeof value.list !== 'function') return []
        const list = await value.list()
        const out = []
        for (const snapshot of Array.isArray(list) ? list : []) {
          const compact = compactSnapshot(snapshot)
          if (isId(compact.header?.id) && isPlain(snapshot.header)) headers.set(compact.header.id, snapshot.header)
          out.push(compact)
        }
        return out
      },
      workspaces: () => workspaceList(),
      archivedIds,
      pinnedIds,
      liveIds,
      lockState: (folder) => {
        const { state, detail } = probeLock(folder, false)
        // A folder the probe refuses unprobed (a link, not a directory) is left to the lineage engine's own lstat,
        // which refuses it as path-unsafe or no-location; reading it as held would add a `locked` it does not have.
        return { state: detail === UNSAFE ? 'none' : state, pid: null }
      },
      statLog,
      titleOf: (id) => titleOf(headers.get(id)),
    }
  }

  // --- registry steps ----------------------------------------------------------

  return Object.freeze({
    platform,
    lockProbeSupported,
    /** The DSH home from the launcher's profile data, or undefined. */
    home() {
      const home = service('profileContext')?.home
      return typeof home === 'string' ? home : undefined
    },
    /** Log one warning through the plugin logger; never throws. */
    warn(message) {
      try {
        const logger = ctx?.logger
        if (typeof logger?.warn === 'function') logger.warn(message)
        else if (typeof logger === 'function') logger('sessions-manager').warn(message)
      } catch { /* no usable logger */ }
    },
    /** Which of the services a prune needs are present. */
    services() {
      const value = persistence()
      return {
        persistence: value !== undefined && typeof value.list === 'function' && typeof value.stat === 'function',
        registry: registry() !== undefined,
        live: liveSessions() !== undefined,
      }
    },
    facts,
    folderBytes,
    workspaceOrder,
    workspace,
    /** The live directory check of a workspace: 'ok', 'missing-dir', or 'missing' when the registry does not hold it. */
    async workspaceStatus(id) {
      let found
      try {
        found = registry()?.get?.(id)
      } catch {
        return 'missing'
      }
      if (found === undefined || found === null) return 'missing'
      try {
        return (await found.status?.()) === 'missing-dir' ? 'missing-dir' : 'ok'
      } catch {
        return 'ok'
      }
    },
    isLive,
    isArchived: (id) => archivedIds().includes(id),
    isPinned: (id) => pinnedIds().includes(id),
    isMember: (id, workspaceId) => workspace(workspaceId)?.sessionIds.includes(id) === true,
    /** Lock state of a folder: 'none', 'stale' or 'held' (busy, unknown, unsupported and an unsafe folder read as held). */
    lockState: (folder) => probeLock(folder, false).state,
    /** Probe and, when free, keep the lock until release(). Synchronous. Detail `path-unsafe`: a link, no directory, or swapped while probed. */
    holdLock: (folder) => probeLock(folder, true),
    stat,

    async unpin(id) { await needRegistry().unpinSession(id) },
    async unarchive(id) { await needRegistry().unarchiveSession(id) },
    async archive(id) { await needRegistry().archiveSession(id) },
    async pin(id) { await needRegistry().pinSession(id) },
    /** Detach from one workspace; 'skipped' when the registry no longer holds that workspace. */
    async detach(id, workspaceId) {
      const found = needRegistry().get(workspaceId)
      if (found === undefined || found === null) return 'skipped'
      await found.detachSession(id)
      return 'ok'
    },
    /**
     * Attach to one workspace and check membership afterwards (an attach can
     * resolve without attaching): 'ok', 'not-attached', or 'workspace-missing'.
     */
    async attach(id, workspaceId) {
      const reg = needRegistry()
      const found = reg.get(workspaceId)
      if (found === undefined || found === null) return 'workspace-missing'
      await found.attachSession(id)
      const after = reg.get(workspaceId)
      return ids(after?.sessionIds).includes(id) ? 'ok' : 'not-attached'
    },
    /**
     * Move an attached session before the first recorded anchor that is still
     * in the workspace, or to the end when none is: 'ok', 'skipped' (already
     * there), 'not-attached' or 'workspace-missing'.
     */
    async insertBefore(id, workspaceId, anchors) {
      const found = needRegistry().get(workspaceId)
      if (found === undefined || found === null) return 'workspace-missing'
      const order = ids(found.sessionIds)
      const at = order.indexOf(id)
      if (at < 0) return 'not-attached'
      const anchor = ids(anchors).find((candidate) => candidate !== id && order.includes(candidate))
      const next = order[at + 1]
      if ((anchor === undefined && at === order.length - 1) || (anchor !== undefined && next === anchor)) return 'skipped'
      if (anchor === undefined) await found.insertSessionBefore(id)
      else await found.insertSessionBefore(id, anchor)
      return 'ok'
    },
  })
}
