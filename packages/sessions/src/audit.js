import { accessSync, constants, lstatSync, promises as fs } from 'node:fs'
import path from 'node:path'

// The append-only audit log of the Sessions manager, in the plugin data
// directory, dataDir:
//   <dataDir>/audit.jsonl   one O_APPEND|O_NOFOLLOW write per line, mode 0600
// The folder is created with mode 0700. Several hosts of this plugin can share
// the folder: every write is one append. There is no rotation in v1 (D16).
//
// What a line holds is an allow-list (sanitizeRecord): ids, counts, byte sizes,
// reason codes and outcomes. Any other key is dropped, and every string is a
// short token without spaces, so no title, prompt or message text can be
// recorded. A line is never read back as a source of truth; it is a trace.
//
// Failing closed: appendStart() throws, so the caller aborts before it moves
// anything. Every later append() returns a result with an 'audit-failed'
// warning and never throws.
// dataDir comes from the caller; this module reads no environment variables.

export const AUDIT_FILE = 'audit.jsonl'
export const AUDIT_VERSION = 1
/** Largest line, in UTF-8 bytes, newline included. A bigger record is refused, not cut. */
export const MAX_LINE_BYTES = 4 * 1024 * 1024
/** Most session entries one record can carry. */
export const MAX_SESSIONS = 20000
/** Most reason entries one record can carry. */
export const MAX_REASONS = 20000
/** Upper bound of the bytes tail() reads from the end of the file. */
export const MAX_TAIL_BYTES = 1024 * 1024
/** Upper bound of the lines tail() returns. */
export const MAX_TAIL_LINES = 1000

/** The code of the warning the contract defines for a failed append. */
export const AUDIT_FAILED = 'audit-failed'

const OPS = new Set(['plan', 'apply-start', 'unit-moved', 'unit-skipped', 'registry-step', 'apply-end', 'recover'])
const OP_FAMILIES = /^(restore|purge)-[a-z][a-z0-9-]{0,31}$/
// One safe token: no space, no control character, no quote or backtick. Ids,
// digests, codes and versions fit it; free text (a title) does not.
const TOKEN = /^[A-Za-z0-9_][A-Za-z0-9_.:@+=/-]{0,127}$/
const COUNT_KEY = /^[A-Za-z][A-Za-z0-9]{0,31}$/
const MAX_COUNT_KEYS = 32
const MAX_PRINCIPAL_KEYS = 8
// 'a' plus O_NOFOLLOW: never append through a symlinked audit file.
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0)
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
const NEWLINE = Buffer.from('\n')
const RECORD_START = `{"v":${AUDIT_VERSION},`

const errorCode = (error) => error?.code ?? (error instanceof Error ? error.message : String(error))
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const token = (value) => (typeof value === 'string' && TOKEN.test(value) ? value : undefined)
const nullableToken = (value) => (value === null ? null : token(value))
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : undefined)

/** An error with a stable `code`; the caller of appendStart() aborts on it. */
export class AuditError extends Error {
  constructor(message, code = AUDIT_FAILED, options) {
    super(message, options)
    this.name = 'AuditError'
    this.code = code
  }
}

function sanitizeTimestamp(value) {
  if (typeof value !== 'string' || value.length > 40) return undefined
  const time = Date.parse(value)
  return Number.isNaN(time) ? undefined : new Date(time).toISOString()
}

function sanitizeCounts(value) {
  if (!isObject(value)) return undefined
  const out = {}
  let keys = 0
  for (const key of Object.keys(value)) {
    if (!COUNT_KEY.test(key)) continue
    const number = count(value[key])
    if (number === undefined) continue
    if (++keys > MAX_COUNT_KEYS) break
    out[key] = number
  }
  return out
}

function sanitizeSession(item) {
  if (!isObject(item)) return undefined
  const id = token(item.id)
  const bytes = count(item.bytes)
  if (id === undefined || bytes === undefined) return undefined
  const workspaceId = item.workspaceId === undefined ? null : nullableToken(item.workspaceId)
  const parent = item.parent === undefined ? null : nullableToken(item.parent)
  if (workspaceId === undefined || parent === undefined) return undefined
  return { id, workspaceId, parent, archived: item.archived === true, pinned: item.pinned === true, bytes }
}

