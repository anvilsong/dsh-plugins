// Shared parts of the optional upstream suite (engine-upstream.test.mjs) and of
// its probe script (engine-probe.mjs). Importing this module has no side
// effects: nothing is loaded from the checkout until loadUpstream() runs.
//
// The checkout named by DSH_UPSTREAM_DIR must be the rc.3 source tree
// (tag dsh-v0.2.2-rc.3) with its dependencies installed. Its TypeScript sources
// load through its own tsx and tsconfig paths; the same paths resolve the bare
// imports of the generated engine in this package (src/engine/index.js), so the
// shipped and the generated engine share one cordis, one dsh-session and one
// dsh-session-query module instance.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PKG_DIR = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
export const GENERATED_DIR = path.join(PKG_DIR, 'src', 'engine')
export const GENERATED_INDEX = path.join(GENERATED_DIR, 'index.js')
export const VENDOR_SPEC = path.join(PKG_DIR, 'vendor', 'tests', 'sqlite.spec.ts')
export const PROBE_SCRIPT = fileURLToPath(new URL('./engine-probe.mjs', import.meta.url))

/** Engine row config of the bundle patch (docs/composition-spike.md §4). */
export const ROW_CONFIG = Object.freeze({ path: ':memory:', openAt: 'first-search', persistedReadConcurrency: 1 })

/** rc.3 facts (vendor/PROVENANCE.md, docs/build-audit.md). */
export const RC3 = Object.freeze({
  commit: '38a6a5c965aa99ab525161efb7cc5cf1fe62fced',
  engineSrc: Object.freeze({
    'packages/session-query/session-query-sqlite/src/index.ts': '72868e4ae967fee94967df5939ee092a582249ff7b37afc4fe0cf7660d48b8d3',
    'packages/session-query/session-query-sqlite/src/query.ts': 'b29363581b715a1eb50509d7c5ff039d7d4004926160cd88ffcbadaa44ca1c48',
    'packages/session-query/session-query-sqlite/src/schema.ts': '2cc4c7c8e50409847599a048922d55ef4ffbd1ac2309502f3a5a06420bc1a28f',
  }),
  /** Compiled engine of the installed app (`lib/index.js` extracted from app.asar). */
  shippedLib: 'dbecf83320e10d93d735b3d01384ab817a0b90102ccecb0a22c013c71dfe70a0',
  /** vendor/tests/sqlite.spec.ts */
  vendorSpec: '4d58c79c3413012c8c7fb23ec02782864df323662832bfa4a158938002c05296',
})

/** Upstream files the suite loads, relative to the checkout. */
export const FILES = Object.freeze({
  tsx: 'node_modules/tsx/dist/esm/api/index.mjs',
  tsconfig: 'tsconfig.json',
  tsconfigBase: 'tsconfig.base.json',
  vitest: 'node_modules/vitest/vitest.mjs',
  vitestShared: 'vitest.shared.ts',
  cordis: 'vendor/cordis/src/index.ts',
  schemastery: 'vendor/schemastery/src/index.ts',
  session: 'packages/core/session/src/index.ts',
  projection: 'packages/session/session-projection/src/index.ts',
  persistence: 'packages/session/session-persistence/src/index.ts',
  jsonl: 'packages/session/session-persistence-jsonl/src/index.ts',
  sessionQuery: 'packages/session-query/session-query/src/index.ts',
  llm: 'packages/llm/llm/src/index.ts',
  shippedEngine: 'packages/session-query/session-query-sqlite/src/index.ts',
})

/** The native addon the JSONL backend's session lock needs on this platform. */
export const NATIVE_ADDON = `native/system/packages/${process.platform}-${process.arch}/bin/system.node`

export const sha256 = (data) => createHash('sha256').update(data).digest('hex')
export const sha256File = (file) => sha256(fs.readFileSync(file))
/** A short stable hash of an id; the only form in which ids of a private store may be printed. */
export const hashId = (id) => sha256(String(id)).slice(0, 12)

// --- real-home guard -----------------------------------------------------------

