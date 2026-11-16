#!/usr/bin/env node
// compare.mjs: compare the in-process Advisor plugin (ledger advisor "dsh")
// with the CLI advisor (consult.py; any other advisor) per briefing topic,
// read from one or more advisor ledgers. Read-only: it reads the ledgers, the
// reply files of answered runs, and optional tallies and topics files, then
// prints a Markdown report to stdout.
//
// Usage:
//   node packages/advisor/scripts/compare.mjs [--ledger <file>]... [--tallies <file>]
//     [--topics <file>] [--price <model>=<in>,<out>[,<cacheRead>,<cacheWrite>]]...
//
// Without --ledger: $ADVISOR_LEDGER alone when set (an override for this
// script only), else every existing file of the plugin ledger
// <DSH home>/advisor/sessions.jsonl and the advisor skill's (legacy) ledger
// <XDG_STATE_HOME|~/.local/state>/advisor/sessions.jsonl. The DSH home mirrors
// DSH's resolveDshHome (@deepseek-ai/dsh-home-paths); the paths are computed
// here, since src/ledger.js no longer resolves them. A file reached by two
// names (a symlinked folder) is read once.
//
// Prices are USD per million tokens. Token fields are disjoint: input_tokens
// excludes cache reads and writes, for DSH TokenUsage and Claude CLI usage
// alike. So priced = (input*in + output*out + cache_read*cacheRead +
// cache_write*cacheWrite) / 1e6.
//
// reply_file must be an absolute path; both writers record one. A relative
// reply_file is resolved against the directory of its own ledger and noted.
import { Buffer } from 'node:buffer'
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LEDGER_FILE, sha256 } from '../src/ledger.js'
import { validateAdvice, validatePlan } from '../src/planner.js'

/** The ledger file name, shared with the plugin's ledger module. */
export { LEDGER_FILE }

export const USAGE = 'usage: node packages/advisor/scripts/compare.mjs [--ledger <file>]... [--tallies <file>] [--topics <file>] [--price <model>=<in>,<out>[,<cacheRead>,<cacheWrite>]]...'

const HELP = `${USAGE}

Pairs plugin runs (advisor dsh) with CLI advisor runs (any other advisor) by
ledger topic and prints a Markdown report. Only terminal lines of kind plan or
advice take part, plus lines whose consult_id --topics names. Topics must match
^[a-z0-9][a-z0-9-]{0,39}$ after trimming.

  --ledger <file>   Ledger to read; repeat it to merge several. Without it:
                    $ADVISOR_LEDGER alone when set (an override for this
                    script only; existing defaults it skips are noted), else
                    every existing file of
                    <DSH_HOME|~/.dsh>/advisor/sessions.jsonl (plugin ledger) and
                    <XDG_STATE_HOME|~/.local/state>/advisor/sessions.jsonl
                    (advisor skill ledger, legacy). None found: exit 1.
                    The DSH home is resolved like DSH does: a blank DSH_HOME
                    counts as unset, and ~, ~/ and ~\\ expand against HOME.
                    A file reached by two names (a symlink) is read once.
  --tallies <file>  JSON object keyed by consult_id:
                    {"<consult_id>": {"confirmed": 0, "refuted": 0, "unverifiable": 0}}
  --topics <file>   JSON object mapping consult_id to a topic slug:
                    {"<consult_id>": "<topic>"}. The slug replaces the topic of
                    every terminal line with that consult_id and admits those
                    lines whatever their kind; "unset" leaves them out.
  --price <spec>    <model>=<in>,<out>[,<cacheRead>,<cacheWrite>] in USD per
                    million tokens, matched against the line's model; repeat
                    per model. Without cache rates, cache tokens are not priced.

Several ledgers are merged in ts order, each keeping its own line order; a
line repeated verbatim in a later ledger counts once. The report header
lists every ledger read.

reply_file must be an absolute path (both writers record one); a relative
path is resolved against the directory of its own ledger and noted in the
report.
`

export const ARMS = Object.freeze(['plugin', 'cli'])
/** Ledger kinds that take part in pairing without a --topics entry. */
export const PAIRED_KINDS = Object.freeze(['plan', 'advice'])
/** Statuses that carry a reply: consult.py writes one for ok and for degraded (plain-text) answers. */
export const ANSWERED_STATUSES = Object.freeze(['ok', 'degraded'])
/** The briefingTopic slug rule of src/planner.js, applied after trimming. */
export const TOPIC_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/
/** Envelope keys the plugin adds around a reply (renderPlan, renderAdvice). */
export const ENVELOPE_KEYS = Object.freeze(['schema', 'plan_id', 'advice_id'])
export const TALLY_FIELDS = Object.freeze(['confirmed', 'refuted', 'unverifiable'])
/** [column label, ledger field] for the four disjoint token counts. */
export const TOKEN_FIELDS = Object.freeze([
  ['input', 'input_tokens'],
  ['output', 'output_tokens'],
  ['cache read', 'cache_read_tokens'],
  ['cache write', 'cache_write_tokens'],
])
export const COLUMNS = Object.freeze([
  'topic', 'arm', 'kind', 'consult_id', 'ts', 'model', 'runs', 'status', 'reply',
  ...TALLY_FIELDS, ...TOKEN_FIELDS.map(([label]) => label), 'duration_s', 'recorded', 'priced',
])
const RIGHT_ALIGNED = new Set(['runs', ...TALLY_FIELDS, ...TOKEN_FIELDS.map(([label]) => label), 'duration_s', 'recorded', 'priced'])

/** An expected failure: main prints its message on one stderr line and returns exitCode. */
export class CompareError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.name = 'CompareError'
    this.exitCode = exitCode
  }
}

const usageError = (message) => new CompareError(message, 2)
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
/** A usable token count, or undefined when null, absent, negative, or not a number. */
const tokenCount = (value) => (finite(value) && value >= 0 ? value : undefined)
/** Whether a terminal line carries an answer (ok or degraded). */
export const isAnswered = (line) => ANSWERED_STATUSES.includes(line.status)

// ---------------------------------------------------------------------------
// Text safety

