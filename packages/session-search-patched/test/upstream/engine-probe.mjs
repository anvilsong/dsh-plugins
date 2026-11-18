// Probe script of the optional upstream suite (docs/verification.md). Not a test
// file: without a mode it prints its usage and exits 0.
//
//   export PATH="$HOME/.nvm/versions/node/v24.22.3/bin:$PATH"
//   P=packages/session-search-patched/test/upstream/engine-probe.mjs
//   node $P generate --upstream <rc.3 checkout> --out <new folder under os.tmpdir()> [--plan large|medium|small]
//   node --max-old-space-size=N $P heap --upstream <checkout> --engine shipped|generated|shippedLib --store <root> [--private]
//   node $P matrix --upstream <checkout> --store <root> --caps 512,1024 [--engines shipped,generated] [--private]
//   node $P unknown-type --upstream <checkout> --engine <name> --store <root>   (used by the suite)
//
// Every --store is checked by assertScratchStorePath() before anything else
// runs: a path that is, resolves to or lies inside ~/.dsh or ~/.local/state is
// refused with exit code 2. With --private (a copy of a real store) the output
// holds only counts, sizes, timings, heap figures, error codes and hashed ids:
// no message text, snippet, title, header field or log content.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import v8 from 'node:v8'
import zlib from 'node:zlib'
import {
  PROBE_SCRIPT, ROW_CONFIG, assertScratchStorePath, hashId, instrumentPersistence, loadUpstream, makeHeader,
  mountEngine, mountStore, outcome, prng, prose, storeBytes, writeSession,
} from './upstream-lib.mjs'

const RESULT_PREFIX = 'SSP_PROBE_RESULT '
const MB = 1024 * 1024
const round1 = (n) => Math.round(n * 10) / 10

function parseArgs(argv) {
  const [mode, ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index]
    if (!key.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(key)}`)
    const name = key.slice(2)
    const next = rest[index + 1]
    if (next === undefined || next.startsWith('--')) options[name] = true
    else {
      options[name] = next
      index += 1
    }
  }
  return { mode, options }
}

function emit(result) {
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`)
}

function requireOption(options, name) {
  const value = options[name]
  if (typeof value !== 'string' || value === '') throw new Error(`--${name} is required`)
  return value
}

function upstreamOf(options) {
  return fs.realpathSync(requireOption(options, 'upstream'))
}

/** Event types a real store may hold from plugins absent in a bare checkout (the replay harness's list). */
const PLUGIN_EVENT_TYPES = ['plugin:action-cards/decision', 'plugin:client-ui-forge/worktree', 'ultracode/team-claimed', 'ultracode/team-released']

// --- generate ---------------------------------------------------------------------

/** Session size plans: [count, decoded text megabytes per session]. */
const PLANS = {
  large: [[2, 120], [4, 60], [12, 20], [40, 5], [142, 0.5]],
  medium: [[2, 40], [6, 10], [40, 1], [52, 0.2]],
  small: [[1, 4], [10, 0.5], [49, 0.05]],
}

async function generate(options) {
  const upstream = upstreamOf(options)
  const out = path.resolve(requireOption(options, 'out'))
  assertScratchStorePath(out)
  const tmp = fs.realpathSync(os.tmpdir())
  const parent = fs.realpathSync(path.dirname(out))
  const relative = path.relative(tmp, parent)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`--out must lie under os.tmpdir() (${tmp})`)
  if (fs.existsSync(out)) throw new Error(`--out ${out} exists already`)
  const plan = PLANS[options.plan ?? 'large']
  if (plan === undefined) throw new Error(`unknown --plan ${options.plan}`)
  const up = await loadUpstream(upstream)
  const root = path.join(out, 'sessions')
  const cwdBase = path.join(out, 'cwd')
  const cwds = ['north', 'south', 'east', 'west'].map((name) => path.join(cwdBase, name))
  for (const cwd of cwds) fs.mkdirSync(cwd, { recursive: true })
  const store = await mountStore(up, root)
  const random = prng(Number(options.seed ?? 11))
  const started = performance.now()
  let sessions = 0
  let events = 0
  let textChars = 0
  try {
    for (const [count, megabytes] of plan) {
      for (let n = 0; n < count; n += 1) {
        const index = sessions
        const userChars = 1500
        const assistantChars = 4500
        const turns = Math.max(1, Math.round((megabytes * MB) / (userChars + assistantChars + 900)))
        const header = makeHeader(up, `syn-${String(index).padStart(4, '0')}`, {
          createdAt: 1_700_000_000_000 + index * 60_000,
          cwd: cwds[index % cwds.length],
        })
        const extra = index % 3 === 0 ? ['needle', '数据库迁移失败'] : ['haystack']
        const written = await writeSession(up, store.P, header, {
          turns,
          batchTurns: 40,
          turnText: () => ({ user: prose(random, userChars, extra), assistant: prose(random, assistantChars, extra) }),
        })
        sessions += 1
        events += written.events
        textChars += written.textChars
      }
    }
  } finally {
    await store.dispose()
  }
  const generateMs = Math.round(performance.now() - started)
  const decoded = decodedBytes(root)
  emit({ mode: 'generate', root, plan: options.plan ?? 'large', sessions, events, textChars, ...decoded, disk: storeBytes(root).disk, generateMs })
}