/**
 * The account's home folder from the user database, not from $HOME (the suite
 * points HOME at a decoy).
 */
export function realHome() {
  return os.userInfo().homedir
}

/** Folders no store path of this suite may be, resolve to, or lie inside. */
export function forbiddenRoots() {
  const home = realHome()
  return [path.join(home, '.dsh'), path.join(home, '.local', 'state')]
}

// macOS and Windows volumes are case-insensitive by default: ~/.DSH is ~/.dsh.
const foldCase = process.platform === 'darwin' || process.platform === 'win32'
const comparable = (p) => (foldCase ? p.toLowerCase() : p)

function isInside(candidate, root) {
  const relative = path.relative(comparable(root), comparable(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export class ForbiddenStorePathError extends Error {
  constructor(input, resolved, root) {
    super(`refusing store path ${JSON.stringify(input)}: it resolves to ${JSON.stringify(resolved)}, inside ${JSON.stringify(root)} (the real DSH home or state folder)`)
    this.name = 'ForbiddenStorePathError'
    this.code = 'SSP_FORBIDDEN_STORE_PATH'
  }
}

/**
 * Refuse a store path that is, or resolves to, or lies inside ~/.dsh or
 * ~/.local/state of the real account. The path is resolved like realpath(3),
 * one component at a time: `..` applies to the folder reached so far (after
 * the symbolic links before it were followed, so `link/..` is the link
 * target's parent), and a symbolic link's target is spliced in front of the
 * remaining components. Every prefix is checked before it is lstat'ed, so
 * nothing inside a forbidden folder is ever stat'ed, read or listed.
 * Components that do not exist yet are taken as they are.
 * @param {string} input - the store path.
 * @returns {string} the resolved path (symbolic links followed as far as they exist).
 * @throws {ForbiddenStorePathError}
 */
export function assertScratchStorePath(input) {
  if (typeof input !== 'string' || input.trim() === '') throw new TypeError('store path must be a non-empty string')
  const roots = forbiddenRoots()
  const check = (candidate) => {
    for (const root of roots) if (isInside(candidate, root)) throw new ForbiddenStorePathError(input, candidate, root)
  }
  // Lexical check first: an obviously forbidden path is refused without any file-system call.
  check(path.resolve(input))
  const absolute = path.isAbsolute(input) ? input : `${process.cwd()}${path.sep}${input}`
  let resolved = path.parse(absolute).root
  const pending = absolute.slice(resolved.length).split(path.sep)
  let missing = false
  let hops = 0
  while (pending.length > 0) {
    const part = pending.shift()
    if (part === '' || part === '.') continue
    if (part === '..') {
      resolved = path.dirname(resolved)
      check(resolved)
      continue
    }
    const next = path.join(resolved, part)
    check(next)
    if (missing) {
      resolved = next
      continue
    }
    let stat
    try {
      stat = fs.lstatSync(next)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
      missing = true
      resolved = next
      continue
    }
    if (!stat.isSymbolicLink()) {
      resolved = next
      continue
    }
    hops += 1
    if (hops > 64) throw new Error(`refusing store path ${JSON.stringify(input)}: too many symbolic links`)
    const target = fs.readlinkSync(next)
    if (path.isAbsolute(target)) {
      resolved = path.parse(target).root
      pending.unshift(...target.slice(resolved.length).split(path.sep))
    } else {
      pending.unshift(...target.split(path.sep))
    }
  }
  check(resolved)
  return resolved
}

// --- checkout -------------------------------------------------------------------

/**
 * Why the suite cannot run against `upstream`, or undefined when it can.
 * @param {string | undefined} upstream
 */
export function upstreamSkipReason(upstream) {
  if (upstream === undefined) return 'DSH_UPSTREAM_DIR is not set (optional rc.3 engine experiments)'
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 24 || (major === 24 && minor < 9)) return `the rc.3 checkout needs Node >= 24.9 (this is ${process.versions.node})`
  for (const relative of [...Object.values(FILES), NATIVE_ADDON]) {
    if (!fs.existsSync(path.join(upstream, relative))) return `DSH_UPSTREAM_DIR lacks ${relative}`
  }
  for (const [relative, expected] of Object.entries(RC3.engineSrc)) {
    const actual = sha256File(path.join(upstream, relative))
    if (actual !== expected) return `DSH_UPSTREAM_DIR is not the rc.3 checkout: ${relative} has sha256 ${actual.slice(0, 12)}…, rc.3 has ${expected.slice(0, 12)}…`
  }
  return undefined
}

const importFile = (file) => import(pathToFileURL(file).href)

let loaded

/**
 * Load the rc.3 sources of the checkout and both engines. Idempotent per process.
 * @param {string} upstream - canonical checkout path.
 * @param {{ shippedLib?: string }} [options] - folder holding the compiled shipped `index.js` (optional third engine).
 */
export async function loadUpstream(upstream, options = {}) {
  if (loaded !== undefined) return loaded
  const load = (relative) => importFile(path.join(upstream, relative))
  const { register } = await load(FILES.tsx)
  register({ tsconfig: path.join(upstream, FILES.tsconfig) })
  const cordis = await load(FILES.cordis)
  const session = await load(FILES.session)
  const projection = await load(FILES.projection)
  const persistence = await load(FILES.persistence)
  const jsonl = await load(FILES.jsonl)
  const sessionQuery = await load(FILES.sessionQuery)
  const llm = await load(FILES.llm)
  const shipped = await load(FILES.shippedEngine)
  const generated = await importFile(GENERATED_INDEX)
  const engines = {
    shipped: { label: 'shipped rc.3 (checkout src/index.ts)', module: shipped, Engine: shipped.default, file: path.join(upstream, FILES.shippedEngine) },
    generated: { label: 'generated (src/engine/index.js)', module: generated, Engine: generated.default, file: GENERATED_INDEX },
  }
  if (options.shippedLib !== undefined) {
    const file = path.join(options.shippedLib, 'index.js')
    const actual = sha256File(file)
    if (actual !== RC3.shippedLib) throw new Error(`${file} is not the installed rc.3 lib/index.js (sha256 ${actual})`)
    const lib = await importFile(file)
    engines.shippedLib = { label: 'shipped rc.3 (app lib/index.js)', module: lib, Engine: lib.default, file }
  }
  for (const [name, entry] of Object.entries(engines)) {
    // One module instance per base: a second cordis or dsh-session-query copy would split class identity.
    if (Object.getPrototypeOf(entry.Engine) !== sessionQuery.default) throw new Error(`${name} engine does not extend this checkout's SessionQueryEngine`)
    if (!(entry.Engine.prototype instanceof cordis.Service)) throw new Error(`${name} engine is not a Service of this checkout's cordis`)
  }
  const patchMethods = ['_indexPersistedSession', '_commitPersistedSession', '_writeTransaction', '_persistedRowsReusable', '_indexedPersistedRows', '_setMainGeneration']
  for (const method of patchMethods) {
    if (typeof engines.generated.Engine.prototype[method] !== 'function') throw new Error(`generated engine lacks ${method}`)
    if (method in engines.shipped.Engine.prototype) throw new Error(`shipped engine unexpectedly has ${method}`)
  }
  loaded = { upstream, cordis, session, projection, persistence, jsonl, sessionQuery, llm, engines }
  return loaded
}

// --- contexts -------------------------------------------------------------------

/**
 * A context with the rc.3 session store and the JSONL backend over `root`.
 * @param {object} up - loadUpstream() result.
 * @param {string} root - scratch store root, checked by assertScratchStorePath().
 */
export async function mountStore(up, root, { compression = 'zstd' } = {}) {
  assertScratchStorePath(root)
  const ctx = new up.cordis.Context()
  await ctx.plugin(up.session.default)
  await ctx.plugin(up.projection.default)
  await ctx.plugin(up.jsonl, { root, compression })
  return { ctx, P: ctx.sessionPersistence, dispose: () => ctx.fiber.dispose() }
}

/**
 * A context as the host composes it around one engine row: session store,
 * projections, the JSONL backend over `root`, then the engine.
 */
export async function mountEngine(up, Engine, root, { compression = 'zstd', config = ROW_CONFIG, beforeEngine } = {}) {
  const store = await mountStore(up, root, { compression })
  await beforeEngine?.(store.ctx)
  const fiber = store.ctx.plugin(Engine, { ...config })
  await fiber
  return { ...store, fiber, search: store.ctx.sessionQuery }
}

/** Settle a promise into a plain record. */
export const outcome = (promise) => promise.then(
  (value) => ({ ok: true, value }),
  (error) => ({ ok: false, name: error?.name, code: error?.code, message: String(error?.message ?? error), causeName: error?.cause?.name }),
)

/**
 * Count list() calls, open() calls and whole-log reads (`read()` / `read(0)`
 * without a length) per session id on a persistence service. A read is
 * counted when the engine starts it (a read that throws counts too);
 * `onWholeRead` runs after a counted read returned. The rc.3 JSONL backend
 * decodes and validates a log in open(), so a log it refuses fails there and
 * shows up in `openFailures`, not in the read counts.
 */
export function instrumentPersistence(P, { onWholeRead } = {}) {
  const list = P.list.bind(P)
  const open = P.open.bind(P)
  const tally = { lists: 0, wholeLogReads: 0, readsById: new Map(), opens: 0, openFailures: 0 }
  P.list = async (...args) => {
    tally.lists += 1
    return list(...args)
  }
  P.open = async (id, access, ...rest) => {
    tally.opens += 1
    let handle
    try {
      handle = await open(id, access, ...rest)
    } catch (error) {
      tally.openFailures += 1
      throw error
    }
    const read = handle.read.bind(handle)
    handle.read = async (offset, length, readOptions) => {
      const whole = (offset ?? 0) === 0 && length === undefined
      let count
      if (whole) {
        tally.wholeLogReads += 1
        count = tally.wholeLogReads
        tally.readsById.set(id, (tally.readsById.get(id) ?? 0) + 1)
      }
      const result = await read(offset, length, readOptions)
      if (whole) await onWholeRead?.(id, count)
      return result
    }
    return handle
  }
  return {
    tally,
    reset() {
      tally.lists = 0
      tally.wholeLogReads = 0
      tally.readsById = new Map()
      tally.opens = 0
      tally.openFailures = 0
    },
    snapshot() {
      return { lists: tally.lists, wholeLogReads: tally.wholeLogReads, readsById: Object.fromEntries(tally.readsById) }
    },
    /** open() calls of the engine since the last reset, and how many of them rejected. */
    opens() {
      return { opens: tally.opens, openFailures: tally.openFailures }
    },
  }
}

// --- events and stores ------------------------------------------------------------

/** Deterministic PRNG (mulberry32). */
export function prng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function makeHeader(up, id, { createdAt, cwd, parentSession, delegationDepth, agentPreset } = {}) {
  return {
    version: up.session.SESSION_FORMAT_VERSION,
    id: up.session.SessionId(id),
    createdAt: createdAt ?? 1,
    isSeeded: false,
    ...(cwd === undefined ? {} : { cwd }),
    ...(parentSession === undefined ? {} : { parentSession: up.session.SessionId(parentSession), origin: 'subagent' }),
    ...(delegationDepth === undefined ? {} : { delegationDepth }),
    ...(agentPreset === undefined ? {} : { agentPreset }),
  }
}

/** One user/message event at `seq`. */
export function userEvent(up, seq, time, text) {
  return {
    type: 'user/message',
    seq: up.session.SessionSeq(seq),
    time,
    data: up.llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    surfaceOp: 'append',
  }
}

/**
 * One complete turn (6 events) from `base`: turn/start, user/message,
 * step/start, assistant/message, step/end, turn/end.
 * @param {{ user: string, assistant: string, end?: { kind: 'completed' } | { kind: 'aborted' } | { kind: 'error', message: string } }} texts
 */
export function turnEvents(up, base, turn, time, { user, assistant, end = { kind: 'completed' } }) {
  const seq = (offset) => up.session.SessionSeq(base + offset)
  const reason = end.kind === 'error'
    ? { kind: 'error', error: { name: 'Error', message: end.message } }
    : { kind: end.kind }
  return [
    { type: 'turn/start', seq: seq(0), time, data: { turn } },
    { type: 'user/message', seq: seq(1), time: time + 1, surfaceOp: 'append', data: up.llm.createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'user' } }) },
    { type: 'step/start', seq: seq(2), time: time + 2, data: { turn, step: 1 } },
    { type: 'assistant/message', seq: seq(3), time: time + 3, surfaceOp: 'append', data: {
      turn, step: 1, stream: [],
      message: up.llm.createAssistantMessage({ content: [{ type: 'text', text: assistant }], source: { provider: 'mock', model: 'mock' } }),
    } },
    { type: 'step/end', seq: seq(4), time: time + 4, data: { turn, step: 1 } },
    { type: 'turn/end', seq: seq(5), time: time + 5, data: { turn, reason } },
  ]
}