const BREAKS = /[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g
// Bidi controls (ALM, LRM, RLM, LRE..RLO, LRI..PDI) and zero-width characters.
const INVISIBLE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g
const INVISIBLE_CHAR = /^[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]$/
const spelled = (char) => `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`

/** One line for stderr: control characters and line breaks become spaces; bidi and zero-width characters are spelled out. */
export function oneLine(text) {
  return String(text).replace(BREAKS, ' ').replace(INVISIBLE, spelled).trim()
}

const MARKDOWN_ESCAPES = new Map([
  ['\\', '\\\\'], ['`', '\\`'], ['*', '\\*'], ['_', '\\_'], ['[', '\\['], [']', '\\]'], ['|', '\\|'],
  ['<', '&lt;'], ['>', '&gt;'], ['&', '&amp;'],
])
const MARKDOWN_UNSAFE = /[\u0000-\u001f\u007f\u0085\u2028\u2029]+|[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]|[\\`*_[\]|<>&]/g

/**
 * Make a ledger-, file- or argv-derived string safe as Markdown text and as a
 * table cell: control characters and line breaks become a space, bidi and
 * zero-width characters are spelled out as \uXXXX, Markdown punctuation is
 * backslash-escaped, and <, > and & become entities.
 */
export function escapeText(value) {
  return String(value).replace(MARKDOWN_UNSAFE, (match) => MARKDOWN_ESCAPES.get(match) ?? (INVISIBLE_CHAR.test(match) ? spelled(match) : ' '))
}
export const escapeCell = escapeText

const quoted = (value) => escapeText(JSON.stringify(String(value)))
/** A ledger word (kind, status) for a note: escaped, with labels for none and empty. */
const word = (value, none) => (value === null ? none : value === '' ? '(empty)' : escapeText(value))
function listText(values, limit = 10) {
  const shown = values.slice(0, limit).map(quoted).join(', ')
  return values.length > limit ? `${shown} and ${values.length - limit} more` : shown
}

// ---------------------------------------------------------------------------
// Arguments

const VALUE_FLAGS = new Set(['--ledger', '--tallies', '--topics', '--price'])
const RATE = /^(?:\d+(?:\.\d*)?|\.\d+)$/

/**
 * Parse one --price value: <model>=<in>,<out>[,<cacheRead>,<cacheWrite>],
 * non-negative decimals in USD per million tokens. cacheRead and cacheWrite
 * are null when the price has no cache rates.
 */
export function parsePrice(spec) {
  const text = String(spec)
  const at = text.lastIndexOf('=')
  const model = at === -1 ? '' : text.slice(0, at)
  const parts = at === -1 ? [] : text.slice(at + 1).split(',')
  const rates = parts.map((part) => (RATE.test(part) ? Number(part) : Number.NaN))
  if (model === '' || model.trim() !== model || (parts.length !== 2 && parts.length !== 4) || !rates.every(Number.isFinite)) {
    throw usageError(`malformed --price ${JSON.stringify(text)}: expected <model>=<in>,<out>[,<cacheRead>,<cacheWrite>] in USD per million tokens`)
  }
  const [input, output, cacheRead = null, cacheWrite = null] = rates
  return { model, input, output, cacheRead, cacheWrite }
}

/** Parse argv into { help, ledgers: string[], tallies, topics, prices: Map<model, price> }; throws CompareError (exit 2). */
export function parseArgs(argv) {
  const options = { help: false, ledgers: [], tallies: undefined, topics: undefined, prices: new Map() }
  for (let index = 0; index < argv.length; index++) {
    const arg = String(argv[index])
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    const flag = eq === -1 ? arg : arg.slice(0, eq)
    if (!VALUE_FLAGS.has(flag)) {
      throw usageError(arg.startsWith('-') ? `unknown option ${flag}` : `unexpected argument ${JSON.stringify(arg)}`)
    }
    let value
    if (eq !== -1) {
      value = arg.slice(eq + 1)
    } else {
      value = argv[index + 1] === undefined ? undefined : String(argv[index + 1])
      if (value === undefined || value.startsWith('--')) throw usageError(`${flag} needs a value`)
      index++
    }
    if (value === '') throw usageError(`${flag} needs a value`)
    if (flag === '--price') {
      const price = parsePrice(value)
      if (options.prices.has(price.model)) throw usageError(`--price given twice for model ${JSON.stringify(price.model)}`)
      options.prices.set(price.model, price)
    } else if (flag === '--ledger') {
      options.ledgers.push(value)
    } else {
      const key = flag.slice(2)
      if (options[key] !== undefined) throw usageError(`${flag} given twice`)
      options[key] = value
    }
  }
  return options
}

// ---------------------------------------------------------------------------
// Ledger

/** Plugin arm = advisor "dsh"; CLI arm = any other advisor, including none. */
export function armOf(line) {
  return line.advisor === 'dsh' ? 'plugin' : 'cli'
}

/** The trimmed topic when it matches the slug rule, else undefined. */
export function normalizeTopic(value) {
  if (typeof value !== 'string') return undefined
  const topic = value.trim()
  return TOPIC_SLUG.test(topic) ? topic : undefined
}

/** Whether a topic is missing, blank, or "unset". */
export function isUnsetTopic(value) {
  return typeof value !== 'string' || value.trim() === '' || value.trim() === 'unset'
}

const nonEmpty = (value) => (typeof value === 'string' && value !== '' ? value : undefined)
/** The home for ~: env.HOME when set, else os.homedir() (which itself reads HOME first). */
const homeOf = (env) => nonEmpty(env.HOME) ?? os.homedir()

/** expandHomePath of @deepseek-ai/dsh-home-paths: `~`, `~/…` and `~\…` expand against the home. */
function expandHomePath(value, home) {
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2))
  return value
}

/**
 * The DSH home as DSH's resolveDshHome (@deepseek-ai/dsh-home-paths) computes
 * it without a configured path: $DSH_HOME unless it is unset, empty or
 * whitespace-only, else ~/.dsh; then ~ expansion and path.resolve. Like DSH,
 * a non-blank value is used as given, not trimmed.
 */
export function resolveDshHome(env = process.env) {
  const home = homeOf(env)
  const fromEnv = env.DSH_HOME
  const selected = typeof fromEnv === 'string' && fromEnv.trim().length > 0 ? fromEnv : path.join(home, '.dsh')
  return path.resolve(expandHomePath(selected, home))
}

/**
 * The default ledgers, in reading order: the plugin ledger <DSH home>/advisor/sessions.jsonl
 * (resolveDshHome), then the advisor skill's (legacy) ledger, located like
 * consult.py does: <XDG_STATE_HOME, else ~/.local/state>/advisor/sessions.jsonl.
 */
export function defaultLedgerPaths(env = process.env) {
  const stateHome = nonEmpty(env.XDG_STATE_HOME) ?? path.join(homeOf(env), '.local', 'state')
  return [path.join(resolveDshHome(env), 'advisor', LEDGER_FILE), path.resolve(stateHome, 'advisor', LEDGER_FILE)]
}

function isRegularFile(file) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/** One identity per file: its realpath, else (missing or unreadable) its resolved path. */
function fileIdentity(file) {
  try {
    return realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}

/**
 * The ledgers to read: every --ledger in order; else $ADVISOR_LEDGER alone
 * (an override for this script only); else every existing default ledger.
 * Files are deduplicated by realpath, so a ledger reached through a symlinked
 * folder (~/.dsh/advisor pointing at the legacy folder) is read once.
 * Throws CompareError (exit 1) when no default ledger exists.
 * @returns {{ files: string[], aliases: string[], skippedDefaults: string[] }}
 *   files: absolute paths to read, in order; aliases: other names of a file
 *   already in files; skippedDefaults: existing default ledgers that an
 *   ADVISOR_LEDGER override left unread.
 */
export function resolveLedgers(explicit, env = process.env) {
  const chosen = new Map() // identity -> absolute path as given
  const aliases = []
  const add = (file) => {
    const absolute = path.resolve(file)
    const identity = fileIdentity(absolute)
    const seen = chosen.get(identity)
    if (seen === undefined) chosen.set(identity, absolute)
    else if (seen !== absolute && !aliases.includes(absolute)) aliases.push(absolute)
  }
  const result = () => ({ files: [...chosen.values()], aliases, skippedDefaults: [] })
  if (explicit.length > 0) {
    explicit.forEach(add)
    return result()
  }
  const defaults = [...new Set(defaultLedgerPaths(env))]
  const override = nonEmpty(env.ADVISOR_LEDGER)
  if (override !== undefined) {
    add(override)
    const skipped = new Map()
    for (const file of defaults.filter(isRegularFile)) {
      const identity = fileIdentity(file)
      if (!chosen.has(identity) && !skipped.has(identity)) skipped.set(identity, file)
    }
    return { ...result(), skippedDefaults: [...skipped.values()] }
  }
  defaults.filter(isRegularFile).forEach(add)
  if (chosen.size === 0) throw new CompareError(`no ledger found at ${defaults.join(' or ')}; pass --ledger <file>`)
  return result()
}

/**
 * Merge the lines of several ledgers ({ file, text } each, in reading order).
 * Lines are ordered by ts, each ledger keeping its own order (a line without
 * ts, or with an earlier ts than a line above it, sorts with the line above
 * it); ties go to the earlier ledger. A line whose exact text (without its
 * line ending) an earlier ledger already had is a duplicate and dropped;
 * repeats inside one ledger are kept.
 * @returns {{ entries: { line: object, baseDir: string | undefined }[], unparseable: number, duplicates: number }}
 */
export function mergeLedgerLines(sources) {
  const entries = []
  const owners = new Map() // exact line text -> index of the ledger that first had it
  let unparseable = 0
  let duplicates = 0
  sources.forEach(({ file, text }, ledger) => {
    const baseDir = typeof file === 'string' ? path.dirname(file) : undefined
    let order = -Infinity
    for (const raw of String(text).split('\n')) {
      const source = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      if (source.trim() === '') continue
      let line
      try {
        line = JSON.parse(source)
      } catch {
        line = undefined
      }
      if (isObject(line) && finite(line.ts) && line.ts > order) order = line.ts
      const owner = owners.get(source)
      if (owner === undefined) {
        owners.set(source, ledger)
      } else if (owner !== ledger) {
        duplicates++
        continue
      }
      if (!isObject(line)) {
        unparseable++
        continue
      }
      entries.push({ line, baseDir, order, ledger, index: entries.length })
    }
  })
  entries.sort((a, b) => (a.order - b.order) || (a.ledger - b.ledger) || (a.index - b.index))
  return { entries: entries.map(({ line, baseDir }) => ({ line, baseDir })), unparseable, duplicates }
}

/** parseLedgers for the text of one ledger, whose replies resolve against the caller's baseDir. */
export function parseLedger(text, options = {}) {
  return parseLedgers([{ file: undefined, text }], options)
}

/**
 * Read and merge ledgers (see mergeLedgerLines). Blank lines are ignored;
 * torn, unparseable and non-object lines are counted as unparseable; status
 * "started" lines are skipped. A terminal line takes part when its kind is
 * plan or advice or --topics names its consult_id (excluded.kind otherwise);
 * its topic is the --topics slug, else its own; a missing or unset topic
 * counts under excluded.unset and one that fails the slug rule under
 * excluded.slug (listed in badTopics). Each run keeps the directory of its
 * ledger for relative reply_file paths.
 */
export function parseLedgers(sources, { topics = new Map() } = {}) {
  const byArm = () => ({ plugin: 0, cli: 0 })
  const merged = mergeLedgerLines(sources)
  const result = {
    runs: [],
    excluded: { unset: byArm(), kind: byArm(), slug: byArm() },
    otherKinds: new Map(), // kind string, or null for none -> count
    badTopics: [],
    topicsSupplied: 0,
    topicsOverridden: 0,
    topicsUnused: [],
    unparseable: merged.unparseable,
    duplicates: merged.duplicates,
    ledgers: sources.length,
  }
  const badTopics = new Set()
  const used = new Set()
  for (const { line, baseDir } of merged.entries) {
    if (line.status === 'started') continue
    const arm = armOf(line)
    const id = typeof line.consult_id === 'string' ? line.consult_id : undefined
    const mapped = id === undefined ? undefined : topics.get(id)
    if (mapped === undefined && !PAIRED_KINDS.includes(line.kind)) {
      result.excluded.kind[arm]++
      const kind = typeof line.kind === 'string' ? line.kind : null
      result.otherKinds.set(kind, (result.otherKinds.get(kind) ?? 0) + 1)
      continue
    }
    if (mapped !== undefined) {
      used.add(id)
      const own = isUnsetTopic(line.topic) ? undefined : normalizeTopic(line.topic)
      if (own === undefined) result.topicsSupplied++
      else if (own !== mapped) result.topicsOverridden++
    }
    const value = mapped ?? line.topic
    if (isUnsetTopic(value)) {
      result.excluded.unset[arm]++
      continue
    }
    const topic = normalizeTopic(value)
    if (topic === undefined) {
      result.excluded.slug[arm]++
      badTopics.add(value)
      continue
    }
    result.runs.push({ arm, topic, line, baseDir })
  }
  result.badTopics = [...badTopics]
  result.topicsUnused = [...topics.keys()].filter((id) => !used.has(id))
  return result
}

/** Group runs by topic in first-seen order: [{ topic, plugin: runs[], cli: runs[] }]. */
export function groupTopics(runs) {
  const topics = new Map()
  for (const run of runs) {
    let group = topics.get(run.topic)
    if (group === undefined) {
      group = { topic: run.topic, plugin: [], cli: [] }
      topics.set(run.topic, group)
    }
    group[run.arm].push(run)
  }
  return [...topics.values()]
}

/** The run a row shows: the last answered (ok or degraded) terminal line, else the last terminal line. */
export function shownRun(runs) {
  for (let index = runs.length - 1; index >= 0; index--) {
    if (isAnswered(runs[index].line)) return runs[index]
  }
  return runs[runs.length - 1]
}

/** ISO 8601 UTC time of a ts in seconds, or `-`. */
export function isoTime(ts) {
  if (!finite(ts)) return '-'
  const date = new Date(ts * 1000)
  return Number.isNaN(date.getTime()) ? '-' : date.toISOString().replace(/\.000Z$/, 'Z')
}

// ---------------------------------------------------------------------------
// Replies

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text)
    return isObject(value) ? value : undefined
  } catch {
    return undefined
  }
}

const QUOTE_MARKERS = /^(?:[ \t]*>[ \t]?)+/
// A fence may follow any indentation and one list marker (list items, tabs).
const OPEN_FENCE = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/s
const CLOSE_FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/
const MAX_FENCE_DEPTH = 4
const stripQuote = (line) => line.replace(QUOTE_MARKERS, '')
const replyLines = (text) => String(text).split(/\r\n|\r|\n/).map(stripQuote)

function collectFences(lines, offset, depth, out) {
  let open
  const finish = (block) => {
    out.push({ start: offset + block.start, body: block.body.join('\n') })
    // Fences nested inside this block (````markdown around ```json, quoted examples).
    if (depth < MAX_FENCE_DEPTH) collectFences(block.body.map(stripQuote), offset + block.start + 1, depth + 1, out)
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (open === undefined) {
      const match = OPEN_FENCE.exec(line)
      // A backtick fence's info string cannot contain a backtick.
      if (match !== null && !(match[1][0] === '`' && match[2].includes('`'))) open = { fence: match[1], start: index, body: [] }
      continue
    }
    const close = CLOSE_FENCE.exec(line)
    if (close !== null && close[1][0] === open.fence[0] && close[1].length >= open.fence.length) {
      finish(open)
      open = undefined
    } else {
      open.body.push(line)
    }
  }
  // An unclosed fence runs to the end (CommonMark).
  if (open !== undefined) finish(open)
}