function sanitizeReason(item) {
  if (!isObject(item)) return undefined
  const code = token(item.code)
  const sessionId = item.sessionId === undefined ? null : nullableToken(item.sessionId)
  if (code === undefined || sessionId === undefined) return undefined
  return { code, sessionId }
}

function sanitizeList(value, one, limit) {
  if (!Array.isArray(value)) return undefined
  const out = []
  for (const item of value) {
    if (out.length >= limit) break
    const clean = one(item)
    if (clean !== undefined) out.push(clean)
  }
  return out
}

/** The caller identity: a shallow object of tokens, numbers and flags; no credential belongs here. */
function sanitizePrincipal(value) {
  if (!isObject(value)) return undefined
  const kind = token(value.kind)
  if (kind === undefined) return undefined
  const out = { kind }
  let keys = 1
  for (const key of Object.keys(value)) {
    if (key === 'kind' || !COUNT_KEY.test(key)) continue
    const item = value[key]
    const clean = typeof item === 'string' ? token(item) : typeof item === 'boolean' ? item : count(item)
    if (clean === undefined) continue
    if (++keys > MAX_PRINCIPAL_KEYS) break
    out[key] = clean
  }
  return out
}

/**
 * Whether an op is one the log accepts: a named op, or a restore-* or purge-*
 * step.
 * @param {unknown} op
 */
export function isAuditOp(op) {
  return typeof op === 'string' && (OPS.has(op) || OP_FAMILIES.test(op))
}

/**
 * Reduce a record to the allow-listed fields: v, ts, op, planId, batchId,
 * digest, counts, bytes, sessions [{id, workspaceId, parent, archived, pinned,
 * bytes}], reasons [{code, sessionId}], outcome, errorCode, hostPid,
 * pluginVersion, and principal only when it is defined. Unknown keys are
 * dropped; a known key with a wrong type or an unsafe string is dropped too.
 * `v` is always the current version. Returns undefined when the record has no
 * valid op or timestamp.
 * @param {unknown} record
 * @returns {Record<string, unknown> | undefined}
 */
export function sanitizeRecord(record) {
  if (!isObject(record)) return undefined
  const ts = sanitizeTimestamp(record.ts)
  if (ts === undefined || !isAuditOp(record.op)) return undefined
  const out = { v: AUDIT_VERSION, ts, op: record.op }
  const put = (key, value) => {
    if (value !== undefined) out[key] = value
  }
  put('planId', token(record.planId))
  put('batchId', token(record.batchId))
  put('digest', token(record.digest))
  put('counts', sanitizeCounts(record.counts))
  put('bytes', count(record.bytes))
  put('sessions', sanitizeList(record.sessions, sanitizeSession, MAX_SESSIONS))
  put('reasons', sanitizeList(record.reasons, sanitizeReason, MAX_REASONS))
  put('outcome', token(record.outcome))
  put('errorCode', token(record.errorCode))
  if (Number.isSafeInteger(record.hostPid) && record.hostPid > 0) out.hostPid = record.hostPid
  put('pluginVersion', token(record.pluginVersion))
  if (record.principal !== undefined) put('principal', sanitizePrincipal(record.principal))
  return out
}

/**
 * Owner and mode problem of an entry already stat'ed, or undefined: it must
 * belong to this process's user and have no group or world write bits
 * (`mode & 0o022`; ACLs are not inspected). Not checked where POSIX owners do
 * not exist (no process.getuid). Read bits are not checked: confidentiality
 * rests on the file the plugin always creates 0600.
 */
function statOwnershipProblem(stat) {
  if (typeof process.getuid !== 'function') return undefined
  const uid = process.getuid()
  if (stat.uid !== uid) return `belongs to another user (uid ${stat.uid}, this process runs as ${uid})`
  if ((stat.mode & 0o022) !== 0) return `is writable by group or others (mode 0${(stat.mode & 0o777).toString(8)})`
  return undefined
}

/** Access check that reports the error code instead of throwing. */
function denied(target, mode) {
  try {
    accessSync(target, mode)
    return undefined
  } catch (error) {
    return errorCode(error)
  }
}

/**
 * The audit file of one data directory. Nothing is cached. Creating it touches
 * no file; the folder and file appear on the first write.
 * @param {string} dir absolute data directory
 * @param {{ now?: () => Date, hostPid?: number, pluginVersion?: string }} [options]
 *   `now`: clock for records without a `ts`; `hostPid` and `pluginVersion`
 *   fill the fields a record leaves out
 */