const WORDS = (
  'the of and to in is was for on that with as by at from it an be this which or are have not had but were one all '
  + 'their there been has when who will more no if out so said what up its about into than them can only other new '
  + 'some could time these two may then do first any my now such like our over man me even most made after also did '
  + 'many before must through back years where much your way well down should because each just those people how too '
  + 'little state good very make world still own see men work long get here between both life being under never day '
  + 'same another know while last might us great old year off come since against go came right used take three '
  + 'build config index query cursor session search engine sqlite schema commit revision listing observe retry '
  + 'stable persisted live header snippet token phrase filter paging limit offset generation binding backend '
).trim().split(/\s+/)

// Background CJK and Korean words; the targeted ones of the comparison store
// ('数据库迁移失败', '会话', '検索エンジン') come only from its `extra` lists.
const CJK = [
  '会话搜索引擎', '全文索引', '内存占用过高', '检索结果排序', '用户消息', '助手回复', '配置文件',
  'メモリ使用量', 'セッション履歴', '設定ファイル', '索引の再構築',
  '데이터베이스', '세션 검색',
]

/**
 * Text of roughly `chars` characters from the fixed vocabularies; `extra`
 * words are mixed in at the given probability.
 */
export function prose(random, chars, extra = []) {
  const parts = []
  let length = 0
  while (length < chars) {
    let word
    const roll = random()
    if (extra.length > 0 && roll < 0.1) word = extra[Math.floor(random() * extra.length)]
    else if (roll >= 0.98) word = CJK[Math.floor(random() * CJK.length)]
    else word = WORDS[Math.floor(random() * WORDS.length)]
    parts.push(word)
    length += word.length + 1
    if (random() < 0.06) {
      parts.push('\n')
      length += 1
    }
  }
  return parts.join(' ')
}