/**
 * Bodies of the fenced code blocks of Markdown text in document order, found
 * leniently: after blockquote markers, behind any indentation or a list
 * marker, and nested inside other fenced blocks (up to four levels).
 */
export function fencedBlocks(text) {
  const out = []
  collectFences(replyLines(text), 0, 0, out)
  return out.sort((a, b) => a.start - b.start).map((block) => block.body)
}

/** The span from the first line starting with `{` to the last line ending with `}`, parsed as an object. */
function unfencedSpan(lines) {
  const first = lines.findIndex((line) => line.trimStart().startsWith('{'))
  if (first === -1) return undefined
  for (let last = lines.length - 1; last >= first; last--) {
    if (lines[last].trimEnd().endsWith('}')) return parseJsonObject(lines.slice(first, last + 1).join('\n'))
  }
  return undefined
}

/**
 * Candidate reply objects: the whole text when it is a JSON object, else the
 * fenced blocks that parse as non-array objects, in document order; plus the
 * unfenced span as the last resort.
 * @returns {{ objects: object[], span: object | undefined }}
 */
export function replyCandidates(text) {
  const whole = parseJsonObject(text)
  if (whole !== undefined) return { objects: [whole], span: undefined }
  const objects = fencedBlocks(text).map(parseJsonObject).filter((value) => value !== undefined)
  return { objects, span: unfencedSpan(replyLines(text)) }
}