/** Decoded bytes of every log under a JSONL root (zstd frames decompressed in memory, never printed). */
function decodedBytes(root) {
  let total = 0
  let max = 0
  let logs = 0
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.startsWith('session.v')) {
        const raw = fs.readFileSync(full)
        const size = entry.name.endsWith('.zstd') ? zlib.zstdDecompressSync(raw).length : raw.length
        total += size
        max = Math.max(max, size)
        logs += 1
      }
    }
  }
  walk(root)
  return { logs, decodedTotal: total, decodedMax: max }
}

// --- heap -------------------------------------------------------------------------

async function heap(options) {
  const store = assertScratchStorePath(requireOption(options, 'store'))
  const isPrivate = options.private === true
  const engineName = requireOption(options, 'engine')
  const upstream = upstreamOf(options)
  const query = isPrivate ? 'the' : (options.query ?? 'needle')
  const sampleMs = Number(options['sample-ms'] ?? 20)
  const started = performance.now()
  let peakHeap = 0
  let peakAt = 'boot'
  let phase = 'boot'
  const sample = () => {
    const used = v8.getHeapStatistics().used_heap_size
    if (used > peakHeap) {
      peakHeap = used
      peakAt = phase
    }
  }
  const timer = setInterval(sample, sampleMs)
  const up = await loadUpstream(upstream, options['shipped-lib'] === undefined ? {} : { shippedLib: options['shipped-lib'] })
  const engine = up.engines[engineName]
  if (engine === undefined) throw new Error(`unknown --engine ${engineName}`)
  if (options['admit-plugin-types'] === true) for (const type of PLUGIN_EVENT_TYPES) up.session.KNOWN_SESSION_EVENT_TYPES.add(type)
  const mounted = await mountEngine(up, engine.Engine, store, { compression: options.compression ?? 'zstd', config: ROW_CONFIG })
  const counter = instrumentPersistence(mounted.P, { onWholeRead: () => sample() })
  const result = {
    mode: 'heap', engine: engineName, heapLimitMB: round1(v8.getHeapStatistics().heap_size_limit / MB), private: isPrivate,
  }
  try {
    phase = 'first-search'
    const t0 = performance.now()
    const first = await outcome(mounted.search.searchSessions({ query, limit: 20 }))
    result.firstSearchMs = Math.round(performance.now() - t0)
    sample()
    result.first = summarize(first, isPrivate)
    result.firstCost = { lists: counter.tally.lists, wholeLogReads: counter.tally.wholeLogReads }
    counter.reset()
    phase = 'second-search'
    const t1 = performance.now()
    const second = await outcome(mounted.search.searchSessions({ query, limit: 20 }))
    result.secondSearchMs = Math.round(performance.now() - t1)
    sample()
    result.second = summarize(second, isPrivate)
    result.secondCost = { lists: counter.tally.lists, wholeLogReads: counter.tally.wholeLogReads }
    phase = 'after'
    result.listed = (await mounted.P.list()).length
  } finally {
    clearInterval(timer)
    sample()
    await mounted.dispose()
  }
  const usage = process.resourceUsage()
  Object.assign(result, {
    peakHeapMB: round1(peakHeap / MB), peakAt, maxRssMB: Math.round(usage.maxRSS / 1024),
    wallMs: Math.round(performance.now() - started),
  })
  emit(result)
}

function summarize(settled, isPrivate) {
  if (!settled.ok) return isPrivate ? { ok: false, code: settled.code, causeName: settled.causeName } : { ok: false, code: settled.code, message: settled.message }
  return { ok: true, hits: settled.value.items.length, hitIds: settled.value.items.map((item) => hashId(item.header.id)), more: settled.value.nextCursor !== undefined }
}

// --- matrix -----------------------------------------------------------------------

