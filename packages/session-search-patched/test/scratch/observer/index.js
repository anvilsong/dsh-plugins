// S8 scratch observer. Mounted only by a scratch profile patch
// (test/scratch/observers.yml) inside a scratch DSH home made by
// scripts/scratch-home.mjs; never part of the shipped package.
//
// where: group  sits inside optional-session-search (the isolated sessionQuery
//               scope), names the class and row that provide sessionQuery there,
//               and runs the query set when a request file appears.
// where: root   writes Loader snapshots on request.
//
// Privacy: the store is a copy of real session logs. Nothing here writes log
// text, titles, snippets, cwd values or session ids: a hit is written as a
// sha256 of the whole hit object, a session as a sha256 of its id, plus ranks,
// seq numbers and counts. Error messages are reduced to their code, with ids
// and paths hashed, before they reach the report.
//
// Environment (set through scratch-home.mjs --set):
//   SSP_REPORT       JSON-lines report file inside the scratch root
//   SSP_TRIGGER_DIR  directory polled for `<label>.query` and `<label>.snapshot` files
//   SSP_ENTRY_URL    file URL of the real package entry (for packageOf lookups)

import { createHash } from 'node:crypto'
import { appendFileSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ISOLATE = Symbol.for('cordis.isolate')
const STATES = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING']
const ENGINE = '@deepseek-ai/dsh-session-query-sqlite'
const PEERS = ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-query', ENGINE]
const PATCH_METHODS = ['_indexPersistedSession', '_commitPersistedSession', '_writeTransaction', '_persistedRowsReusable', '_indexedPersistedRows', '_setMainGeneration']
const PINNED_SOURCES = ['src/index.ts', 'src/query.ts', 'src/schema.ts']

// Query set: the texts are chosen here (no log content). The result files carry
// only the ids q01..q22.
const QUERIES = [
  { id: 'q01', request: { query: 'plugin', limit: 100 } },
  { id: 'q02', request: { query: 'error', limit: 100 } },
  { id: 'q03', request: { query: 'test', limit: 100 } },
  { id: 'q04', request: { query: 'session', limit: 100 } },
  { id: 'q05', request: { query: 'search', limit: 100 } },
  { id: 'q06', request: { query: 'build', limit: 100 } },
  { id: 'q07', request: { query: 'install', limit: 100 } },
  { id: 'q08', request: { query: 'config', limit: 100 } },
  { id: 'q09', request: { query: 'function', limit: 100 } },
  { id: 'q10', request: { query: 'commit', limit: 100 } },
  { id: 'q11', request: { query: 'README', limit: 100 } },
  { id: 'q12', request: { query: 'package.json', limit: 100 } },
  { id: 'q13', request: { query: 'profile web', limit: 100 } },
  { id: 'q14', request: { query: 'scratch home', limit: 100 } },
  { id: 'q15', request: { query: '会话', limit: 100 } },
  { id: 'q16', request: { query: '插件', limit: 100 } },
  { id: 'q17', request: { query: 'zzqxv-no-such-token-8731', limit: 100 } },
  { id: 'q18', request: { query: 'node', limit: 100, sessionFilters: [{ kind: 'availability', values: ['persisted'] }] } },
  { id: 'q19', request: { query: 'file', limit: 100, eventFilters: [{ kind: 'type', values: ['user/message'] }] } },
  { id: 'q20', request: { query: 'the', limit: 10 }, pages: 3 },
  { id: 'q21', request: { query: 'cordis', limit: 100 }, events: true },
  { id: 'q22', request: { query: 'patch', limit: 100 }, events: true },
]

const sha = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const short = (value, n = 16) => sha(value).slice(0, n)

function report(record) {
  const file = process.env.SSP_REPORT
  if (!file) return
  try {
    appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), pid: process.pid, ...record }) + '\n')
  } catch { /* the report is best effort */ }
}

