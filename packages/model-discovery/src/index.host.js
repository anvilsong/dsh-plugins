import {
  latestCatalogUrl,
  mapCatalog,
  mergeConfig,
  mergeProvider,
  providerCatalogUrl,
  resolveSettings,
  statusText,
} from './discovery.js'

export const name = 'model-discovery'
export const inject = []

const LLM_ENTRY = '@deepseek-ai/dsh-llm-pi-ai'
const USAGE = 'Usage: /model-discovery sync|status'

function describe(error) {
  try {
    const text = error instanceof Error ? String(error.message) : String(error)
    return text.length > 240 ? `${text.slice(0, 239)}…` : text
  } catch {
    return 'an unreadable error'
  }
}

async function defaultGetJson(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const text = await response.text()
    if (text.length > 1_000_000) throw new Error('catalog JSON exceeds 1 MB')
    return JSON.parse(text)
  } finally {
    clearTimeout(timer)
  }
}

function metadataVersion(metadata) {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined
  const version = metadata.version
  return typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) ? version : undefined
}

export async function apply(ctx, config = {}, host = {}) {
  const logger = ctx.logger
  const resolution = resolveSettings(config)
  const getJson = host.getJson ?? defaultGetJson
  const now = host.now ?? (() => Date.now())
  const state = {
    running: false,
    versions: Object.create(null),
    lastVersion: undefined,
    lastFinishedAt: undefined,
    nextCheckAt: undefined,
    lastAdded: [],
    lastSkipped: [],
    lastError: undefined,
    lastResult: undefined,
  }

  const sync = async (force = false) => {
    if (state.running) return { kind: 'error', text: 'Model discovery is already syncing.' }
    if (resolution.error !== undefined) return { kind: 'error', text: `Model discovery is disabled by its config: ${resolution.error}` }
    const settings = resolution.settings
    state.running = true
    state.lastAdded = []
    state.lastSkipped = []
    state.lastError = undefined
    const added = []
    const skipped = []
    const errors = []
    try {
      const metadata = await getJson(latestCatalogUrl(), settings.timeoutMs)
      const version = metadataVersion(metadata)
      if (version === undefined) throw new Error('the npm latest response has no valid version')
      state.lastVersion = version
      for (const provider of settings.providers) {
        if (!force && state.versions[provider] === version) {
          skipped.push(`${provider} (already at ${version})`)
          continue
        }
        try {
          const raw = await getJson(providerCatalogUrl(version, provider), settings.timeoutMs)
          const { models, issues } = mapCatalog(raw, provider)
          skipped.push(...issues.map((issue) => `${issue.id}: ${issue.reason}`))
          if (models.length === 0 && issues.length > 0) throw new Error(issues[0].reason)
          const editor = ctx.get?.('configEditor')
          if (editor === undefined) throw new Error('configEditor is unavailable')
          const entry = editor.entries().find((candidate) => candidate.options?.name === LLM_ENTRY)
          if (entry === undefined) throw new Error(`${LLM_ENTRY} is not editable in this profile`)
          const merge = mergeProvider(entry.options?.config?.providers?.[provider], models)
          if (merge.error !== undefined) throw new Error(merge.error)
          if (merge.added.length === 0) {
            state.versions[provider] = version
            continue
          }
          let latestMerge
          await editor.edit(entry, (current) => {
            latestMerge = mergeProvider(current.providers?.[provider], models)
            if (latestMerge.error !== undefined) throw new Error(latestMerge.error)
            return mergeConfig(current, provider, latestMerge.provider)
          })
          added.push(...latestMerge.added)
          state.versions[provider] = version
        } catch (error) {
          errors.push(`${provider}: ${describe(error)}`)
        }
      }
    } catch (error) {
      errors.push(describe(error))
    }
    state.lastAdded = [...new Set(added)]
    state.lastSkipped = skipped
    state.lastError = errors.length > 0 ? errors.join(' | ') : undefined
    state.lastFinishedAt = now()
    state.nextCheckAt = state.lastFinishedAt + resolution.settings.refreshMs
    const pieces = [`Model discovery checked pi-ai ${state.lastVersion ?? '(unknown version)'}.`]
    pieces.push(state.lastAdded.length > 0 ? `Added: ${state.lastAdded.join(', ')}.` : 'Added: nothing new.')
    if (skipped.length > 0) pieces.push(`Skipped: ${skipped.join(' | ')}.`)
    if (errors.length > 0) pieces.push(`Errors: ${errors.join(' | ')}`)
    state.lastResult = pieces.join('\n')
    if (errors.length > 0) {
      try { logger?.warn?.(`model-discovery: ${errors.join(' | ')}`) } catch { /* no logger */ }
    }
    state.running = false
    return { kind: errors.length > 0 && state.lastAdded.length === 0 ? 'error' : 'success', text: state.lastResult }
  }

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: 'dsh-plugin-model-discovery',
      name: 'model-discovery',
      description: 'Discover newly published pi-ai models and add only missing entries',
      input: { hint: 'sync|status' },
      handler: async ({ rawInput }) => {
        const arg = rawInput.trim().toLowerCase()
        if (arg === 'sync') return sync(true)
        if (arg === 'status') {
          if (resolution.error !== undefined) return { kind: 'error', text: `Model discovery is disabled by its config: ${resolution.error}` }
          return { kind: 'success', text: statusText(resolution.settings, state) }
        }
        return { kind: 'error', text: USAGE }
      },
    })
  })

  if (resolution.error !== undefined) {
    try { logger?.error?.(`model-discovery: ${resolution.error}`) } catch { /* no logger */ }
    return
  }
  if (resolution.settings.enabled) {
    const timer = setInterval(() => { void sync(false) }, resolution.settings.refreshMs)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer))
    queueMicrotask(() => { void sync(false) })
  }
}