/**
 * Write one closed session through the backend: `turns` turns, appended in
 * batches so a large session never holds its whole event list in memory.
 * @returns {{ header: object, events: number, textChars: number }}
 */
export async function writeSession(up, P, header, { turns, turnText, batchTurns = 50 }) {
  const handle = await P.create(header)
  let events = 0
  let textChars = 0
  try {
    for (let first = 0; first < turns; first += batchTurns) {
      const batch = []
      for (let turn = first; turn < Math.min(turns, first + batchTurns); turn += 1) {
        const texts = turnText(turn)
        textChars += texts.user.length + texts.assistant.length
        batch.push(...turnEvents(up, turn * 6, turn + 1, header.createdAt + turn * 10, texts))
      }
      await handle.append(batch)
      events += batch.length
    }
  } finally {
    await handle.close()
  }
  return { header, events, textChars }
}

/** Decoded (uncompressed) and on-disk bytes of every log under a JSONL root, without reading any log as text. */
export function storeBytes(root) {
  let disk = 0
  let files = 0
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        disk += fs.statSync(full).size
        files += 1
      }
    }
  }
  walk(root)
  return { disk, files }
}

// --- comparison store (criterion 5) ------------------------------------------------

export const COMPARISON_CWDS = ['alpha-app', 'bravo-service', 'charlie-tools', 'delta-docs']