export function createAudit(dir, options = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('Audit log needs an absolute data directory')
  const root = path.resolve(dir)
  const auditPath = path.join(root, AUDIT_FILE)
  const now = options.now ?? (() => new Date())
  const defaults = {
    hostPid: options.hostPid ?? process.pid,
    pluginVersion: options.pluginVersion,
  }

  /** A file or folder entry: never a symlink, the right kind, owned by this user, not writable by group or others. */
  function entryProblem(target, kind) {
    let stat
    try {
      stat = lstatSync(target)
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      return `not writable: ${target} cannot be inspected (${errorCode(error)})`
    }
    if (stat.isSymbolicLink()) return `not writable: ${target} is a symbolic link`
    if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) {
      return `not writable: ${target} is not a ${kind === 'file' ? 'regular file' : 'directory'}`
    }
    const ownership = statOwnershipProblem(stat)
    if (ownership !== undefined) return `unsafe: ${target} ${ownership}`
    const code = denied(target, kind === 'file' ? constants.R_OK | constants.W_OK : constants.W_OK | constants.X_OK)
    return code === undefined ? undefined : `not writable: ${target} denies access (${code})`
  }

  /**
   * Why the log cannot be written right now, or undefined. Write-free. The
   * folder and an existing audit.jsonl must not be symlinks, must be owned by
   * this user and must not be writable by group or others. A missing folder
   * is fine when its parent is a writable directory.
   * @param {boolean} [created] the caller has just made the folder: missing now means it vanished
   */
  function writableProblem(created = false) {
    try {
      let stat
      try {
        stat = lstatSync(root)
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return `not writable: ${root} cannot be inspected (${errorCode(error)})`
        if (created) return `not writable: ${root} vanished after it was created`
        // mkdir creates the missing levels: the nearest existing ancestor must be a writable directory.
        let parent = path.dirname(root)
        for (;;) {
          let parentStat
          try {
            parentStat = lstatSync(parent)
          } catch (parentError) {
            const next = path.dirname(parent)
            if ((parentError?.code !== 'ENOENT' && parentError?.code !== 'ENOTDIR') || next === parent) {
              return `not writable: ${root} cannot be created (${errorCode(parentError)})`
            }
            parent = next
            continue
          }
          if (!parentStat.isDirectory() && !parentStat.isSymbolicLink()) return `not writable: ${parent} is not a directory`
          const code = denied(parent, constants.W_OK | constants.X_OK)
          return code === undefined ? undefined : `not writable: ${root} cannot be created in ${parent} (${code})`
        }
      }
      return entryProblem(root, 'directory') ?? entryProblem(auditPath, 'file')
    } catch (error) {
      return `not writable: ${errorCode(error)}`
    }
  }

  /** The record as the exact bytes to append, or a throw naming why it cannot be. */
  function encode(record) {
    const withDefaults = isObject(record)
      ? {
          ...record,
          ts: sanitizeTimestamp(record.ts) ?? now().toISOString(),
          hostPid: hasOwn(record, 'hostPid') ? record.hostPid : defaults.hostPid,
          pluginVersion: hasOwn(record, 'pluginVersion') ? record.pluginVersion : defaults.pluginVersion,
        }
      : record
    const clean = sanitizeRecord(withDefaults)
    if (clean === undefined) throw new AuditError('Audit record needs a valid op', 'invalid-record')
    const buffer = Buffer.from(`${JSON.stringify(clean)}\n`, 'utf8')
    if (buffer.length > MAX_LINE_BYTES) {
      throw new AuditError(`Audit record is ${buffer.length} bytes, over the ${MAX_LINE_BYTES}-byte cap`, 'record-too-large')
    }
    return buffer
  }

  /** Append one line with a single O_APPEND write; throws on any failure. */
  async function write(record) {
    const buffer = encode(record)
    await fs.mkdir(root, { recursive: true, mode: 0o700 })
    const problem = writableProblem(true)
    if (problem !== undefined) throw new AuditError(`Audit log is ${problem}`, 'unsafe-folder')
    const handle = await fs.open(auditPath, APPEND_FLAGS, 0o600)
    try {
      // The path check above can race a swap; the opened file is checked again.
      const stat = await handle.stat()
      const ownership = !stat.isFile() ? 'is not a regular file' : statOwnershipProblem(stat)
      if (ownership !== undefined) throw new AuditError(`Audit log ${auditPath} ${ownership}`, 'unsafe-file')
      const { bytesWritten } = await handle.write(buffer)
      if (bytesWritten !== buffer.length) {
        // End the fragment so the next line starts on its own; readers skip it.
        if (bytesWritten > 0) {
          try {
            await handle.write(NEWLINE)
          } catch { /* the short append is reported below */ }
        }
        throw new AuditError('short audit append', 'short-write')
      }
    } finally {
      await handle.close()
    }
  }

  /**
   * Record the start of an apply. Fail closed: it throws an AuditError when
   * the line cannot be written, and the caller must then abort before it moves
   * anything. The op is always 'apply-start'.
   * @param {Record<string, unknown>} record
   */
  async function appendStart(record) {
    try {
      await write({ ...(isObject(record) ? record : {}), op: 'apply-start' })
    } catch (error) {
      if (error instanceof AuditError) throw error
      throw new AuditError(`Audit log cannot be written (${errorCode(error)})`, AUDIT_FAILED, { cause: error })
    }
  }

  /**
   * Record a later step. Never throws: a failure comes back as a result with
   * the contract's 'audit-failed' warning, for the caller to add to its warnings.
   * @param {Record<string, unknown>} record
   * @returns {Promise<{ ok: true } | { ok: false, warning: { code: 'audit-failed', sessionId: string | null }, reason: string }>}
   */
  async function append(record) {
    try {
      await write(record)
      return { ok: true }
    } catch (error) {
      const sessionId = isObject(record) ? nullableToken(record.sessionId ?? null) ?? null : null
      return { ok: false, warning: { code: AUDIT_FAILED, sessionId }, reason: errorCode(error) }
    }
  }

  /**
   * The last `limit` records, oldest first. Reads at most MAX_TAIL_BYTES from
   * the end of the file (never the whole file), drops the partial first line
   * of that window, skips torn and foreign lines, and passes every record
   * through the allow-list again. A missing file gives an empty list.
   * @param {number} [limit] 1 to MAX_TAIL_LINES, default 50
   * @param {{ maxBytes?: number }} [tailOptions] a smaller read window (tests, callers)
   */
  async function tail(limit = 50, tailOptions = {}) {
    const wanted = Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 50, 1), MAX_TAIL_LINES)
    const window = Math.min(Math.max(Math.trunc(tailOptions.maxBytes ?? MAX_TAIL_BYTES) || MAX_TAIL_BYTES, 1), MAX_TAIL_BYTES)
    let handle
    try {
      handle = await fs.open(auditPath, READ_FLAGS)
    } catch {
      return []
    }
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) return []
      const length = Math.min(stat.size, window)
      if (length === 0) return []
      const start = stat.size - length
      const buffer = Buffer.alloc(length)
      let filled = 0
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled)
        if (bytesRead === 0) break
        filled += bytesRead
      }
      let text = buffer.subarray(0, filled).toString('utf8')
      if (start > 0) {
        // The window begins inside a line: drop that partial line.
        const newline = text.indexOf('\n')
        text = newline === -1 ? '' : text.slice(newline + 1)
      }
      const records = []
      for (const line of text.split('\n')) {
        if (line === '') continue
        const record = parseLine(line)
        if (record !== undefined) records.push(record)
      }
      return records.slice(-wanted)
    } finally {
      await handle.close()
    }
  }

  return Object.freeze({ dir: root, auditPath, appendStart, append, tail, writableProblem: () => writableProblem() })
}

/**
 * Parse one physical line. A failed short append can leave a fragment without
 * its newline, so the next whole line is glued behind it: one recovery from
 * the last record start is tried. Anything else that does not parse is skipped.
 */
function parseLine(line) {
  for (const candidate of [line, line.includes(RECORD_START) ? line.slice(line.lastIndexOf(RECORD_START)) : undefined]) {
    if (candidate === undefined) continue
    let value
    try {
      value = JSON.parse(candidate)
    } catch {
      continue
    }
    if (isObject(value) && value.v === AUDIT_VERSION) {
      const clean = sanitizeRecord(value)
      if (clean !== undefined) return clean
    }
  }
  return undefined
}