/** The last candidate object (whole text or fenced block, else the unfenced span). */
export function extractReplyObject(text) {
  const { objects, span } = replyCandidates(text)
  return objects.at(-1) ?? span
}

/** Shapes that pick a candidate for a ledger kind. */
export const REPLY_SHAPES = Object.freeze({
  plan: (value) => Object.hasOwn(value, 'tasks') && Array.isArray(value.tasks),
  advice: (value) => Object.hasOwn(value, 'recommendation'),
})

/**
 * Pick the reply object to validate. For ledger kind plan or advice: the last
 * candidate with that kind's shape (objects first, then the unfenced span),
 * validated as that kind; `wrongKind` when none has it but one has the other
 * shape; otherwise the last object, validated as that kind. For any other
 * kind: the last object, validated by its shape.
 * @returns {{ kind: 'plan'|'advice', value: object } | { wrongKind: true } | undefined}
 */
export function selectReply(text, lineKind) {
  const { objects, span } = replyCandidates(text)
  const last = objects.at(-1) ?? span
  if (lineKind !== 'plan' && lineKind !== 'advice') {
    return last === undefined ? undefined : { kind: REPLY_SHAPES.plan(last) ? 'plan' : 'advice', value: last }
  }
  const matches = REPLY_SHAPES[lineKind]
  const value = objects.findLast(matches) ?? (span !== undefined && matches(span) ? span : undefined)
  if (value !== undefined) return { kind: lineKind, value }
  const other = REPLY_SHAPES[lineKind === 'plan' ? 'advice' : 'plan']
  if (objects.some(other) || (span !== undefined && other(span))) return { wrongKind: true }
  return last === undefined ? undefined : { kind: lineKind, value: last }
}

