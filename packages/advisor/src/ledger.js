import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, lstatSync, readFileSync, statSync, promises as fs } from 'node:fs'
import path from 'node:path'

// Plugin-owned Advisor data in one folder, dataDir:
//   <dataDir>/sessions.jsonl     the ledger: one O_APPEND write per line, mode 0600
//   <dataDir>/replies/<id>.md    one immutable reply per run: exclusive create, mode 0600
// Folders are created with mode 0700. The line format is documented in the
// README. Several hosts of this plugin can share one folder: every write is one
// append or an exclusive create.
// dataDir comes only from the plugin config or the DSH home handed to
// resolveDataDir; this module reads no environment variables.

export const LEDGER_FILE = 'sessions.jsonl'
export const REPLIES_DIR = 'replies'

const ID_PATTERN = /^[0-9a-f]{12}$/
// C0 and C1 controls (\p{Cc}, which includes U+0085), every Unicode
// Bidi_Control character (U+061C, U+200E, U+200F, U+202A-U+202E,
// U+2066-U+2069), line and paragraph separators, and backticks (the lead's
// prompt quotes the paths in backticks).
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Bidi_Control}\u2028\u2029`]/u
// 'a' plus O_NOFOLLOW: never append through a symlinked ledger file.
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0)
const NEWLINE = Buffer.from('\n')

const errorCode = (error) => error?.code ?? (error instanceof Error ? error.message : String(error))

/** Drop one trailing separator (never the root's own). */
function withoutTrailingSeparator(value, flavor) {
  const { root } = flavor.parse(value)
  const last = value[value.length - 1]
  return value.length > root.length && (last === flavor.sep || last === '/') ? value.slice(0, -1) : value
}

/**
 * Owner and mode problem of an entry already stat'ed, or undefined: it must
 * belong to this process's user and have no group or world write bits
 * (`mode & 0o022`; ACLs are not inspected). Not checked where POSIX owners
 * do not exist (no process.getuid). Read bits are deliberately not checked:
 * `0o022` is the integrity rule (nobody else may plant or swap entries), and
 * confidentiality rests on the files, which the plugin always creates 0600.
 */
function statOwnershipProblem(stat) {
  if (typeof process.getuid !== 'function') return undefined
  const uid = process.getuid()
  if (stat.uid !== uid) return `belongs to another user (uid ${stat.uid}, this process runs as ${uid})`
  if ((stat.mode & 0o022) !== 0) return `is writable by group or others (mode 0${(stat.mode & 0o777).toString(8)})`
  return undefined
}

/**
 * The string rules dataDir and the DSH home share: absolute, not a
 * filesystem root, normalized as given (at most one trailing separator), no
 * `..` segment, no surrounding whitespace, no control, line or paragraph
 * separator, Bidi_Control or backtick characters; on Windows a drive or UNC
 * share. Returns the value normalized without a trailing separator.
 */
function checkedPath(value, flavor, subject) {
  if (typeof value !== 'string' || value === '') throw new Error(`${subject} must be a non-empty string`)
  if (UNSAFE_CHARACTERS.test(value)) {
    throw new Error(`${subject} must not contain control, line or paragraph separator, bidirectional control, or backtick characters`)
  }
  if (value.trim() !== value) throw new Error(`${subject} must not start or end with whitespace`)
  if (value.startsWith('~') || !flavor.isAbsolute(value)) {
    throw new Error(`${subject} must be an absolute path, not ${JSON.stringify(value)}`)
  }
  const { root } = flavor.parse(value)
  if (flavor === path.win32 && (root === '\\' || root === '/')) {
    throw new Error(`${subject} must name a drive or UNC share, not the drive-relative ${JSON.stringify(value)}`)
  }
  if (value.split(/[\\/]/).includes('..')) throw new Error(`${subject} must not contain ".." segments`)
  const normalized = withoutTrailingSeparator(flavor.normalize(value), flavor)
  if (normalized === flavor.parse(normalized).root) throw new Error(`${subject} must not be a filesystem root`)
  // Windows accepts both separators; normalize() turns '/' into '\'.
  const comparable = flavor === path.win32 ? value.replaceAll('/', '\\') : value
  if (withoutTrailingSeparator(comparable, flavor) !== normalized) {
    throw new Error(`${subject} must be a normalized path such as ${JSON.stringify(normalized)}`)
  }
  return normalized
}

/**
 * Resolve the Advisor data directory once, by its string alone.
 * A set `config.dataDir` must pass checkedPath; an invalid value throws
 * instead of falling back; on Windows either separator is accepted. Unset,
 * the directory is `<home>/advisor` when `home` is absolute: the raw home
 * must pass the same rules before 'advisor' is joined (joining would hide
 * `..` and doubled separators). Owner, mode and type are not checked here:
 * the ledger's writableProblem() checks them at every use, so a folder that
 * is fixed later is picked up without a restart.
 * @param {{ dataDir?: unknown } | undefined} config plugin config
 * @param {{ home?: unknown, platform?: string }} [options] `home`: the DSH home
 *   (profileContext.home); `platform`: path rules to apply, default process.platform
 * @returns {string} absolute normalized directory
 */
export function resolveDataDir(config, options) {
  const flavor = (options?.platform ?? process.platform) === 'win32' ? path.win32 : path.posix
  const configured = config?.dataDir
  if (configured !== undefined) return checkedPath(configured, flavor, 'Advisor dataDir')
  const home = options?.home
  if (typeof home !== 'string' || !flavor.isAbsolute(home)) throw new Error('Advisor dataDir is not configured')
  let base
  try {
    base = checkedPath(home, flavor, 'The DSH home')
  } catch (error) {
    throw new Error(`${error.message} (needed for the default dataDir)`)
  }
  return flavor.join(base, 'advisor')
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function fileSha256Sync(file) {
  try {
    return sha256(readFileSync(file))
  } catch {
    return undefined
  }
}

// The torn-line fallback is bounded so that one hostile line cannot stall the
// synchronous guards: only lines of at most MAX_TORN_LINE characters are
// searched, at most MAX_TORN_OFFSETS offsets per line are tried, and at most
// MAX_TORN_PARSE characters per line are handed to JSON.parse.
const MAX_TORN_LINE = 1024 * 1024
const MAX_TORN_OFFSETS = 64
const MAX_TORN_PARSE = 4 * MAX_TORN_LINE

/** Whether a parsed value is an entry of this consult_id: an object whose own top-level consult_id is the id. */
function isEntryOf(value, id) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && value.consult_id === id
}

/**
 * Parse one physical ledger line. A failed short append can leave a fragment
 * without its newline, so the next whole line is glued behind it. A line
 * that parses as a whole is that value and nothing else. Otherwise an entry
 * is recovered from a later '{"' to the end of the line: the offsets are
 * tried from the end backward (the glued whole line comes last), within the
 * caps above.
 * @param {string} line
 * @param {string} [id] recover only an object whose top-level consult_id is
 *   this id; its suffix must contain the id
 * @returns {{ value: unknown, at: number } | undefined} the parsed value and
 *   the offset it starts at: 0 for the whole line, else a recovered entry
 */
function parseLedgerLine(line, id) {
  try {
    return { value: JSON.parse(line), at: 0 }
  } catch { /* torn, foreign, or a whole line behind a fragment */ }
  if (line.length > MAX_TORN_LINE) return undefined
  const from = id === undefined ? line.length : line.lastIndexOf(id)
  if (from === -1) return undefined
  let offsets = 0
  let parsed = 0
  for (let at = line.lastIndexOf('{"', from); at > 0; at = line.lastIndexOf('{"', at - 1)) {
    offsets++
    parsed += line.length - at
    if (offsets > MAX_TORN_OFFSETS || parsed > MAX_TORN_PARSE) return undefined
    let value
    try {
      value = JSON.parse(line.slice(at))
    } catch {
      continue
    }
    if (id === undefined || isEntryOf(value, id)) return { value, at }
  }
  return undefined
}

/** Whether a path is a symlink itself (never throws). */
function isSymbolicLink(target) {
  try {
    return lstatSync(target).isSymbolicLink()
  } catch {
    return false
  }
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
 * The ledger and reply files of one data directory. Nothing is cached:
 * every read sees lines other ledger instances or processes appended.
 * Creating a ledger touches no file; folders appear on the first write.
 * @param {string} dir absolute data directory, normally from resolveDataDir
 */
export function createLedger(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('Advisor ledger needs an absolute data directory')
  const root = path.resolve(dir)
  const ledgerPath = path.join(root, LEDGER_FILE)
  const repliesDir = path.join(root, REPLIES_DIR)

  /** Path of the reply file for an advisor id (12 lowercase hex); throws for any other id. */
  function replyPath(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('Advisor reply id must be 12 lowercase hex characters')
    return path.join(repliesDir, `${id}.md`)
  }

  /** Append one JSON line with a single O_APPEND write. */
  async function appendLedger(line) {
    await fs.mkdir(root, { recursive: true, mode: 0o700 })
    assertUsable({ root: true })
    const buffer = Buffer.from(`${JSON.stringify(line)}\n`, 'utf8')
    const handle = await fs.open(ledgerPath, APPEND_FLAGS, 0o600)
    try {
      const { bytesWritten } = await handle.write(buffer)
      if (bytesWritten !== buffer.length) {
        // End the fragment so the next line starts on its own; readers skip
        // the fragment. If even this fails, readers still recover a whole
        // line glued behind it (parseLedgerLine).
        if (bytesWritten > 0) {
          try {
            await handle.write(NEWLINE)
          } catch { /* the short append is reported below */ }
        }
        throw new Error('short ledger append')
      }
    } finally {
      await handle.close()
    }
  }

  /** Write a new reply file exclusively; returns its path and the sha256 of the exact bytes. */
  async function writeReply(id, text) {
    const file = replyPath(id)
    await fs.mkdir(repliesDir, { recursive: true, mode: 0o700 })
    assertUsable({ root: true, replies: true })
    const bytes = Buffer.from(text, 'utf8')
    await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 })
    return { file, sha256: sha256(bytes) }
  }

  /**
   * The physical ledger lines holding an entry of this consult_id, in file
   * order (sync; for the guards and the verifier's evidence tool): the 1-based
   * line number, the entry's text, the parsed entry, and whether the line is
   * torn. Only an object whose top-level consult_id is the id counts. On a
   * torn line (a whole line glued behind a fragment of another write) the
   * text starts at the recovered entry, so no part of the fragment is shown.
   */
  function ledgerLinesFor(id) {
    if (typeof id !== 'string' || id === '') return []
    let text
    try {
      text = readFileSync(ledgerPath, 'utf8')
    } catch {
      return []
    }
    if (!text.includes(id)) return []
    const lines = []
    text.split('\n').forEach((line, index) => {
      if (!line.includes(id)) return
      const parsed = parseLedgerLine(line, id)
      if (parsed === undefined || !isEntryOf(parsed.value, id)) return
      const torn = parsed.at > 0
      lines.push({ line: index + 1, text: torn ? line.slice(parsed.at) : line, entry: parsed.value, torn })
    })
    return lines
  }

  /** Parsed ledger entries carrying this consult_id, in file order (sync; used by guards). */
  function ledgerEntriesFor(id) {
    return ledgerLinesFor(id).map(({ entry }) => entry)
  }

  /** Whether a reply file or any ledger line already uses this id (throws for a malformed id). */
  function idInUse(id) {
    return existsSync(replyPath(id)) || ledgerEntriesFor(id).length > 0
  }

  /** The last terminal runs, one line each, for /advisor status. */
  async function recentLedger(limit = 3) {
    try {
      const text = await fs.readFile(ledgerPath, 'utf8')
      const entries = text.split('\n').filter(Boolean).map((line) => {
        const entry = parseLedgerLine(line)?.value
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || entry.status === 'started') return null
        const kind = entry.kind === 'plan' || entry.kind === 'advice' ? ` ${entry.kind}` : ''
        return `${entry.consult_id ?? 'unknown'} ${entry.advisor ?? 'unknown'}${kind} ${entry.status ?? 'unknown'} ${entry.topic ?? 'unset'}`
      }).filter(Boolean).slice(-limit)
      return entries.length ? entries.join('\n') : 'No consults recorded.'
    } catch {
      return 'No consults recorded.'
    }
  }

  /**
   * The nearest existing ancestor of a missing folder must be a writable
   * directory. A dangling symlink on the way up would only fail at mkdir, so
   * it is reported here.
   */
  function creatableProblem(target) {
    let parent = path.dirname(target)
    for (;;) {
      let stat
      try {
        stat = statSync(parent)
      } catch (error) {
        if (error?.code === 'ENOENT' && isSymbolicLink(parent)) return `not writable: ${parent} is a symbolic link to a missing target`
        const next = path.dirname(parent)
        if ((error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') || next === parent) {
          return `not writable: ${target} cannot be created (${errorCode(error)})`
        }
        parent = next
        continue
      }
      if (!stat.isDirectory()) return `not writable: ${parent} is not a directory`
      const code = denied(parent, constants.W_OK | constants.X_OK)
      return code === undefined ? undefined : `not writable: ${target} cannot be created in ${parent} (${code})`
    }
  }

  /**
   * A file or folder inside the data directory: never a symlink, the right
   * kind, owned by this user with no group or world write bits (ACLs are not
   * inspected), and usable: the ledger file readable and writable (the
   * guards read it), the replies folder writable and searchable.
   * @param {boolean} mustExist the caller has just created it; missing means it vanished
   */
  function entryProblem(target, kind, mustExist = false) {
    let stat
    try {
      stat = lstatSync(target)
    } catch (error) {
      if (error?.code === 'ENOENT') return mustExist ? `not writable: ${target} vanished after it was created` : undefined
      return `not writable: ${target} cannot be inspected (${errorCode(error)})`
    }
    if (stat.isSymbolicLink()) return `not writable: ${target} is a symbolic link`
    if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) {
      return `not writable: ${target} is not a ${kind === 'file' ? 'regular file' : 'directory'}`
    }
    const ownership = statOwnershipProblem(stat)
    if (ownership !== undefined) return `unsafe: ${target} ${ownership}`
    if (kind === 'file') {
      const code = denied(target, constants.R_OK | constants.W_OK)
      return code === undefined ? undefined : `not writable: ${target} denies reading or writing (${code})`
    }
    const code = denied(target, constants.W_OK | constants.X_OK)
    return code === undefined ? undefined : `not writable: ${target} denies writes (${code})`
  }

  /**
   * The probe behind writableProblem() and assertUsable().
   * @param {{ root?: boolean, replies?: boolean }} created folders the caller
   *   has just created with mkdir: missing now means they vanished, which is a
   *   failure rather than "can be created"
   */
  function probe(created = {}) {
    try {
      let stat
      try {
        stat = lstatSync(root)
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
          return created.root ? `not writable: ${root} vanished after it was created` : creatableProblem(root)
        }
        return `not writable: ${root} cannot be inspected (${errorCode(error)})`
      }
      if (stat.isSymbolicLink()) {
        // Only this first link is owner-checked; statSync follows any further links.
        if (typeof process.getuid === 'function') {
          const uid = process.getuid()
          if (stat.uid !== uid && stat.uid !== 0) {
            return `unsafe: ${root} is a symbolic link owned by another user (uid ${stat.uid}, this process runs as ${uid})`
          }
        }
        try {
          stat = statSync(root)
        } catch (error) {
          return error?.code === 'ENOENT'
            ? `not writable: ${root} is a symbolic link to a missing target`
            : `not writable: ${root} cannot be inspected (${errorCode(error)})`
        }
      }
      if (!stat.isDirectory()) return `not writable: ${root} is not a directory`
      const ownership = statOwnershipProblem(stat)
      if (ownership !== undefined) return `unsafe: ${root} ${ownership}`
      const code = denied(root, constants.W_OK | constants.X_OK)
      if (code !== undefined) return `not writable: ${root} denies writes (${code})`
      return entryProblem(ledgerPath, 'file') ?? entryProblem(repliesDir, 'directory', created.replies === true)
    } catch (error) {
      return `not writable: ${errorCode(error)}`
    }
  }

  /**
   * Why this ledger cannot record runs right now, or undefined when it can.
   * Synchronous and write-free:
   * - the folder is a directory this user owns with no group or world write
   *   bits (ACLs are not inspected) and writable, or it can be created under
   *   a writable existing parent;
   * - a symlinked folder is fine when this user or root owns the link (only
   *   that first link is checked); the folder it points to is judged as above;
   * - an existing sessions.jsonl and replies/ are a regular file and a
   *   directory, not symlinks, owned by this user with no group or world
   *   write bits; the ledger file is readable and writable, replies/ writable.
   * @returns {string | undefined} 'not writable: <reason>' or 'unsafe: <reason>'
   */
  function writableProblem() {
    return probe()
  }

  /**
   * Writers call this after mkdir and before opening a file, so the folder is
   * checked at every write, also for callers that skip the planner's probe; a
   * folder created by someone else between a probe and mkdir is caught here,
   * and one that vanished after mkdir is a failure.
   */
  function assertUsable(created) {
    const problem = probe(created)
    if (problem !== undefined) throw new Error(`Advisor data directory is ${problem}`)
  }

  return Object.freeze({
    dir: root,
    ledgerPath,
    repliesDir,
    replyPath,
    appendLedger,
    writeReply,
    ledgerEntriesFor,
    ledgerLinesFor,
    idInUse,
    recentLedger,
    writableProblem,
  })
}
