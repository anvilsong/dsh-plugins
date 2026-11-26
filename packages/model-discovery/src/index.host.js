import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  catalogProtocols,
  clean,
  latestCatalogUrl,
  mapCatalog,
  mergeAllowedModels,
  mergeConfig,
  planProvider,
  planSeed,
  providerCatalogUrl,
  readServed,
  resolveSettings,
  seedPrecheck,
  statusText,
} from './discovery.js'
import { localSnapshot, modelsUrl, normalizePin, planLocalRoute, planSignature, splitLocalRoutes } from './local-discovery.js'

export const name = 'model-discovery'
export const inject = []

const LLM_ENTRY = '@deepseek-ai/dsh-llm-pi-ai'
/** The profile whose patch file is copied before a seed (the desktop and web profiles use separate patches). */
const PROFILE = 'web'
const SETTINGS_ENTRY = '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
const USAGE = 'Usage: /model-discovery sync|status|seed <provider> [<api>] [confirm]|local <provider> [confirm]'
const HINT = 'sync|status|seed <provider> [<api>] [confirm]'
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/
/** Left-out ids named in one seed reply or receipt; the rest are counted. */
const MAX_LEFT_OUT = 200
/** Largest npm or unpkg response body accepted, in bytes. */
export const MAX_BODY_BYTES = 1_000_000
const MAX_LISTED = 50
const MAX_STATUS_ITEMS = 200
const MAX_STATUS_STRING = 2000

/** Thrown from an edit callback when nothing is left to add, so the editor writes nothing. */
class NothingToWrite extends Error {
  constructor() {
    super('nothing to write')
    this.name = 'NothingToWrite'
  }
}