/** A copy without the envelope keys (own data properties, so a "__proto__" key stays a plain key). */
export function stripEnvelope(value) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !ENVELOPE_KEYS.includes(key)))
}

/** Validate a reply object as kind plan or advice, or by its shape (`tasks` array: plan) when kind is neither. */
export function validateReply(value, kind) {
  const body = stripEnvelope(value)
  const as = kind === 'plan' || kind === 'advice' ? kind : (Array.isArray(body.tasks) ? 'plan' : 'advice')
  const result = as === 'plan' ? validatePlan(body) : validateAdvice(body)
  return result.ok === true ? { kind: as, ok: true, issues: [] } : { kind: as, ok: false, issues: result.issues }
}

/** Reply cell for reply text and the line's kind: `valid <kind>`, `invalid <kind> (<issues>)`, `wrong kind`, or `malformed`. Never throws. */
export function classifyReplyText(text, lineKind) {
  let selection
  try {
    selection = selectReply(text, lineKind)
  } catch {
    return { cell: 'malformed', valid: false }
  }
  if (selection === undefined) return { cell: 'malformed', valid: false }
  if (selection.wrongKind === true) return { cell: 'wrong kind', valid: false }
  let result
  try {
    result = validateReply(selection.value, selection.kind)
  } catch {
    return { cell: 'malformed', valid: false }
  }
  return result.ok
    ? { cell: `valid ${result.kind}`, valid: true }
    : { cell: `invalid ${result.kind} (${result.issues.length})`, valid: false }
}

const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0)

/**
 * Read a reply file only when it is a regular file: statSync refuses FIFOs,
 * devices and directories before any open, and the non-blocking open plus
 * fstat refuse a path swapped in between, so a reply never blocks the script.
 */
