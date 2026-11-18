// Host entry of dsh-plugin-session-search-patched (unofficial), row
// session-query-sqlite-patched.
//
// The bundle patch switches the shipped engine row optional-session-query-sqlite
// off and appends this row to the group optional-session-search, whose isolate
// map gives sessionQuery a scope of its own. Each start of the row decides which
// engine provides sessionQuery in that scope (docs/composition-spike.md §13):
//
//   not inside that isolated scope           nothing
//   compatible host (guard.js)               the patched engine of ./engine/index.js
//   guard failure, or the patched engine     the shipped engine class, mounted in this
//     fails to import, construct or start      row with the same row config
//   provider clash (a later layer turned     nothing: the other row already serves;
//     the shipped row back on)                  the line asks to remove the override
//   the fallback fails too                   nothing
//
// Each start logs exactly one line that starts with `session-search-patched:`
// and names the active engine and the reason. Only node: builtins and
// ./guard.js are imported statically; both engines are loaded by dynamic import
// inside try/catch, so an unresolved module can never fail the entry before the
// fallback. apply() never throws or rejects. There is no fallback at search
// time: once an engine is up, its errors reach the caller as they are, and the
// shipped engine is never started because a search failed.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { checkHost, checkScope, describeError, ENGINE_PACKAGE, formatLine, isProviderClash, PINNED_SOURCES } from './guard.js'

export const name = 'session-search-patched'

// The list of the rc.3 engine class (SqliteSessionQueryEngine.inject): the row
// starts only when the engine's dependencies exist, so the nested engine fiber
// starts at once, in the same start of the row.
export const inject = ['sessions']

const ISOLATE = Symbol.for('cordis.isolate')
const PATCHED_MODULE = './engine/index.js'

// The only loaders of the host. Bare specifiers resolve to the host copies
// through the package's peerDependencies (host-import mode `bare`).
const HOST = Object.freeze({
  loadPatched: () => import('./engine/index.js'),
  loadShipped: () => import('@deepseek-ai/dsh-session-query-sqlite'),
  readShippedSources,
})

/** sha256 of the pinned source files of the shipped engine package, or `{ error }` per file. */
function readShippedSources() {
  const sources = {}
  for (const file of Object.keys(PINNED_SOURCES)) {
    try {
      const path = fileURLToPath(import.meta.resolve(`${ENGINE_PACKAGE}/${file}`))
      sources[file] = createHash('sha256').update(readFileSync(path)).digest('hex')
    } catch (error) {
      sources[file] = { error: describeError(error) }
    }
  }
  return sources
}

function readScope(ctx) {
  try {
    return ctx[ISOLATE]?.sessionQuery?.description
  } catch {
    return undefined
  }
}

function readVersion(ctx) {
  try {
    const packages = ctx.get('pluginPackages')
    if (!packages) return { error: 'the pluginPackages service is not available' }
    const entry = packages.packageOf(ENGINE_PACKAGE, import.meta.url)
    if (!entry) return { error: `pluginPackages has no ${ENGINE_PACKAGE} for this package` }
    return entry.version
  } catch (error) {
    return { error: describeError(error) }
  }
}

function readSources(host) {
  try {
    return host.readShippedSources()
  } catch (error) {
    return { error: describeError(error) }
  }
}

function rowStopped(ctx) {
  try {
    return ctx.fiber.uid === null
  } catch {
    return true
  }
}

function className(Engine) {
  try {
    return typeof Engine.name === 'string' && Engine.name !== '' ? Engine.name : 'an anonymous class'
  } catch {
    return 'an unnamed class'
  }
}

/** Import an engine module and take its default export class. */
async function loadEngine(load, label) {
  let module
  try {
    module = await load()
  } catch (error) {
    return { error: `${label} did not load: ${describeError(error)}` }
  }
  let Engine
  try {
    Engine = module?.default
  } catch (error) {
    return { error: `${label} did not load: ${describeError(error)}` }
  }
  if (typeof Engine !== 'function') return { error: `${label} has no default export class` }
  return { Engine }
}