/**
 * The ≥50-session comparison store: four project folders, subagent children,
 * agent presets, CJK text, a phrase that occurs both as a phrase and as loose
 * words, aborted and failed turns (log-only documents), and words with graded
 * frequencies so rankings and pages are non-trivial.
 */
export async function writeComparisonStore(up, root, cwdBase, { sessions = 60, seed = 7 } = {}) {
  const random = prng(seed)
  const cwds = COMPARISON_CWDS.map((name) => path.join(cwdBase, name))
  for (const cwd of cwds) fs.mkdirSync(cwd, { recursive: true })
  const store = await mountStore(up, root)
  const written = []
  try {
    for (let index = 0; index < sessions; index += 1) {
      const id = `cmp-${String(index).padStart(3, '0')}`
      const isChild = index % 7 === 3 && index > 3
      const header = makeHeader(up, id, {
        createdAt: 1_700_000_000_000 + index * 3_600_000,
        cwd: index % 11 === 10 ? undefined : cwds[index % cwds.length],
        ...(isChild ? { parentSession: `cmp-${String(index - 3).padStart(3, '0')}`, delegationDepth: 1 } : {}),
        ...(index % 5 === 0 ? { agentPreset: index % 10 === 0 ? 'reviewer' : 'builder' } : {}),
      })
      const turns = 2 + Math.floor(random() * 10)
      const extra = []
      if (index % 3 === 0) extra.push('needle')
      if (index % 4 === 1) extra.push('needle', 'needle', 'haystack')
      if (index % 6 === 2) extra.push('quick brown fox')
      if (index % 5 === 4) extra.push('quick', 'brown', 'fox')
      if (index % 9 === 0) extra.push('数据库迁移失败', '会话')
      if (index % 13 === 0) extra.push('検索エンジン')
      if (index === 17) extra.push('singletonmarker')
      written.push(await writeSession(up, store.P, header, {
        turns,
        turnText: (turn) => ({
          user: prose(random, 80 + Math.floor(random() * 400), extra),
          assistant: prose(random, 120 + Math.floor(random() * 900), extra),
          end: turn === turns - 1 && index % 8 === 5
            ? (index % 16 === 5 ? { kind: 'aborted' } : { kind: 'error', message: `upstream timeout needle ${index}` })
            : { kind: 'completed' },
        }),
      }))
    }
  } finally {
    await store.dispose()
  }
  return { cwds, written }
}

