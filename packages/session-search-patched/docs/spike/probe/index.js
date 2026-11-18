// S1 spike probe. Not the shipped entry: it stands in for the patched engine so
// the bundle patch, module resolution, guard inputs and transitions can be
// observed on a scratch DSH home. Facts are appended as JSON lines to the file
// named by $SPIKE_REPORT (a path inside the scratch root).
//
// $SPIKE_PROBE_MODE selects what the row mounts after probing:
//   patched (default)  a subclass of the shipped engine class (stands in for the patched class)
//   shipped            the shipped engine class itself (the fallback path)
//   broken             a failing import of a missing patched module, then the shipped class (guard fallback)
//   none               nothing (row active, no sessionQuery provider)

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ISOLATE = Symbol.for('cordis.isolate')
const ENTRY = Symbol.for('cordis.entry')
const ENGINE = '@deepseek-ai/dsh-session-query-sqlite'
const SPECIFIERS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-query',
  ENGINE,
  'node:sqlite',
  // Not declared as peers on purpose: they show where an undeclared host package resolves.
  '@deepseek-ai/cosmokit',
  '@deepseek-ai/dsh-app-boot',
]

function report(record) {
  const file = process.env.SPIKE_REPORT
  if (!file) return
  appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), pid: process.pid, ...record }) + '\n')
}

function errorFacts(error) {
  return { code: error?.code, message: String(error?.message ?? error).split('\n')[0] }
}

function packageDirOf(url, name) {
  let dir = path.dirname(fileURLToPath(url))
  for (;;) {
    const manifest = path.join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8')).name === name) return dir
      } catch { /* keep walking */ }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

export const name = 'session-search-patched-probe'

export async function apply(ctx, config) {
  const rowId = ctx[ENTRY]?.options?.id
  const facts = { resolve: {}, import: {}, identity: {}, version: {}, asar: {}, isolate: {}, env: {} }
  const modules = {}

  for (const specifier of SPECIFIERS) {
    try { facts.resolve[specifier] = import.meta.resolve(specifier) } catch (error) { facts.resolve[specifier] = errorFacts(error) }
    try {
      modules[specifier] = await import(specifier)
      facts.import[specifier] = { ok: true, exports: Object.keys(modules[specifier]).slice(0, 6) }
    } catch (error) {
      facts.import[specifier] = errorFacts(error)
    }
  }

  // Class and service identity against the running host.
  const cordis = modules['@deepseek-ai/cordis']
  const query = modules['@deepseek-ai/dsh-session-query']
  const engine = modules[ENGINE]
  facts.identity.ctxInstanceOfImportedContext = cordis ? ctx instanceof cordis.Context : null
  facts.identity.importedContextIsHostContext = cordis ? cordis.Context.is(ctx) : null
  facts.identity.engineDefaultName = engine?.default?.name ?? null
  facts.identity.engineExtendsImportedSessionQueryEngine = engine && query ? engine.default.prototype instanceof query.default : null
  facts.identity.engineHasConfigSchema = typeof engine?.default?.Config === 'function'
  facts.identity.engineInject = engine?.default?.inject ?? null
  const cosmokit = modules['@deepseek-ai/cosmokit']
  facts.identity.cosmokitResolvedUnderRepo = typeof facts.resolve['@deepseek-ai/cosmokit'] === 'string'
    && !facts.resolve['@deepseek-ai/cosmokit'].includes('app.asar')
  facts.identity.cosmokitLoaded = Boolean(cosmokit)

  // Host version sources.
  const packages = ctx.get('pluginPackages')
  const entries = packages?.resolution?.entries ?? []
  const entryVersion = name => entries.find(entry => entry.name === name)?.version ?? null
  facts.version.resolutionEntries = entries.length
  facts.version.dsh = entryVersion('@deepseek-ai/dsh')
  facts.version.appBoot = entryVersion('@deepseek-ai/dsh-app-boot')
  facts.version.engine = entryVersion(ENGINE)
  facts.version.engineScope = entries.find(entry => entry.name === ENGINE)?.scope ?? null
  facts.version.sessionQuery = entryVersion('@deepseek-ai/dsh-session-query')
  try { facts.version.packageOfEngine = packages?.packageOf(ENGINE, import.meta.url)?.version ?? null } catch (error) { facts.version.packageOfEngine = errorFacts(error) }
  const profile = ctx.get('profileContext')
  facts.version.profileName = profile?.name ?? null
  facts.version.installAnchor = profile?.installAnchor ?? null
  try { facts.version.installAnchorVersion = JSON.parse(readFileSync(profile.installAnchor, 'utf8')).version } catch (error) { facts.version.installAnchorVersion = errorFacts(error) }
  facts.version.DSH_CLIENT_VERSION = process.env.DSH_CLIENT_VERSION ?? null
  facts.version.electron = process.versions.electron ?? null
  facts.version.node = process.versions.node

  // Can plugin code read the shipped engine's src inside app.asar?
  const engineUrl = facts.resolve[ENGINE]
  const engineDir = typeof engineUrl === 'string' ? packageDirOf(engineUrl, ENGINE) : undefined
  facts.asar.engineDir = engineDir ?? null
  if (engineDir) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(engineDir, 'package.json'), 'utf8'))
      facts.asar.manifestVersion = manifest.version
      for (const file of ['src/index.ts', 'src/query.ts', 'src/schema.ts', 'lib/index.js']) {
        const text = readFileSync(path.join(engineDir, file), 'utf8')
        facts.asar[file] = { bytes: Buffer.byteLength(text), sha256: sha256(text) }
      }
    } catch (error) {
      facts.asar.error = errorFacts(error)
    }
  }
  try { facts.asar.srcExportResolve = import.meta.resolve(`${ENGINE}/src/index.ts`) } catch (error) { facts.asar.srcExportResolve = errorFacts(error) }

  // Which sessionQuery scope is this row in?
  facts.isolate.sessionQuery = ctx[ISOLATE]?.sessionQuery?.description ?? null
  facts.isolate.rowId = rowId ?? null
  facts.isolate.parentRowId = ctx[ENTRY]?.parent?.ctx?.fiber?.entry?.options?.id ?? null

  for (const key of ['DSH_HOME', 'HOME', 'DSH_AGENTS_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TMPDIR', 'DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_TELEMETRY_DISABLED']) {
    facts.env[key] = process.env[key] ?? null
  }
  facts.env.cwd = process.cwd()

  const mode = process.env.SPIKE_PROBE_MODE ?? 'patched'
  report({ event: 'probe-apply', rowId, mode, config, facts })
  ctx.effect(() => () => report({ event: 'probe-dispose', rowId, mode }), 'spike probe report')

  const Shipped = engine?.default
  if (mode === 'none' || typeof Shipped !== 'function') return
  let Engine = Shipped
  if (mode === 'patched') {
    Engine = class PatchedProbeEngine extends Shipped {}
  } else if (mode === 'broken') {
    try {
      await import('./missing-patched-engine.js')
    } catch (error) {
      report({ event: 'probe-fallback', rowId, reason: errorFacts(error) })
    }
  }
  const fiber = ctx.plugin(Engine, config)
  fiber.then?.(() => report({ event: 'probe-engine-settled', rowId, engine: Engine.name, state: fiber.state }),
    error => report({ event: 'probe-engine-failed', rowId, engine: Engine.name, error: errorFacts(error) }))
}