function runChild(args, { nodeArgs = [], timeoutMs = 30 * 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...nodeArgs, PROBE_SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

/** Peak used heap from --trace-gc lines ("A (B) -> C (D) MB"): the largest A, i.e. the heap at the start of a GC. */
function traceGcPeak(stdout) {
  let peak = 0
  let lines = 0
  for (const match of stdout.matchAll(/(\d+(?:\.\d+)?) \((\d+(?:\.\d+)?)\) -> (\d+(?:\.\d+)?) \((\d+(?:\.\d+)?)\) MB/g)) {
    peak = Math.max(peak, Number(match[1]))
    lines += 1
  }
  return { traceGcPeakMB: round1(peak), gcLines: lines }
}

async function matrix(options) {
  const store = assertScratchStorePath(requireOption(options, 'store'))
  const upstream = upstreamOf(options)
  const caps = String(requireOption(options, 'caps')).split(',').map((cap) => (cap === 'default' ? 'default' : Number(cap)))
  const engines = String(options.engines ?? 'shipped,generated').split(',')
  const rows = []
  for (const cap of caps) {
    for (const engine of engines) {
      const nodeArgs = ['--trace-gc', ...(cap === 'default' ? [] : [`--max-old-space-size=${cap}`])]
      const args = ['heap', '--upstream', upstream, '--engine', engine, '--store', store]
      if (options.private === true) args.push('--private')
      if (options['admit-plugin-types'] === true) args.push('--admit-plugin-types')
      if (options['shipped-lib'] !== undefined) args.push('--shipped-lib', options['shipped-lib'])
      const started = performance.now()
      const run = await runChild(args, { nodeArgs })
      const line = run.stdout.split('\n').find((text) => text.startsWith(RESULT_PREFIX))
      const row = {
        cap, engine, exitCode: run.code, signal: run.signal, childWallMs: Math.round(performance.now() - started),
        oom: /heap out of memory|Reached heap limit/i.test(run.stderr + run.stdout),
        ...traceGcPeak(run.stdout),
        ...(line === undefined ? {} : JSON.parse(line.slice(RESULT_PREFIX.length))),
      }
      if (line === undefined && options.private !== true) row.stderrTail = run.stderr.split('\n').slice(-6).join('\n')
      rows.push(row)
      process.stderr.write(`${JSON.stringify(compactRow(row))}\n`)
    }
  }
  emit({ mode: 'matrix', store: options.private === true ? '(private copy)' : store, rows })
}

function compactRow(row) {
  return {
    cap: row.cap, engine: row.engine, exit: row.exitCode, oom: row.oom, peakHeapMB: row.peakHeapMB, traceGcPeakMB: row.traceGcPeakMB,
    maxRssMB: row.maxRssMB, first: row.first?.ok ?? null, firstCode: row.first?.code, firstSearchMs: row.firstSearchMs,
  }
}

// --- unknown-type (criterion 4, run by the suite) ---------------------------------

async function unknownType(options) {
  const store = assertScratchStorePath(requireOption(options, 'store'))
  const upstream = upstreamOf(options)
  const unhandled = []
  process.on('unhandledRejection', (reason) => unhandled.push(String(reason?.code ?? reason)))
  process.on('uncaughtException', (error) => unhandled.push(String(error?.code ?? error)))
  const up = await loadUpstream(upstream)
  const engine = up.engines[requireOption(options, 'engine')]
  const mounted = await mountEngine(up, engine.Engine, store)
  const first = await outcome(mounted.search.searchSessions({ query: 'needle' }))
  const second = await outcome(mounted.search.searchSessions({ query: 'needle' }))
  const events = await outcome(mounted.search.searchEvents({ sessionId: up.session.SessionId(requireOption(options, 'good-session')), query: 'needle' }))
  await sleep(50)
  for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => setImmediate(resolve))
  await mounted.dispose()
  const strip = ({ ok, code, message, causeName, name }) => ({ ok, name, code, message, causeName })
  emit({ mode: 'unknown-type', pid: process.pid, first: strip(first), second: strip(second), events: strip(events), unhandled, alive: true })
  // Exit by draining the event loop, not process.exit: a leaked handle would hang the child and fail the suite's timeout.
}

// --- main -------------------------------------------------------------------------

const { mode, options } = parseArgs(process.argv.slice(2))
const modes = { generate, heap, matrix, 'unknown-type': unknownType }
if (mode === undefined) {
  process.stdout.write('engine-probe.mjs: probe script of test/upstream (modes: generate, heap, matrix, unknown-type); see docs/verification.md\n')
} else if (modes[mode] === undefined) {
  process.stderr.write(`unknown mode ${JSON.stringify(mode)}\n`)
  process.exitCode = 2
} else {
  try {
    await modes[mode](options)
  } catch (error) {
    if (error?.code === 'SSP_FORBIDDEN_STORE_PATH') {
      emit({ mode, refused: true, code: error.code, message: error.message })
      process.exitCode = 2
    } else {
      process.stderr.write(`${options.private === true ? `${error?.name}: ${error?.code ?? ''}` : (error?.stack ?? String(error))}\n`)
      process.exitCode = 1
    }
  }
}