export function readRegularFile(file) {
  if (!statSync(file).isFile()) throw new Error(`${file} is not a regular file`)
  const fd = openSync(file, READ_FLAGS)
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${file} is not a regular file`)
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * Reply cell for one terminal line. Unanswered lines give `-` without reading
 * any file. An answered line's reply_file must be a readable regular file
 * (`missing-file`) whose bytes match reply_sha256 (`hash-mismatch`, not
 * validated) before its text is classified. A relative reply_file resolves
 * against baseDir.
 */
export function replyStatus(line, { readFile = readRegularFile, baseDir = process.cwd() } = {}) {
  if (!isAnswered(line)) return { cell: '-', valid: false }
  if (typeof line.reply_file !== 'string' || line.reply_file === '') return { cell: 'missing-file', valid: false }
  let bytes
  try {
    bytes = readFile(path.resolve(baseDir, line.reply_file))
  } catch {
    return { cell: 'missing-file', valid: false }
  }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8')
  if (sha256(buffer) !== line.reply_sha256) return { cell: 'hash-mismatch', valid: false }
  let text = buffer.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return classifyReplyText(text, line.kind)
}

// ---------------------------------------------------------------------------
// Tallies and topics files

function parseKeyedFile(text, label, source) {
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new CompareError(`${label} ${source}: not valid JSON (${error.message})`)
  }
  if (!isObject(value)) throw new CompareError(`${label} ${source}: expected a JSON object keyed by consult_id`)
  return value
}

/**
 * Parse a tallies file: a JSON object keyed by consult_id whose entries carry
 * non-negative integer confirmed, refuted, and unverifiable. Throws
 * CompareError (exit 1) naming the consult_id of the first bad entry.
 * @returns {Map<string, { confirmed: number, refuted: number, unverifiable: number }>}
 */
export function parseTallies(text, source = 'tallies') {
  const value = parseKeyedFile(text, 'tallies', source)
  const tallies = new Map()
  for (const [id, entry] of Object.entries(value)) {
    const where = `tallies ${source}: consult_id ${JSON.stringify(id)}`
    if (!isObject(entry)) throw new CompareError(`${where}: expected an object with confirmed, refuted and unverifiable`)
    const counts = {}
    for (const field of TALLY_FIELDS) {
      const count = Object.hasOwn(entry, field) ? entry[field] : undefined
      if (!Number.isSafeInteger(count) || count < 0) throw new CompareError(`${where}: ${field} must be a non-negative integer`)
      counts[field] = count
    }
    tallies.set(id, counts)
  }
  return tallies
}

/**
 * Parse a topics file: a JSON object mapping consult_id to a topic slug
 * (TOPIC_SLUG after trimming). Throws CompareError (exit 1) naming the
 * consult_id of the first bad entry.
 * @returns {Map<string, string>}
 */
export function parseTopics(text, source = 'topics') {
  const value = parseKeyedFile(text, 'topics', source)
  const topics = new Map()
  for (const [id, topic] of Object.entries(value)) {
    const slug = normalizeTopic(topic)
    if (slug === undefined) {
      throw new CompareError(`topics ${source}: consult_id ${JSON.stringify(id)}: topic must be a string matching ^[a-z0-9][a-z0-9-]{0,39}$`)
    }
    topics.set(id, slug)
  }
  return topics
}

// ---------------------------------------------------------------------------
// Cost

/** The line's own cost_usd when it is a number, else undefined (`n/a`). */
export function recordedCost(line) {
  return finite(line.cost_usd) ? line.cost_usd : undefined
}

/**
 * Tokens times the --price of the line's model, in USD, or undefined (`n/a`)
 * when the model has no price or a needed token field is null or absent.
 * Cache tokens are needed, and priced, only when the price has cache rates.
 */
export function pricedCost(line, prices) {
  const price = typeof line.model === 'string' ? prices.get(line.model) : undefined
  if (price === undefined) return undefined
  const input = tokenCount(line.input_tokens)
  const output = tokenCount(line.output_tokens)
  if (input === undefined || output === undefined) return undefined
  let total = input * price.input + output * price.output
  if (price.cacheRead !== null) {
    const read = tokenCount(line.cache_read_tokens)
    const write = tokenCount(line.cache_write_tokens)
    if (read === undefined || write === undefined) return undefined
    total += read * price.cacheRead + write * price.cacheWrite
  }
  return total / 1e6
}

// ---------------------------------------------------------------------------
// Comparison

const sum = () => ({ sum: 0, n: 0, na: 0 })
function add(acc, value) {
  if (value === undefined) {
    acc.na++
  } else {
    acc.sum += value
    acc.n++
  }
}

function armTotals(arm, runs, { replyOf, tallies, prices }) {
  const total = {
    arm,
    runs: runs.length,
    answered: 0,
    ok: 0,
    degraded: 0,
    failed: 0,
    valid: 0,
    tally: { confirmed: 0, refuted: 0, unverifiable: 0 },
    ids: 0,
    tallied: 0,
    tokens: Object.fromEntries(TOKEN_FIELDS.map(([label]) => [label, sum()])),
    duration: sum(),
    recorded: sum(),
    priced: sum(),
  }
  const ids = new Set()
  for (const run of runs) {
    const { line } = run
    if (isAnswered(line)) {
      total.answered++
      if (line.status === 'ok') total.ok++
      else total.degraded++
      if (replyOf(run).valid) total.valid++
    } else {
      total.failed++
    }
    for (const [label, field] of TOKEN_FIELDS) add(total.tokens[label], tokenCount(line[field]))
    add(total.duration, finite(line.duration_s) ? line.duration_s : undefined)
    add(total.recorded, recordedCost(line))
    add(total.priced, pricedCost(line, prices))
    if (typeof line.consult_id === 'string') ids.add(line.consult_id)
  }
  // Tallies belong to a consult_id, which a CLI fallback shares across its
  // attempts: count each id once.
  for (const id of ids) {
    const tally = tallies.get(id)
    if (tally === undefined) continue
    total.tallied++
    for (const field of TALLY_FIELDS) total.tally[field] += tally[field]
  }
  total.ids = ids.size
  return total
}

/**
 * Pair the parsed ledger into rows (exactly two per topic, plugin then cli,
 * in first-seen topic order) and per-arm totals: `all` over every terminal
 * line of the listed topics, `paired` over the shown runs of topics where
 * both arms have one. Reply files are read only for answered lines, once each.
 */
export function buildComparison(ledger, { tallies = new Map(), prices = new Map(), readFile = readRegularFile, baseDir = process.cwd() } = {}) {
  const groups = groupTopics(ledger.runs)
  const replies = new Map()
  const replyOf = (run) => {
    let reply = replies.get(run)
    if (reply === undefined) {
      // A relative reply_file resolves against the directory of the run's own ledger.
      reply = replyStatus(run.line, { readFile, baseDir: run.baseDir ?? baseDir })
      replies.set(run, reply)
    }
    return reply
  }
  const rows = []
  const sharedTopics = []
  for (const group of groups) {
    for (const arm of ARMS) {
      const runs = group[arm]
      if (runs.length === 0) {
        rows.push({ topic: group.topic, arm, missing: true })
        continue
      }
      const ids = [...new Set(runs.map(({ line }) => line.consult_id).filter((id) => typeof id === 'string'))]
      if (ids.length > 1) sharedTopics.push({ topic: group.topic, arm, ids })
      const run = shownRun(runs)
      const { line } = run
      rows.push({
        topic: group.topic,
        arm,
        missing: false,
        runs: runs.length,
        line,
        reply: replyOf(run),
        tally: typeof line.consult_id === 'string' ? tallies.get(line.consult_id) : undefined,
        recorded: recordedCost(line),
        priced: pricedCost(line, prices),
      })
    }
  }
  const context = { replyOf, tallies, prices }
  const paired = groups.filter((group) => group.plugin.length > 0 && group.cli.length > 0)
  const totals = {
    all: ARMS.map((arm) => armTotals(arm, groups.flatMap((group) => group[arm]), context)),
    paired: ARMS.map((arm) => armTotals(arm, paired.map((group) => shownRun(group[arm])), context)),
  }
  const unpaired = {
    plugin: groups.filter((group) => group.plugin.length > 0 && group.cli.length === 0).length,
    cli: groups.filter((group) => group.cli.length > 0 && group.plugin.length === 0).length,
  }

  const listed = ledger.runs
  const listedIds = new Set(listed.map((run) => run.line.consult_id).filter((id) => typeof id === 'string'))
  const listedModels = new Set(listed.map((run) => run.line.model).filter((model) => typeof model === 'string'))
  const unansweredStatuses = Object.fromEntries(ARMS.map((arm) => [arm, new Map()]))
  let cacheUnpriced = 0
  let relativeReplies = 0
  for (const { arm, line } of listed) {
    if (!isAnswered(line)) {
      const status = typeof line.status === 'string' ? line.status : null
      unansweredStatuses[arm].set(status, (unansweredStatuses[arm].get(status) ?? 0) + 1)
    } else if (typeof line.reply_file === 'string' && line.reply_file !== '' && !path.isAbsolute(line.reply_file)) {
      relativeReplies++
    }
    const price = typeof line.model === 'string' ? prices.get(line.model) : undefined
    const cached = (tokenCount(line.cache_read_tokens) ?? 0) > 0 || (tokenCount(line.cache_write_tokens) ?? 0) > 0
    if (price !== undefined && price.cacheRead === null && cached && pricedCost(line, prices) !== undefined) cacheUnpriced++
  }
  return {
    rows,
    totals,
    unpaired,
    sharedTopics,
    excluded: ledger.excluded,
    otherKinds: ledger.otherKinds,
    badTopics: ledger.badTopics,
    topicsSupplied: ledger.topicsSupplied,
    topicsOverridden: ledger.topicsOverridden,
    topicsUnused: ledger.topicsUnused,
    unparseable: ledger.unparseable,
    duplicates: ledger.duplicates ?? 0,
    ledgers: ledger.ledgers ?? 1,
    unansweredStatuses,
    cacheUnpriced,
    relativeReplies,
    unusedPrices: [...prices.keys()].filter((model) => !listedModels.has(model)),
    unmatchedTallies: [...tallies.keys()].filter((id) => !listedIds.has(id)),
  }
}

// ---------------------------------------------------------------------------
// Report

const text = (value) => (typeof value === 'string' && value !== '' ? value : '-')
const usd = (value) => (value === undefined ? 'n/a' : value.toFixed(4))
const seconds = (value) => value.toFixed(1)

/** The raw cells of one row, in COLUMNS order (renderReport escapes them). */
export function rowCells(row) {
  if (row.missing) return COLUMNS.map((column) => (column === 'topic' ? row.topic : column === 'arm' ? row.arm : column === 'status' ? 'missing' : '-'))
  const { line } = row
  return [
    row.topic,
    row.arm,
    text(line.kind),
    text(line.consult_id),
    isoTime(line.ts),
    text(line.model),
    String(row.runs),
    typeof line.status === 'string' && line.status !== '' ? line.status : 'unknown',
    row.reply.cell,
    ...TALLY_FIELDS.map((field) => (row.tally === undefined ? '-' : String(row.tally[field]))),
    ...TOKEN_FIELDS.map(([, field]) => {
      const count = tokenCount(line[field])
      return count === undefined ? '-' : String(count)
    }),
    finite(line.duration_s) ? seconds(line.duration_s) : '-',
    usd(row.recorded),
    usd(row.priced),
  ]
}

function summed(acc, format, alwaysCountNa = false) {
  // A sum with no numeric value at all is n/a, never zero; zero runs sum to zero.
  const value = acc.n === 0 && acc.na > 0 ? 'n/a' : format(acc.sum)
  return alwaysCountNa || acc.na > 0 ? `${value} (n/a runs: ${acc.na})` : value
}

/** One totals line: label is "all runs" or "paired". */
export function totalsLine(label, total) {
  const tokens = TOKEN_FIELDS.map(([name]) => `${name} ${summed(total.tokens[name], String)}`)
  return `- ${label}, ${total.arm}: runs ${total.runs}, answered ${total.answered} (ok ${total.ok}, degraded ${total.degraded}), `
    + `failed ${total.failed}, valid replies ${total.valid}, `
    + `confirmed ${total.tally.confirmed}, refuted ${total.tally.refuted}, unverifiable ${total.tally.unverifiable} `
    + `(tallied consult_ids: ${total.tallied} of ${total.ids}), ${tokens.join(', ')}, `
    + `duration_s ${summed(total.duration, seconds)}, `
    + `recorded ${summed(total.recorded, (value) => value.toFixed(4), true)}, `
    + `priced ${summed(total.priced, (value) => value.toFixed(4), true)}`
}

function priceText(prices) {
  if (prices.size === 0) return 'none (every priced cell is n/a)'
  return [...prices.values()].map((price) => (price.cacheRead === null
    ? `${escapeText(price.model)} in ${price.input}, out ${price.output} (no cache rates)`
    : `${escapeText(price.model)} in ${price.input}, out ${price.output}, cache read ${price.cacheRead}, cache write ${price.cacheWrite}`)).join('; ')
}

const armCounts = (counts) => `plugin ${counts.plugin}, cli ${counts.cli}`
const armSum = (counts) => counts.plugin + counts.cli

function notesOf(comparison, meta) {
  const { excluded } = comparison
  const notes = [`Excluded ${armSum(excluded.unset)} terminal ledger line(s) with a missing or unset topic (${armCounts(excluded.unset)}).`]
  if (armSum(excluded.kind) > 0) {
    const kinds = [...comparison.otherKinds].map(([kind, count]) => `${word(kind, '(no kind)')} ${count}`).join(', ')
    notes.push(`Excluded ${armSum(excluded.kind)} terminal ledger line(s) of a kind other than plan or advice that \`--topics\` does not name (${armCounts(excluded.kind)}): ${kinds}.`)
  }
  if (armSum(excluded.slug) > 0) {
    notes.push(`Warning: excluded ${armSum(excluded.slug)} terminal ledger line(s) whose topic does not match \`^[a-z0-9][a-z0-9-]{0,39}$\` after trimming (${armCounts(excluded.slug)}): ${listText(comparison.badTopics)}.`)
  }
  if (comparison.unparseable > 0) notes.push(`Skipped ${comparison.unparseable} unparseable ledger line(s).`)
  if (comparison.duplicates > 0) {
    notes.push(`Dropped ${comparison.duplicates} duplicate ledger line(s): the exact same line was already read from an earlier ledger.`)
  }
  if ((meta.aliases ?? []).length > 0) {
    notes.push(`Same file as a ledger listed above, so read once: ${listText(meta.aliases)}.`)
  }
  if ((meta.skippedDefaults ?? []).length > 0) {
    notes.push(`\`ADVISOR_LEDGER\` replaces the default ledgers; existing default ledger(s) not read: ${listText(meta.skippedDefaults)}.`)
  }
  const unanswered = ARMS.filter((arm) => comparison.unansweredStatuses[arm].size > 0)
    .map((arm) => `${arm} ${[...comparison.unansweredStatuses[arm]].map(([status, count]) => `${word(status, '(no status)')} ${count}`).join(', ')}`)
  if (unanswered.length > 0) notes.push(`Unanswered runs by ledger status, all runs: ${unanswered.join('; ')}.`)
  if (comparison.sharedTopics.length > 0) {
    const shared = comparison.sharedTopics.map(({ topic, arm, ids }) => `${escapeText(topic)} ${arm} (${listText(ids)})`).join('; ')
    notes.push(`More than one \`consult_id\` under one topic and arm; only the shown run is paired: ${shared}.`)
  }
  if (meta.topics !== undefined) {
    notes.push(`\`--topics\` supplied the topic of ${comparison.topicsSupplied} line(s) without a valid ledger topic and overrode a different ledger topic on ${comparison.topicsOverridden} line(s).`)
    if (comparison.topicsUnused.length > 0) notes.push(`\`--topics\` entries with no terminal ledger line (ignored): ${listText(comparison.topicsUnused)}.`)
  }
  if (comparison.cacheUnpriced > 0) {
    notes.push(`${comparison.cacheUnpriced} listed run(s) carry cache tokens but were priced without cache rates; their priced cost leaves cache tokens out.`)
  }
  if (comparison.unusedPrices.length > 0) notes.push(`\`--price\` given for model(s) with no listed run: ${listText(comparison.unusedPrices)}.`)
  if (comparison.unmatchedTallies.length > 0) notes.push(`Tallies for \`consult_id\`(s) with no listed run (ignored): ${listText(comparison.unmatchedTallies)}.`)
  if (comparison.relativeReplies > 0) {
    notes.push(`${comparison.relativeReplies} answered run(s) record a relative \`reply_file\`, resolved against the directory of its ledger; \`reply_file\` should be absolute.`)
  }
  if (comparison.ledgers > 1) {
    notes.push(`The ${comparison.ledgers} ledgers are merged in ts order, each keeping its own line order; a line repeated verbatim in a later ledger counts once.`)
  }
  notes.push(
    'Each topic shows the plugin run (advisor dsh) and the CLI run (any other advisor): the last answered (ok or degraded) terminal line, else the last terminal line; runs counts every terminal line of that topic and arm.',
    'all runs totals cover every terminal line of the listed topics, including failed and superseded runs, with tallies counted once per `consult_id`; paired totals cover only topics where both arms have a shown run, and only those shown runs.',
    'Reply: for kind plan or advice, the last candidate of that shape is validated as that kind (fenced blocks, also quoted, indented or nested ones, then unfenced JSON as a last resort); wrong kind means only the other shape was found.',
    'recorded is the line\'s `cost_usd`; priced is (input × in + output × out + cache read × cacheRead + cache write × cacheWrite) / 1e6 for the line\'s model.',
  )
  return notes
}