/** Error code plus a message with uuids, paths and quoted text hashed. */
function errorFacts(error) {
  let message = ''
  try { message = String(error?.message ?? error) } catch { message = 'unreadable' }
  const redacted = message.split('\n')[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, m => `<id:${short(m, 10)}>`)
    .replace(/(\/[^\s"':]+)+/g, m => `<path:${short(m, 10)}>`)
    .replace(/"[^"]{0,400}"/g, m => `"<q:${short(m, 10)}>"`)
  return { code: error?.code ?? null, name: error?.constructor?.name ?? null, message: redacted.slice(0, 600) }
}

function chainOf(Ctor) {
  const chain = []
  for (let current = Ctor; typeof current === 'function' && current !== Function.prototype; current = Object.getPrototypeOf(current)) {
    chain.push(current)
  }
  return chain
}

/** The provider of sessionQuery seen from `ctx`, compared with the root-scope shipped instance. */
function providerFacts(ctx) {
  const impl = ctx.reflect._getImpl('sessionQuery', false)
  if (!impl) return null
  const value = impl.value
  const Ctor = value?.constructor
  let rootValue
  try { rootValue = ctx.root.reflect._getImpl('sessionQuery', false)?.value } catch { rootValue = undefined }
  const RootCtor = rootValue?.constructor
  const chain = chainOf(Ctor)
  const rootChain = chainOf(RootCtor)
  return {
    ctor: Ctor?.name ?? null,
    row: impl.ctx?.fiber?.entry?.options?.id ?? null,
    fiberState: STATES[impl.ctx?.fiber?.state] ?? impl.ctx?.fiber?.state ?? null,
    scope: impl.isolate?.description ?? null,
    rootRow: ctx.root.reflect._getImpl('sessionQuery', false)?.ctx?.fiber?.entry?.options?.id ?? null,
    sameClassAsRootShipped: RootCtor !== undefined && Ctor === RootCtor,
    patchMethods: PATCH_METHODS.filter(name => Ctor?.prototype && Object.hasOwn(Ctor.prototype, name)).length,
    chain: chain.map(c => c.name),
    rootChain: rootChain.map(c => c.name),
    // Every base class above the engine class is the very object the shipped root instance uses.
    basesIdenticalToShipped: chain.length > 1 && chain.length === rootChain.length && chain.slice(1).every((c, i) => c === rootChain[i + 1]),
    configKeys: value?.config ? Object.keys(value.config).sort() : null,
    persistedReadConcurrency: value?.config?.persistedReadConcurrency ?? null,
    openAt: value?.config?.openAt ?? null,
  }
}

async function packageFacts(ctx) {
  const facts = {}
  const packages = ctx.get('pluginPackages')
  const entryUrl = process.env.SSP_ENTRY_URL
  if (!packages || !entryUrl) return { error: 'no pluginPackages or SSP_ENTRY_URL' }
  const engineUrl = new URL('./engine/index.js', entryUrl).href
  for (const [label, parent] of [['entry', entryUrl], ['engine', engineUrl]]) {
    facts[label] = {}
    for (const name of [...PEERS, 'dsh-plugin-session-search-patched']) {
      try {
        const found = packages.packageOf(name, parent)
        facts[label][name] = found ? { version: found.version ?? null, dir: found.dir, inAsar: found.dir.includes('app.asar') } : null
      } catch (error) {
        facts[label][name] = { error: errorFacts(error) }
      }
    }
  }
  // sha256 of the shipped sources at the directory packageOf names for the entry,
  // compared with the pins in the package's own src/guard.js.
  try {
    const dir = packages.packageOf(ENGINE, entryUrl)?.dir
    const guard = await import(new URL('./guard.js', entryUrl).href)
    facts.guardPinnedVersion = guard.PINNED_VERSION
    facts.sources = {}
    for (const file of PINNED_SOURCES) {
      const bytes = readFileSync(path.join(dir, file))
      const digest = createHash('sha256').update(bytes).digest('hex')
      facts.sources[file] = { bytes: bytes.length, sha256: digest, equalsGuardPin: digest === guard.PINNED_SOURCES[file] }
    }
  } catch (error) {
    facts.sources = { error: errorFacts(error) }
  }
  return facts
}

async function storeFacts(ctx) {
  const persistence = ctx.get('sessionPersistence')
  if (!persistence) return { error: 'no sessionPersistence' }
  const facts = { backend: persistence.name ?? null, configRoot: persistence.config?.root ?? null, root: persistence.root ?? null }
  const home = process.env.DSH_HOME ?? ''
  facts.dshHome = home
  facts.rootStartsWithScratchHome = home !== '' && typeof facts.root === 'string' && facts.root.startsWith(home + path.sep)
  try {
    const listed = await persistence.list()
    facts.listed = listed.length
  } catch (error) {
    facts.listError = errorFacts(error)
  }
  return facts
}

// Synthetic sessions planted by test/scratch/plant-session.mjs; only these are
// ever read here, and their errors are kept verbatim (they hold no user data).
const PLANTED = ['5508d8c0-0000-4000-8000-00000000000a', '5508d8c0-0000-4000-8000-00000000000b', '5508d8c0-0000-4000-8000-00000000000c']

async function plantedFacts(ctx) {
  const persistence = ctx.get('sessionPersistence')
  if (!persistence) return { error: 'no sessionPersistence' }
  const facts = {}
  try {
    const listed = await persistence.list()
    facts.listed = listed.length
    facts.planted = listed.filter(s => PLANTED.includes(s?.header?.id ?? s?.id)).map(s => ({ id: s.header?.id ?? s.id, formatStatus: s.formatStatus ?? null }))
  } catch (error) {
    facts.listError = { code: error?.code ?? null, name: error?.constructor?.name ?? null, message: String(error?.message ?? error).split('\n')[0].slice(0, 600) }
  }
  facts.reads = {}
  for (const id of PLANTED) {
    try {
      const handle = await persistence.open(id, 'read')
      try {
        const read = await handle.read(0)
        facts.reads[id] = { events: read.events.length, types: read.events.map(e => e.type) }
      } finally {
        await handle.close()
      }
    } catch (error) {
      facts.reads[id] = { code: error?.code ?? null, name: error?.constructor?.name ?? null, message: String(error?.message ?? error).split('\n')[0].slice(0, 600) }
    }
  }
  return facts
}

function hitHash(hit) {
  return { h: short(hit, 32), s: short(hit?.header?.id ?? hit?.sessionId ?? '', 12), seq: hit?.bestMatch?.seq ?? hit?.seq ?? null }
}

async function runQueries(sessionQuery, label, provider) {
  const results = []
  const timings = []
  for (const query of QUERIES) {
    const started = performance.now()
    const entry = { id: query.id }
    try {
      const pages = []
      let request = query.request
      for (let index = 0; index < (query.pages ?? 1); index++) {
        const page = await sessionQuery.searchSessions(request)
        pages.push({ items: page.items.map((hit, rank) => ({ rank, ...hitHash(hit) })), more: page.nextCursor !== undefined })
        if (page.nextCursor === undefined) break
        request = { ...query.request, cursor: page.nextCursor }
      }
      entry.pages = pages
      entry.count = pages.reduce((sum, page) => sum + page.items.length, 0)
      if (query.events && pages[0].items.length > 0) {
        const first = (await sessionQuery.searchSessions(query.request)).items[0]
        const events = await sessionQuery.searchEvents({ sessionId: first.header.id, query: query.request.query, limit: 50 })
        entry.events = { session: short(events.session, 32), items: events.items.map((hit, rank) => ({ rank, h: short(hit, 32), seq: hit.seq })), more: events.nextCursor !== undefined }
      }
    } catch (error) {
      const facts = errorFacts(error)
      entry.error = facts.code ?? facts.name
      report({ event: 'query-error', label, id: query.id, ...facts })
    }
    timings.push({ id: query.id, ms: Math.round(performance.now() - started), count: entry.count ?? null })
    results.push(entry)
  }
  return { results, timings, provider }
}

function snapshot(ctx) {
  const loader = ctx.get('loader')
  const rows = []
  for (const entry of loader?.entries() ?? []) {
    const id = String(entry.options?.id)
    if (!/session|ssp-/.test(id) && !/session-query|session-search/.test(String(entry.options?.name))) continue
    const fiber = entry.fiber
    rows.push({
      id: entry.id,
      name: String(entry.options?.name ?? '').startsWith('file://') ? 'file://<observer>' : entry.options?.name,
      disabled: entry.disabled,
      state: fiber ? STATES[fiber.state] ?? fiber.state : 'NO-FIBER',
      error: fiber?._error ? errorFacts(fiber._error) : undefined,
    })
  }
  return rows
}

/**
 * Lines of the host's in-memory log buffer (cordis LoggerService.buffer, the
 * sink that keeps info and above) that belong to the package under test or to
 * the session-search rows. Lines of the package are kept whole (they hold no
 * session data); other matching lines are reduced like errors.
 */
function logLines(ctx) {
  let buffer = []
  try { buffer = ctx.logger.buffer ?? [] } catch { return { error: 'no logger buffer' } }
  const lines = []
  for (const message of buffer) {
    const first = message?.args?.[0]
    const text = typeof first === 'string' ? first : first instanceof Error ? String(first.message) : ''
    const own = message.name === 'session-search-patched' || text.startsWith('session-search-patched:')
    const related = /session-query|session-search|tool-session-query/.test(String(message.name)) || /sessionQuery/.test(text)
    if (!own && !related) continue
    lines.push({ sn: message.sn, ts: new Date(message.ts).toISOString(), type: message.type, name: message.name, text: own ? text : errorFacts({ message: text }).message })
  }
  return { size: buffer.length, lines }
}

function takeRequests(suffix) {
  const dir = process.env.SSP_TRIGGER_DIR
  if (!dir) return []
  let names = []
  try { names = readdirSync(dir).filter(name => name.endsWith(suffix)) } catch { return [] }
  const labels = []
  for (const name of names.sort()) {
    try { rmSync(path.join(dir, name)) } catch { continue }
    labels.push(name.slice(0, -suffix.length))
  }
  return labels
}

export const name = 'ssp-s8-scratch-observer'

export function apply(ctx, config = {}) {
  const where = config.where ?? 'unknown'
  const scope = ctx[ISOLATE]?.sessionQuery?.description ?? null
  report({ event: 'observer-apply', where, scope })
  ctx.effect(() => () => report({ event: 'observer-dispose', where }), 'ssp observer dispose')

  if (where === 'root') {
    const timer = setInterval(() => {
      for (const label of takeRequests('.snapshot')) {
        let root = null
        try { root = providerFacts(ctx) } catch (error) { root = { error: errorFacts(error) } }
        report({ event: 'snapshot', where, label, rootProvider: root, rows: snapshot(ctx), logs: logLines(ctx) })
      }
    }, 400)
    ctx.effect(() => () => clearInterval(timer), 'ssp observer snapshots')
    return
  }

  ctx.inject(['sessionQuery'], (inner) => {
    let provider = null
    try { provider = providerFacts(inner) } catch (error) { provider = { error: errorFacts(error) } }
    report({ event: 'sessionQuery-up', where, scope, provider })
    let busy = false
    Promise.resolve().then(async () => {
      report({ event: 'facts', where, packages: await packageFacts(inner), store: await storeFacts(inner) })
    }).catch(error => report({ event: 'facts-error', where, ...errorFacts(error) }))
    const timer = setInterval(() => {
      if (busy) return
      for (const label of takeRequests('.store')) {
        busy = true
        plantedFacts(inner).then(facts => report({ event: 'planted', where, label, ...facts }),
          error => report({ event: 'planted-error', where, label, ...errorFacts(error) })).finally(() => { busy = false })
        return
      }
      const labels = takeRequests('.query')
      if (labels.length === 0) return
      busy = true
      Promise.resolve().then(async () => {
        for (const label of labels) {
          let current = null
          try { current = providerFacts(inner) } catch (error) { current = { error: errorFacts(error) } }
          report({ event: 'query-start', where, label, provider: current })
          const started = performance.now()
          const { results, timings } = await runQueries(inner.sessionQuery, label, current)
          const file = path.join(process.env.SSP_TRIGGER_DIR, `results-${label}.json`)
          const text = JSON.stringify({ queries: results }, undefined, 1) + '\n'
          writeFileSync(file, text)
          report({
            event: 'query-done', where, label, provider: current, file, sha256: sha(text),
            totalMs: Math.round(performance.now() - started), errors: results.filter(r => r.error).length,
            hits: results.reduce((sum, r) => sum + (r.count ?? 0), 0), timings,
          })
        }
      }).catch(error => report({ event: 'query-crash', where, ...errorFacts(error) })).finally(() => { busy = false })
    }, 400)
    inner.effect(() => () => {
      clearInterval(timer)
      report({ event: 'sessionQuery-down', where, provider })
    }, 'ssp observer down')
  })
}