/** Mount an engine as a child fiber of the row and wait until it started or failed. */
async function mountEngine(ctx, Engine, config) {
  let fiber
  try {
    fiber = ctx.plugin(Engine, config)
    await fiber
    return { ok: true }
  } catch (error) {
    if (fiber !== undefined) {
      // The failed engine has already unloaded its provision; drop its fiber too.
      try { await fiber.dispose() } catch { /* nothing left to clean */ }
    }
    return { ok: false, error, clash: isProviderClash(error), stopped: rowStopped(ctx) }
  }
}

const outcome = (level, engine, reason) => ({ level, engine, reason })

const STOPPED = outcome('warn', 'none', 'the row stopped while its engine was starting')

function clash(error) {
  return outcome('error', 'none (another row already provides sessionQuery in this group)',
    `provider clash: ${describeError(error)}; a later layer (a profile or home cordis.patch.yml row with id `
    + 'optional-session-query-sqlite) turned the shipped engine row back on, and it serves search here; '
    + 'remove that override and restart the host')
}

async function decide(ctx, config, host) {
  const scope = checkScope(readScope(ctx))
  if (!scope.ok) return outcome('error', 'none', scope.reason)

  const guard = checkHost({ version: readVersion(ctx), sources: readSources(host) })
  let failure = guard.reason
  if (guard.ok) {
    const patched = await loadEngine(host.loadPatched, `the patched engine ${PATCHED_MODULE}`)
    if (patched.Engine) {
      if (rowStopped(ctx)) return STOPPED
      const mounted = await mountEngine(ctx, patched.Engine, config)
      if (mounted.ok) return outcome('info', `patched ${className(patched.Engine)} (${PATCHED_MODULE})`, guard.reason)
      if (mounted.stopped) return STOPPED
      if (mounted.clash) return clash(mounted.error)
      failure = `the patched engine failed to start: ${describeError(mounted.error)}`
    } else {
      failure = patched.error
    }
  }

  if (rowStopped(ctx)) return STOPPED
  const unavailable = 'search is unavailable in this group until the cause is fixed and the host is restarted'
  const shipped = await loadEngine(host.loadShipped, `the shipped engine ${ENGINE_PACKAGE}`)
  if (!shipped.Engine) return outcome('error', 'none', `${failure}; fallback failed: ${shipped.error}; ${unavailable}`)
  if (rowStopped(ctx)) return STOPPED
  const mounted = await mountEngine(ctx, shipped.Engine, config)
  if (mounted.ok) return outcome('warn', `shipped ${className(shipped.Engine)} (${ENGINE_PACKAGE}) as fallback`, failure)
  if (mounted.stopped) return STOPPED
  if (mounted.clash) return clash(mounted.error)
  return outcome('error', 'none',
    `${failure}; fallback failed: the shipped engine failed to start: ${describeError(mounted.error)}; ${unavailable}`)
}

function report(ctx, { level, engine, reason }) {
  const line = formatLine(engine, reason)
  try {
    ctx.logger(name)[level](line)
    return
  } catch { /* no usable logger: fall through */ }
  try {
    console.error(line)
  } catch { /* nothing left to report to */ }
}

/**
 * Start of the row: mount one engine in the row, or none, and log one line.
 * Never throws or rejects.
 * @param {object} ctx row context
 * @param {unknown} config row config, passed to the mounted engine unchanged
 * @param {typeof HOST} [host] the loaders; cordis passes two arguments, so the
 *   host always runs with HOST (tests hand in fakes)
 */
export async function apply(ctx, config, host = HOST) {
  let result
  try {
    result = await decide(ctx, config, host)
  } catch (error) {
    result = outcome('error', 'none', `unexpected entry failure: ${describeError(error)}`)
  }
  report(ctx, result)
}