/** A seed refusal whose message is complete advice and is shown whole (describe() would cut it). */
class SeedRefusal extends Error {
  constructor(message) {
    super(message)
    this.name = 'SeedRefusal'
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function describe(error) {
  try {
    let text = error instanceof Error ? String(error.message) : String(error)
    const cause = error instanceof Error && error.cause instanceof Error ? String(error.cause.message) : ''
    if (cause.length > 0 && !text.includes(cause)) text = `${text} (${cause})`
    return clean(text, 240)
  } catch {
    return 'an unreadable error'
  }
}

async function readCapped(body, max) {
  if (body === null || body === undefined) return new Uint8Array(0)
  const reader = body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw new Error('response exceeds 1 MB')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/**
 * GET one JSON document: redirects are refused, the body is read as a stream
 * and abandoned past MAX_BODY_BYTES, and the whole request is bounded by
 * timeoutMs.
 */
export async function fetchJson(url, timeoutMs, fetchImpl = globalThis.fetch) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs} ms`)), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const declared = Number(response.headers?.get?.('content-length') ?? Number.NaN)
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('response exceeds 1 MB')
    const bytes = await readCapped(response.body, MAX_BODY_BYTES)
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } finally {
    clearTimeout(timer)
    // Releases the connection when the body was not read to its end.
    controller.abort()
  }
}

function metadataVersion(metadata) {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined
  const version = metadata.version
  return typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) ? version : undefined
}

function listedIds(providerConfig) {
  if (!isRecord(providerConfig) || !Array.isArray(providerConfig.models)) return new Set()
  return new Set(providerConfig.models.map((model) => (isRecord(model) ? model.id : undefined)))
}

/**
 * Choose the dsh-llm-pi-ai row to edit: the one row that already configures
 * the provider. With a single row the caller reports a missing provider; with
 * several rows the choice must be unambiguous.
 */
export function pickLlmEntry(entries, provider) {
  const rows = entries.filter((candidate) => candidate.options?.name === LLM_ENTRY)
  if (rows.length === 0) return { error: `${LLM_ENTRY} is not editable in this profile` }
  const owners = rows.filter((row) => {
    const providers = row.options?.config?.providers
    return isRecord(providers) && Object.hasOwn(providers, provider)
  })
  const ids = (list) => list.map((row) => row.options?.id ?? '?').join(', ')
  if (owners.length === 1) return { entry: owners[0] }
  if (owners.length > 1) return { error: `provider ${provider} is configured in several llm-pi-ai rows (${ids(owners)}); nothing was changed` }
  if (rows.length > 1) return { error: `provider ${provider} is not configured in any of the llm-pi-ai rows (${ids(rows)})` }
  return { entry: rows[0] }
}

function listText(items) {
  if (items.length <= MAX_LISTED) return items.join(', ')
  return `${items.slice(0, MAX_LISTED).join(', ')} and ${items.length - MAX_LISTED} more`
}

function joinedText(items) {
  if (items.length <= MAX_LISTED) return items.join(' | ')
  return `${items.slice(0, MAX_LISTED).join(' | ')} | and ${items.length - MAX_LISTED} more`
}

function statusValue(value) {
  if (typeof value === 'string') return clean(value, MAX_STATUS_STRING)
  if (Array.isArray(value)) return value.slice(0, MAX_STATUS_ITEMS).map(statusValue)
  if (value === undefined) return null
  return value
}

/** Reject after `ms` and clear the timer whichever way the promise settles. */
function withTimeout(promise, ms, message) {
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`

/** At most `cap` left-out lines, then one "and N more" line; cap < MAX_LEFT_OUT keeps the total within MAX_LEFT_OUT. */
function leftOutLines(plan, cap = MAX_LEFT_OUT) {
  const lines = plan.leftOut.slice(0, cap).map((entry) => `${entry.id}: ${entry.reason}`)
  if (plan.leftOut.length > cap) lines.push(`and ${plan.leftOut.length - cap} more left out`)
  return lines
}

function leftOutBlock(plan) {
  if (plan.leftOut.length === 0) return 'Left out: none.'
  return [`Left out (${plan.leftOut.length}), not listed:`, ...leftOutLines(plan).map((line) => `  ${line}`)].join('\n')
}

function apiLine(plan) {
  if (plan.api !== null) return `Route api: ${clean(plan.api, 40)} will be set.`
  if (plan.routeApi !== undefined) return `Route api: no api is added (the route already sets ${clean(plan.routeApi, 80)}).`
  return 'Route api: no api is added.'
}

function undoText(provider, rowId, plan) {
  return `remove \`models\`${plan.api === null ? '' : ' and `api`'} from providers.${provider} in the ${LLM_ENTRY} row ${rowId}, or restore your backup of the profile patch`
}

/**
 * Channel aliases (ids starting with ~) are the ids pi-ai has moved between
 * protocols across versions. The plugin cannot read DSH's bundled catalog, so
 * it only counts them when the seed filters by protocol and says to check.
 */
function aliasNote(plan) {
  if (!plan.filtered) return []
  const listed = plan.ids.filter((id) => id.startsWith('~')).length
  const left = plan.leftOut.filter((entry) => entry.id.startsWith('~')).length
  if (listed + left === 0) return []
  return [`Note: ids starting with ~ are channel aliases (${listed} listed, ${left} left out). pi-ai has moved aliases between protocols across versions and DSH keeps the endpoint of its own bundled catalog for a model it knows, so check them after the seed.`]
}

function previewText(provider, api, rowId, plan) {
  const protocols = plan.protocolCounts.map((entry) => `${clean(entry.api, 40)} (${entry.count})`)
  if (plan.unknown > 0) protocols.push(`not a chat model in the catalog (${plan.unknown})`)
  return [
    `Seed preview for ${provider}: nothing was written.`,
    `llm-pi-ai row: ${rowId}. Latest pi-ai: ${plan.version}.`,
    `DSH serves ${plural(plan.served, 'model id')} for ${provider}. Protocols in the latest catalog: ${protocols.length > 0 ? protocols.join(', ') : 'none'}.`,
    apiLine(plan),
    `To list: ${plural(plan.ids.length, 'id')} as id-only entries, in the order DSH serves them.`,
    leftOutBlock(plan),
    ...aliasNote(plan),
    `To write this exact plan, run: /model-discovery seed ${provider}${api === undefined ? '' : ` ${api}`} confirm`,
  ].join('\n')
}

/**
 * Copy the profile patch beside itself before a seed rewrites the llm-pi-ai
 * block through configEditor (which drops comments inside that block). The copy
 * is a real file next to the original, so the user can restore it by hand. A
 * failure is reported, never fatal: it must not change what the seed does.
 * @returns `{ file }` (a $DSH_HOME-relative label) or `{ error }` with a code.
 */
async function backupProfile(home) {
  if (home === undefined) return { error: 'the plugin knows no DSH home folder' }
  const source = join(home, 'profiles', PROFILE, 'cordis.patch.yml')
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')
  const target = `${source}.bak-model-discovery-${stamp}`
  try {
    await copyFile(source, target)
  } catch (error) {
    const code = typeof error?.code === 'string' ? clean(error.code, 40) : 'copy error'
    return { error: code }
  }
  return { file: `$DSH_HOME/profiles/${PROFILE}/cordis.patch.yml.bak-model-discovery-${stamp}` }
}

async function writeStatus(file, status) {
  const text = `${JSON.stringify(Object.fromEntries(Object.entries(status).map(([key, value]) => [key, statusValue(value)])), null, 2)}\n`
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  await rm(temporary, { force: true })
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

export async function apply(ctx, config = {}, host = {}) {
  const logger = ctx.logger
  const baseResolution = resolveSettings(config)
  const split = splitLocalRoutes({ providers: config?.providers ?? ['openai-codex'], localRoutes: config?.localRoutes })
  const resolution = baseResolution.error !== undefined
    ? baseResolution
    : split.error !== undefined
      ? { error: split.error }
      : { settings: Object.freeze({
        ...baseResolution.settings,
        providers: split.settings.providers,
        localRoutes: Object.freeze(Object.fromEntries(Object.entries(split.settings.localRoutes).map(([id, route]) => [id, Object.freeze({ baseURL: normalizePin(route.baseURL).pin, mode: route.mode })]))),
      }) }
  const getJson = host.getJson ?? ((url, timeoutMs) => fetchJson(url, timeoutMs, host.fetch))
  const now = host.now ?? (() => Date.now())
  const home = (() => {
    try {
      const value = ctx.get?.('profileContext')?.home
      return typeof value === 'string' && value.length > 0 ? value : undefined
    } catch {
      return undefined
    }
  })()
  const statusFile = host.statusFile ?? (home === undefined ? undefined : `${home}/model-discovery/status.json`)
  const state = {
    running: false,
    versions: Object.create(null),
    // provider -> model ids this plugin added in this process whose subagent
    // routes are not written yet. Lost on restart by design.
    pending: new Map(),
    // provider + api -> signature of the plan a seed preview showed. A confirm
    // consumes it. Lost on restart by design.
    previews: new Map(),
    // provider -> signature of the reconciliation preview a `/model-discovery local`
    // showed. A confirm consumes it. Lost on restart by design.
    localPreviews: new Map(),
    lastLocal: Object.create(null),
    lastVersion: undefined,
    lastFinishedAt: undefined,
    nextCheckAt: undefined,
    lastAddedModels: [],
    lastAddedRoutes: [],
    lastSkipped: [],
    lastError: undefined,
    lastResult: undefined,
  }
  const pendingList = () => [...state.pending].flatMap(([provider, ids]) => [...ids].map((id) => `${provider}/${id}`))

  const getEditor = () => {
    const editor = ctx.get?.('configEditor')
    if (editor === undefined) throw new Error('configEditor is unavailable')
    return editor
  }

  const runSync = async (settings, force) => {
    const modelsAdded = []
    const routesAdded = []
    const skipped = []
    const errors = []

    const syncCatalog = async (provider, version) => {
      const raw = await getJson(providerCatalogUrl(version, provider), settings.timeoutMs)
      const catalog = mapCatalog(raw, provider)
      skipped.push(...catalog.issues.map((issue) => `${issue.id}: ${issue.reason}`))
      if (catalog.models.length === 0 && catalog.issues.length > 0) {
        throw new Error(`the upstream catalog has no usable model (${catalog.issues[0].reason})`)
      }
      const editor = getEditor()
      const pick = pickLlmEntry(editor.entries(), provider)
      if (pick.error !== undefined) throw new Error(pick.error)
      const plan = planProvider(pick.entry.options?.config?.providers, provider, catalog)
      if (plan.error !== undefined) throw new Error(plan.error)
      skipped.push(...plan.skipped)
      let deferred = plan.deferred
      if (plan.added.length > 0) {
        let committed
        try {
          await editor.edit(pick.entry, (current) => {
            // Re-plan from the config the editor holds now, so a concurrent
            // writer's entries are kept and never duplicated.
            const latest = planProvider(current?.providers, provider, catalog)
            if (latest.error !== undefined) throw new Error(latest.error)
            if (latest.added.length === 0) throw new NothingToWrite()
            committed = latest
            return mergeConfig(current, provider, latest.provider)
          })
        } catch (error) {
          if (!(error instanceof NothingToWrite)) throw error
          committed = undefined
          deferred = 0
        }
        if (committed !== undefined) {
          deferred = committed.deferred
          modelsAdded.push(...committed.added.map((id) => `${provider}/${id}`))
          if (settings.syncAllowedModels) {
            const ids = state.pending.get(provider) ?? new Set()
            for (const id of committed.added) ids.add(id)
            state.pending.set(provider, ids)
          }
        }
      }
      if (deferred === 0) state.versions[provider] = version
    }

    // Subagent routes only for models this plugin added in this process; a
    // failed route edit keeps them pending for the next sync.
    const syncRoutes = async (provider) => {
      const ids = state.pending.get(provider)
      const editor = getEditor()
      const entries = editor.entries()
      const pick = pickLlmEntry(entries, provider)
      if (pick.error !== undefined) throw new Error(pick.error)
      const listed = listedIds(pick.entry.options?.config?.providers?.[provider])
      for (const id of [...ids]) {
        if (listed.has(id)) continue
        ids.delete(id)
        skipped.push(`${provider}/${id}: no longer listed, so no subagent route is added`)
      }
      if (ids.size === 0) {
        state.pending.delete(provider)
        return
      }
      const settingsEntry = entries.find((candidate) => candidate.options?.name === SETTINGS_ENTRY)
      if (settingsEntry === undefined) throw new Error('subagent-model-selection-settings is not editable in this profile')
      const wanted = [...ids]
      let committed
      try {
        await editor.edit(settingsEntry, (current) => {
          const merge = mergeAllowedModels(current?.allowedModels, provider, wanted)
          if (merge.error !== undefined) throw new Error(merge.error)
          if (merge.added.length === 0) throw new NothingToWrite()
          committed = merge
          return { ...current, allowedModels: merge.allowedModels }
        })
      } catch (error) {
        if (!(error instanceof NothingToWrite)) throw error
      }
      for (const id of wanted) ids.delete(id)
      if (ids.size === 0) state.pending.delete(provider)
      if (committed !== undefined) routesAdded.push(...committed.added.map((model) => `${provider}/${model}`))
    }

    let version
    try {
      const metadata = await getJson(latestCatalogUrl(), settings.timeoutMs)
      version = metadataVersion(metadata)
      if (version === undefined) throw new Error('the npm latest response has no valid version')
      state.lastVersion = version
    } catch (error) {
      errors.push(describe(error))
    }
    for (const provider of settings.providers) {
      if (version !== undefined) {
        if (!force && state.versions[provider] === version) {
          skipped.push(`${provider}: already checked at pi-ai ${version}`)
        } else {
          try {
            await syncCatalog(provider, version)
          } catch (error) {
            errors.push(`${provider}: ${describe(error)}`)
          }
        }
      }
    }
    if (settings.syncAllowedModels) {
      for (const provider of [...state.pending.keys()]) {
        try {
          await syncRoutes(provider)
        } catch (error) {
          errors.push(`${provider} subagent routes: ${describe(error)}`)
        }
      }
    }

    state.lastAddedModels = modelsAdded
    state.lastAddedRoutes = routesAdded
    state.lastSkipped = skipped
    state.lastError = errors.length > 0 ? errors.join(' | ') : undefined
    state.lastFinishedAt = now()
    const pieces = [`Model discovery checked pi-ai ${state.lastVersion ?? '(unknown version)'}.`]
    pieces.push(modelsAdded.length > 0 ? `Models added: ${listText(modelsAdded)}.` : 'Models added: none.')
    if (settings.syncAllowedModels) {
      pieces.push(routesAdded.length > 0 ? `Subagent routes added: ${listText(routesAdded)}.` : 'Subagent routes added: none.')
    }
    if (skipped.length > 0) pieces.push(`Skipped: ${joinedText(skipped)}.`)
    if (errors.length > 0) pieces.push(`Errors: ${joinedText(errors)}`)
    state.lastResult = pieces.join('\n')
    if (statusFile !== undefined) {
      try {
        await writeStatus(statusFile, {
          version: state.lastVersion,
          modelsAdded,
          routesAdded,
          pendingRoutes: pendingList(),
          skipped,
          error: state.lastError,
          result: state.lastResult,
          finishedAt: state.lastFinishedAt,
        })
      } catch { /* status is diagnostic only; never fail a sync over it */ }
    }
    if (errors.length > 0) {
      try { logger?.warn?.(`model-discovery: ${errors.join(' | ')}`) } catch { /* no logger */ }
    }
    return { kind: errors.length > 0 ? 'error' : 'success', text: state.lastResult }
  }

  const sync = async (force = false) => {
    if (state.running) return { kind: 'error', text: 'Model discovery is already syncing.' }
    if (resolution.error !== undefined) return { kind: 'error', text: `Model discovery is disabled by its config: ${resolution.error}` }
    state.running = true
    try {
      return await runSync(resolution.settings, force)
    } finally {
      state.running = false
    }
  }

  /**
   * Read DSH's served ids and the latest catalog, and plan the seed of one
   * provider. Every failure is thrown as an Error and reported by the caller.
   */
  const planFor = async (settings, provider, api) => {
    const editor = getEditor()
    const pick = pickLlmEntry(editor.entries(), provider)
    if (pick.error !== undefined) throw new SeedRefusal(pick.error)
    const checked = seedPrecheck(pick.entry.options?.config?.providers, provider, api)
    if (checked.error !== undefined) throw new SeedRefusal(checked.error)
    const llm = ctx.get?.('llm')
    if (typeof llm?.listModels !== 'function') throw new Error('the llm service is unavailable, so the served models cannot be listed')
    const list = await withTimeout(
      Promise.resolve().then(() => llm.listModels(provider)),
      settings.timeoutMs,
      `llm.listModels did not answer within ${settings.timeoutMs} ms`,
    )
    const served = readServed(list, provider)
    if (served.error !== undefined) throw new Error(served.error)
    const metadata = await getJson(latestCatalogUrl(), settings.timeoutMs)
    const version = metadataVersion(metadata)
    if (version === undefined) throw new Error('the npm latest response has no valid version')
    const raw = await getJson(providerCatalogUrl(version, provider), settings.timeoutMs)
    const catalog = catalogProtocols(raw, provider)
    if (catalog.error !== undefined) throw new Error(catalog.error)
    const plan = planSeed(pick.entry.options?.config?.providers, provider, api, served.ids, catalog.protocols, version, catalog.unusable)
    if (plan.error !== undefined) throw new SeedRefusal(plan.error)
    return { editor, entry: pick.entry, rowId: String(pick.entry.options?.id ?? '?'), plan, served: served.ids, protocols: catalog.protocols, unusable: catalog.unusable, version }
  }

  const runSeed = async (settings, { provider, api, confirm }) => {
    const key = `${provider}\0${api ?? ''}`
    const command = `/model-discovery seed ${provider}${api === undefined ? '' : ` ${api}`}`
    const previewed = state.previews.get(key)
    // A preview is used once, and a new preview replaces an older one.
    state.previews.delete(key)
    if (confirm && previewed === undefined) {
      return { kind: 'error', text: `There is no preview of ${command} in this process. Run ${command}, read the plan, then add confirm.` }
    }
    try {
      const planned = await planFor(settings, provider, api)
      const { plan, rowId } = planned
      const signature = JSON.stringify({ row: rowId, plan: plan.signature })
      if (!confirm) {
        state.previews.set(key, signature)
        return { kind: 'success', text: previewText(provider, api, rowId, plan) }
      }
      if (signature !== previewed) {
        return { kind: 'error', text: `The plan now differs from the preview (the served models, the catalog or the config changed); nothing was written. Run ${command} again.` }
      }
      const backup = await backupProfile(home)
      await planned.editor.edit(planned.entry, (current) => {
        // Re-plan from the config the editor holds now: another writer's
        // models, api or modelOverrides must make the seed give up, not merge.
        const latest = planSeed(current?.providers, provider, api, planned.served, planned.protocols, planned.version, planned.unusable)
        if (latest.error !== undefined) throw new Error(latest.error)
        if (latest.signature !== plan.signature) throw new Error('the plan differs from the preview when the edit ran; nothing was written')
        return mergeConfig(current, provider, latest.provider)
      })
      const undo = undoText(provider, rowId, plan)
      const receiptFile = statusFile === undefined ? undefined : join(dirname(statusFile), `seed-${provider}.json`)
      let receipt
      if (receiptFile === undefined) {
        receipt = 'The receipt was not written: the plugin knows no profile folder. The seed itself is done.'
      } else {
        try {
          await writeStatus(receiptFile, {
            provider,
            row: rowId,
            version: plan.version,
            apiAdded: plan.api,
            listedCount: plan.ids.length,
            leftOutCount: plan.leftOut.length,
            leftOut: leftOutLines(plan, plan.leftOut.length > MAX_LEFT_OUT ? MAX_LEFT_OUT - 1 : MAX_LEFT_OUT),
            undo,
            seededAt: now(),
          })
          receipt = `Receipt: $DSH_HOME/model-discovery/seed-${provider}.json`
        } catch (error) {
          // Never echo the error text: it can carry the absolute or temporary path.
          const code = typeof error?.code === 'string' ? clean(error.code, 40) : 'write error'
          receipt = `The receipt $DSH_HOME/model-discovery/seed-${provider}.json could not be written (${code}); the seed itself was kept.`
        }
      }
      return {
        kind: 'success',
        text: [
          `Seeded ${provider} in llm-pi-ai row ${rowId} (latest pi-ai ${plan.version}): wrote ${plural(plan.ids.length, 'id')} as id-only entries${plan.api === null ? ' and no api' : ` and api ${clean(plan.api, 40)}`}.`,
          leftOutBlock(plan),
          `Undo: ${undo}.`,
          `Next: add ${provider} to the plugin's \`providers\` setting, then run /model-discovery sync so that new upstream models are appended.`,
          receipt,
          backup.file === undefined
            ? `Backup: none could be taken (${backup.error}); the edit still went ahead.`
            : `Backup of the profile patch: ${backup.file}`,
        ].join('\n'),
      }
    } catch (error) {
      const reason = error instanceof SeedRefusal ? clean(error.message, 1000) : describe(error)
      return { kind: 'error', text: `Seed of ${provider} failed; nothing was written: ${reason}` }
    }
  }

  /**
   * One local route: read the server, plan, and (only on a confirmed command) write the
   * models list. A manual command never touches another route; automatic polls never remove.
   */
  const planLocal = async (settings, provider) => {
    const pinned = settings.localRoutes?.[provider]
    if (pinned === undefined) throw new SeedRefusal(`provider ${provider} is not a local route in this plugin's config; add it under localRoutes (see README)`)
    const editor = getEditor()
    const pick = pickLlmEntry(editor.entries(), provider)
    if (pick.error !== undefined) throw new SeedRefusal(pick.error)
    const before = pick.entry.options?.config?.providers?.[provider]
    const response = await getJson(modelsUrl(pinned.baseURL), settings.timeoutMs)
    const snapshot = localSnapshot(response, provider)
    if (snapshot.error !== undefined) throw new Error(snapshot.error)
    const plan = planLocalRoute({ provider, pin: pinned.baseURL, mode: pinned.mode, route: before, models: snapshot.models })
    if (plan.error !== undefined) throw new SeedRefusal(plan.error)
    return { editor, entry: pick.entry, rowId: String(pick.entry.options?.id ?? '?'), before, plan, pin: pinned.baseURL, mode: pinned.mode }
  }

  const localPreviewText = (planned) => {
    const { plan, rowId, pin, mode } = planned
    const lines = [`Local route preview for ${plan.provider}: nothing was written.`, `llm-pi-ai row: ${rowId}. Endpoint: ${clean(pin, 120)}. Mode: ${mode}.`]
    lines.push(plan.added.length > 0 ? `Add (${plan.added.length}): ${listText(plan.added)}.` : 'Add: none.')
    lines.push(plan.contextChanges.length > 0
      ? `Context (${plan.contextChanges.length}): ${listText(plan.contextChanges.map((change) => `${change.id} ${change.from} => ${change.to}`))}.`
      : 'Context: unchanged.')
    lines.push(plan.maxTokensChanges.length > 0
      ? `maxTokens (${plan.maxTokensChanges.length}): ${listText(plan.maxTokensChanges.map((change) => `${change.id} ${change.from ?? 'none'} => ${change.to}`))}.`
      : 'maxTokens: unchanged (the server states no --n-predict, so a cap you set stays).')
    if (mode === 'manual') lines.push(plan.removed.length > 0 ? `Remove (${plan.removed.length}): ${listText(plan.removed)}.` : 'Remove: none.')
    else lines.push(plan.pendingRemovals.length > 0 ? `Not on the server, kept (${plan.pendingRemovals.length}): ${listText(plan.pendingRemovals)}. An automatic route never removes; run /model-discovery local ${plan.provider} on a manual route to review a removal.` : 'Not on the server: none.')
    if (plan.warnings.length > 0) lines.push(`Notes: ${joinedText(plan.warnings.map((warning) => clean(warning, 160)))}.`)
    lines.push('Every other field of a kept model is preserved. The edit rewrites the whole llm-pi-ai block of the profile patch and drops comments inside it; a backup is taken first.')
    lines.push(`To write this exact plan, run: /model-discovery local ${plan.provider} confirm`)
    return lines.join('\n')
  }

  const runLocal = async (settings, { provider, confirm }) => {
    const command = `/model-discovery local ${provider}`
    const previewed = state.localPreviews.get(provider)
    state.localPreviews.delete(provider)
    if (confirm && previewed === undefined) {
      return { kind: 'error', text: `There is no preview of ${command} in this process. Run ${command}, read the plan, then add confirm.` }
    }
    try {
      const planned = await planLocal(settings, provider)
      const signature = JSON.stringify({ row: planned.rowId, pin: planned.pin, mode: planned.mode, plan: planSignature(planned.plan, planned.before) })
      if (!confirm) {
        state.localPreviews.set(provider, signature)
        state.lastLocal[provider] = { mode: planned.mode, outcome: 'preview', at: now() }
        return { kind: 'success', text: localPreviewText(planned) }
      }
      if (signature !== previewed) {
        return { kind: 'error', text: `The plan now differs from the preview (the server, the config or the mode changed); nothing was written. Run ${command} again.` }
      }
      const backup = await backupProfile(home)
      await planned.editor.edit(planned.entry, (current) => {
        const now = current?.providers?.[provider]
        const again = planLocalRoute({ provider, pin: planned.pin, mode: planned.mode, route: now, models: planned.plan.route.models })
        if (again.error !== undefined) throw new Error(again.error)
        if (planSignature(again, now) !== planSignature(planned.plan, planned.before)) {
          throw new Error('the plan differs from the preview when the edit ran; nothing was written')
        }
        if (!again.changed) throw new NothingToWrite()
        return mergeConfig(current, provider, again.route)
      })
      state.lastLocal[provider] = { mode: planned.mode, outcome: 'written', at: now() }
      const pieces = [`Local route ${provider} updated in llm-pi-ai row ${planned.rowId}: ${plural(planned.plan.route.models.length, 'id')} listed.`]
      if (planned.plan.added.length > 0) pieces.push(`Added: ${listText(planned.plan.added)}.`)
      if (planned.plan.contextChanges.length > 0) pieces.push(`Context: ${listText(planned.plan.contextChanges.map((change) => `${change.id} ${change.from} => ${change.to}`))}.`)
      if (planned.plan.maxTokensChanges.length > 0) pieces.push(`maxTokens: ${listText(planned.plan.maxTokensChanges.map((change) => `${change.id} => ${change.to}`))}.`)
      if (planned.plan.removed.length > 0) pieces.push(`Removed: ${listText(planned.plan.removed)}.`)
      pieces.push(backup.file === undefined ? `Backup: none could be taken (${backup.error}); the edit still went ahead.` : `Backup of the profile patch: ${backup.file}`)
      if (planned.mode === 'auto') pieces.push(`Next: the automatic check every ${Math.round(settings.refreshMs / 60_000)} minutes keeps this route current (adds and context only; it never removes).`)
      else pieces.push(`Next: run ${command} again after the server changes; a manual route is never changed by the timer.`)
      return { kind: 'success', text: pieces.join('\n') }
    } catch (error) {
      if (error instanceof NothingToWrite) return { kind: 'success', text: `Local route ${provider} is already in sync; nothing was written.` }
      const reason = error instanceof SeedRefusal ? clean(error.message, 1000) : describe(error)
      state.lastLocal[provider] = { mode: resolution.settings?.localRoutes?.[provider]?.mode ?? '?', outcome: `error: ${reason}`, at: now() }
      return { kind: 'error', text: `Local sync of ${provider} failed; nothing was written: ${reason}` }
    }
  }

  const local = async (words) => {
    const rest = [...words]
    const confirm = rest.at(-1) === 'confirm'
    if (confirm) rest.pop()
    const [provider] = rest
    if (rest.length !== 1 || !PROVIDER_ID.test(provider)) return { kind: 'error', text: USAGE }
    if (resolution.error !== undefined) return { kind: 'error', text: `Model discovery is disabled by its config: ${resolution.error}` }
    if (state.running) return { kind: 'error', text: 'Model discovery is already running a sync, a seed or a local sync.' }
    state.running = true
    try {
      return await runLocal(resolution.settings, { provider, confirm })
    } finally {
      state.running = false
    }
  }

  const seed = async (words) => {
    const rest = [...words]
    const confirm = rest.at(-1) === 'confirm'
    if (confirm) rest.pop()
    const [provider, api] = rest
    if (rest.length < 1 || rest.length > 2 || !PROVIDER_ID.test(provider) || (api !== undefined && !PROVIDER_ID.test(api))) {
      return { kind: 'error', text: USAGE }
    }
    if (resolution.error !== undefined) return { kind: 'error', text: `Model discovery is disabled by its config: ${resolution.error}` }
    if (state.running) return { kind: 'error', text: 'Model discovery is already running a sync or a seed.' }
    state.running = true
    try {
      return await runSeed(resolution.settings, { provider, api, confirm })
    } finally {
      state.running = false
    }
  }

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: 'dsh-plugin-model-discovery',
      name: 'model-discovery',
      description: 'Append missing pi-ai catalog models to providers that list their models explicitly',
      input: { hint: HINT },
      handler: async ({ rawInput }) => {
        const arg = rawInput.trim().toLowerCase()
        if (arg === 'sync') return sync(true)
        if (arg === 'status') {
          if (resolution.error !== undefined) return { kind: 'error', text: `Model discovery is disabled by its config: ${resolution.error}` }
          return { kind: 'success', text: statusText(resolution.settings, { ...state, pendingRoutes: pendingList() }) }
        }
        const words = arg.split(/\s+/)
        if (words[0] === 'seed') return seed(words.slice(1))
        if (words[0] === 'local') return local(words.slice(1))
        return { kind: 'error', text: USAGE }
      },
    })
  })

  if (resolution.error !== undefined) {
    try { logger?.error?.(`model-discovery: ${resolution.error}`) } catch { /* no logger */ }
    return
  }
  if (resolution.settings.enabled) {
    const refreshMs = resolution.settings.refreshMs
    const fire = () => {
      try {
        const hmr = ctx.get?.('hmr')
        const run = async () => {
          await sync(false)
          // Automatic local routes: read the server and write adds and context only.
          for (const [provider, route] of Object.entries(resolution.settings?.localRoutes ?? {})) {
            if (route.mode !== 'auto') continue
            if (state.running) continue
            state.running = true
            try {
              // A timer run previews and then confirms the same read, so the write always
              // equals the plan just computed; it never removes (auto mode keeps absent ids).
              const preview = await runLocal(resolution.settings, { provider, confirm: false })
              if (preview.kind === 'success') await runLocal(resolution.settings, { provider, confirm: true })
            } catch (error) {
              state.lastLocal[provider] = { mode: 'auto', outcome: `error: ${describe(error)}`, at: now() }
            } finally {
              state.running = false
            }
          }
        }
        // HMR serializes reloads in an AsyncLocalStorage transaction, and
        // timers created during activation inherit it. Leave that zone so
        // configEditor can open its own write transaction.
        const result = typeof hmr?.executing?.exit === 'function' ? hmr.executing.exit(run) : run()
        void Promise.resolve(result).catch((error) => {
          try { logger?.warn?.(`model-discovery: ${describe(error)}`) } catch { /* no logger */ }
        })
      } catch (error) {
        try { logger?.warn?.(`model-discovery: ${describe(error)}`) } catch { /* no logger */ }
      }
    }
    ctx.inject(['configEditor'], (editorCtx) => {
      state.nextCheckAt = now() + refreshMs
      const timer = setInterval(() => {
        state.nextCheckAt = now() + refreshMs
        fire()
      }, refreshMs)
      timer.unref?.()
      const first = setTimeout(fire, 0)
      editorCtx.effect(() => () => {
        clearInterval(timer)
        clearTimeout(first)
        state.nextCheckAt = undefined
      })
    })
  }
}