/**
 * The query set of criterion 5. Each entry is a cross-session search (`sessions`)
 * or a within-session search (`events`) and is paged to the end.
 */
export function comparisonQueries(up, cwds) {
  const id = (n) => up.session.SessionId(`cmp-${String(n).padStart(3, '0')}`)
  return [
    { label: 'plain word, paged by 5', kind: 'sessions', request: { query: 'needle', limit: 5 } },
    { label: 'frequent word, paged by 7', kind: 'sessions', request: { query: 'session', limit: 7 } },
    { label: 'phrase (words also loose)', kind: 'sessions', request: { query: 'quick brown fox', limit: 4 } },
    { label: 'two words', kind: 'sessions', request: { query: 'needle haystack', limit: 3 } },
    { label: 'CJK Chinese', kind: 'sessions', request: { query: '数据库迁移失败', limit: 3 } },
    { label: 'CJK Chinese two-character', kind: 'sessions', request: { query: '会话', limit: 4 } },
    { label: 'CJK Japanese', kind: 'sessions', request: { query: '検索エンジン', limit: 2 } },
    { label: 'Korean', kind: 'sessions', request: { query: '세션', limit: 5 } },
    { label: 'CJK background word', kind: 'sessions', request: { query: '全文索引', limit: 9 } },
    { label: 'filter cwd (one project)', kind: 'sessions', request: { query: 'needle', limit: 3, sessionFilters: [{ kind: 'cwd', values: [cwds[1]] }] } },
    { label: 'filter cwd null (no cwd)', kind: 'sessions', request: { query: 'the', limit: 2, sessionFilters: [{ kind: 'cwd', values: [null] }] } },
    { label: 'filter parent (children of cmp-007)', kind: 'sessions', request: { query: 'the', sessionFilters: [{ kind: 'parent', values: [id(7)] }] } },
    { label: 'filter parent null (top-level only)', kind: 'sessions', request: { query: 'needle', limit: 6, sessionFilters: [{ kind: 'parent', values: [null] }] } },
    { label: 'filter created-at range', kind: 'sessions', request: { query: 'the', limit: 4, sessionFilters: [{ kind: 'created-at', from: 1_700_000_000_000 + 10 * 3_600_000, to: 1_700_000_000_000 + 30 * 3_600_000 }] } },
    { label: 'filter id list', kind: 'sessions', request: { query: 'the', sessionFilters: [{ kind: 'id', values: [id(1), id(2), id(40), id(59)] }] } },
    { label: 'filter availability persisted', kind: 'sessions', request: { query: 'fox', limit: 5, sessionFilters: [{ kind: 'availability', values: ['persisted'] }] } },
    { label: 'filter availability live (none)', kind: 'sessions', request: { query: 'fox', sessionFilters: [{ kind: 'availability', values: ['live'] }] } },
    { label: 'event filter type assistant/message', kind: 'sessions', request: { query: 'needle', limit: 5, eventFilters: [{ kind: 'type', values: ['assistant/message'] }] } },
    { label: 'event filter surface log-only (turn/end text)', kind: 'sessions', request: { query: 'needle', limit: 2, eventFilters: [{ kind: 'surface', values: ['log-only'] }] } },
    { label: 'event filter seq range + cwd', kind: 'sessions', request: { query: 'the', limit: 5, eventFilters: [{ kind: 'seq', from: 6, to: 20 }], sessionFilters: [{ kind: 'cwd', values: [cwds[0], cwds[2]] }] } },
    { label: 'aborted turns', kind: 'sessions', request: { query: 'aborted' } },
    { label: 'singleton marker', kind: 'sessions', request: { query: 'singletonmarker' } },
    { label: 'no hit', kind: 'sessions', request: { query: 'zzzunmatchedqqq' } },
    { label: 'no hit CJK', kind: 'sessions', request: { query: '不存在的词语' } },
    { label: 'events in cmp-009, paged by 4', kind: 'events', request: { sessionId: id(9), query: 'needle', limit: 4 } },
    { label: 'events in cmp-018, CJK', kind: 'events', request: { sessionId: id(18), query: '数据库迁移失败', limit: 2 } },
    { label: 'events in cmp-021, type filter, paged by 3', kind: 'events', request: { sessionId: id(21), query: 'needle', limit: 3, filters: [{ kind: 'type', values: ['user/message'] }] } },
    { label: 'events in cmp-002, phrase, time filter', kind: 'events', request: { sessionId: id(2), query: 'quick brown fox', filters: [{ kind: 'time', from: 1_700_000_000_000 + 2 * 3_600_000, to: 1_700_000_000_000 + 2 * 3_600_000 + 60 }] } },
    { label: 'events no hit', kind: 'events', request: { sessionId: id(5), query: 'zzzunmatchedqqq' } },
  ]
}