/** The Markdown report. meta: { ledgers: string[], aliases?, skippedDefaults?, prices, tallies, topics } (file paths). */
export function renderReport(comparison, meta = {}) {
  const prices = meta.prices ?? new Map()
  const out = ['# Advisor comparison', '']
  const ledgers = meta.ledgers ?? []
  if (ledgers.length === 0) out.push('- Ledger: -')
  for (const ledger of ledgers) out.push(`- Ledger: ${escapeText(ledger)}`)
  if (meta.tallies !== undefined) out.push(`- Tallies: ${escapeText(meta.tallies)}`)
  if (meta.topics !== undefined) out.push(`- Topics: ${escapeText(meta.topics)}`)
  out.push(`- Prices (USD per million tokens): ${priceText(prices)}`)
  out.push('')
  out.push(`| ${COLUMNS.join(' | ')} |`)
  out.push(`|${COLUMNS.map((column) => (RIGHT_ALIGNED.has(column) ? '---:' : '---')).join('|')}|`)
  for (const row of comparison.rows) out.push(`| ${rowCells(row).map(escapeText).join(' | ')} |`)
  out.push('', '## Totals', '')
  for (const total of comparison.totals.all) out.push(totalsLine('all runs', total))
  for (const total of comparison.totals.paired) out.push(totalsLine('paired', total))
  out.push(`- unpaired topics: plugin ${comparison.unpaired.plugin} (no cli run), cli ${comparison.unpaired.cli} (no plugin run)`)
  out.push('', '## Notes', '')
  for (const note of notesOf(comparison, meta)) out.push(`- ${note}`)
  return `${out.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Entry point

function readText(file, label) {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    throw new CompareError(`cannot read ${label} ${file}: ${error?.code ?? error?.message ?? error}`)
  }
}

/**
 * Run the comparison. io: { stdout, stderr } with write(text), and env for
 * the default ledgers (ADVISOR_LEDGER, DSH_HOME, XDG_STATE_HOME, HOME).
 * Returns the exit code: 0 on success, 2 for a usage error, 1 when no ledger
 * is found, a ledger is unreadable, or a tallies or topics file is bad.
 */
export function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout
  const stderr = io.stderr ?? process.stderr
  const env = io.env ?? process.env
  try {
    const options = parseArgs(argv)
    if (options.help) {
      stdout.write(HELP)
      return 0
    }
    const { files: ledgers, aliases, skippedDefaults } = resolveLedgers(options.ledgers, env)
    const sources = ledgers.map((file) => ({ file, text: readText(file, 'ledger') }))
    const tallies = options.tallies === undefined ? new Map() : parseTallies(readText(options.tallies, 'tallies'), options.tallies)
    const topics = options.topics === undefined ? new Map() : parseTopics(readText(options.topics, 'topics'), options.topics)
    const comparison = buildComparison(parseLedgers(sources, { topics }), { tallies, prices: options.prices, baseDir: path.dirname(ledgers[0]) })
    stdout.write(renderReport(comparison, {
      ledgers, aliases, skippedDefaults, prices: options.prices, tallies: options.tallies, topics: options.topics,
    }))
    return 0
  } catch (error) {
    // A reader that went away (| head) is not an error worth a message.
    if (error?.code === 'EPIPE') return 0
    const known = error instanceof CompareError
    try {
      stderr.write(`compare: ${oneLine(known ? error.message : `internal error: ${error?.message ?? error}`)}\n`)
    } catch { /* stderr is gone too */ }
    return known ? error.exitCode : 1
  }
}

function invokedDirectly() {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry === '') return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  // Pipe writes report EPIPE asynchronously; a closed reader ends the report quietly.
  const quietEpipe = (error) => {
    if (error?.code !== 'EPIPE') throw error
  }
  process.stdout.on('error', quietEpipe)
  process.stderr.on('error', quietEpipe)
  process.exitCode = main()
}