/** Decode a cursor into its engine-independent part; `instance` and `generation` are per engine by design. */
export function cursorShape(cursor) {
  if (cursor === undefined) return undefined
  const { instance, generation, ...rest } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  return { ...rest, hasInstance: typeof instance === 'string', generationType: typeof generation }
}

/** Run one query to its last page; returns every page with its cursor shape. */
export async function runPaged(search, query, maxPages = 50) {
  const pages = []
  let cursor
  for (let page = 0; page < maxPages; page += 1) {
    const request = cursor === undefined ? query.request : { ...query.request, cursor }
    const result = query.kind === 'sessions' ? await search.searchSessions(request) : await search.searchEvents(request)
    pages.push({
      items: structuredClone(result.items),
      ...(query.kind === 'events' ? { session: structuredClone(result.session) } : {}),
      next: cursorShape(result.nextCursor),
    })
    cursor = result.nextCursor
    if (cursor === undefined) return pages
  }
  throw new Error(`query ${JSON.stringify(query.label)} did not end within ${maxPages} pages`)
}

// --- vitest run of the rebased spec (criterion 2) ----------------------------------

/**
 * vitest config written into a scratch folder of the checkout. The generated
 * engine stays at its place in this package; outside the checkout the tsconfig
 * paths plugin does not apply, so its four bare imports get exact aliases to the
 * same files those paths give every other importer (one module instance each).
 */
export const VITEST_CONFIG = `import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from '../../../../vitest.shared.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../../..')
const engine = process.env.SSP_ENGINE_UNDER_TEST
if (!engine) throw new Error('SSP_ENGINE_UNDER_TEST is not set')

export default defineConfig({
  root,
  plugins: [tsconfigPaths({ projects: [path.join(root, 'tsconfig.base.json')] }), standardDecoratorPlugin()],
  resolve: {
    alias: [
      { find: /^@deepseek-ai\\/dsh-session-query-sqlite$/, replacement: engine },
      { find: /^@deepseek-ai\\/cordis$/, replacement: path.join(root, 'vendor/cordis/src/index.ts') },
      { find: /^@deepseek-ai\\/schemastery$/, replacement: path.join(root, 'vendor/schemastery/src/index.ts') },
      { find: /^@deepseek-ai\\/dsh-session$/, replacement: path.join(root, 'packages/core/session/src/index.ts') },
      { find: /^@deepseek-ai\\/dsh-session-query$/, replacement: path.join(root, 'packages/session-query/session-query/src/index.ts') },
    ],
  },
  test: {
    name: 'ssp-engine-spec',
    execArgv: vitestExecArgv,
    pool: 'forks',
    include: [path.join(here, '*.spec.ts')],
    setupFiles: ['scripts/test-proxy-environment.ts', 'scripts/test-dom-environment.ts', 'scripts/test-official-listing-guard.ts']
      .map(file => path.join(root, file)),
  },
})
`

/** Proves inside the vitest run which engine the spec imported. */
export const IDENTITY_SPEC = `import { describe, expect, it } from 'vitest'
import { Service } from '@deepseek-ai/cordis'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SqliteSessionQueryEngine, * as engineModule from '@deepseek-ai/dsh-session-query-sqlite'

describe('engine under test', () => {
  it('is the generated JS: patch methods, rc.3 base classes of this checkout, rc.3 exports', () => {
    expect(Object.getOwnPropertyNames(SqliteSessionQueryEngine.prototype)).toEqual(expect.arrayContaining([
      '_indexPersistedSession', '_commitPersistedSession', '_writeTransaction',
      '_persistedRowsReusable', '_indexedPersistedRows', '_setMainGeneration',
    ]))
    expect(Object.getPrototypeOf(SqliteSessionQueryEngine)).toBe(SessionQueryEngine)
    expect(SqliteSessionQueryEngine.prototype).toBeInstanceOf(Service)
    expect((SqliteSessionQueryEngine as unknown as { inject: unknown }).inject).toEqual(['sessions'])
    expect(Object.keys(engineModule).sort()).toEqual([
      'SESSION_QUERY_SQLITE_APPLICATION_ID', 'SESSION_QUERY_SQLITE_DEFAULT_LIMIT', 'SESSION_QUERY_SQLITE_MAX_LIMIT',
      'SESSION_QUERY_SQLITE_PATH_KEY', 'SESSION_QUERY_SQLITE_SCHEMA_VERSION', 'SESSION_QUERY_SQLITE_SNIPPET_CHARS',
      'SqliteSessionQueryEngine', 'default',
    ])
  })
})
`

/** Folder of the checkout that receives the scratch vitest files (removed after each run). */
export const SPEC_SCRATCH_PARENT = 'packages/session-query/session-query-sqlite'
