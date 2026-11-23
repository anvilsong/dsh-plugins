// Pure catalog mapping and merge logic for dsh-plugin-model-discovery.
// No file system, environment, clock or network access happens here.

export const DEFAULT_PACKAGE = '@earendil-works/pi-ai'
export const DEFAULT_PROVIDERS = Object.freeze(['openai-codex'])
export const DEFAULT_REFRESH_MS = 6 * 60 * 60 * 1000
export const DEFAULT_TIMEOUT_MS = 15_000

const LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const MODALITIES = new Set(['text', 'image'])
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/
const VERSION_ID = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/

export function resolveSettings(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return { error: 'config must be an object' }
  const enabled = config.enabled ?? true
  if (typeof enabled !== 'boolean') return { error: 'enabled must be a boolean' }
  const packageName = config.packageName ?? DEFAULT_PACKAGE
  if (packageName !== DEFAULT_PACKAGE) return { error: `packageName must be ${DEFAULT_PACKAGE}` }
  const providers = config.providers ?? DEFAULT_PROVIDERS
  if (!Array.isArray(providers) || providers.length === 0) return { error: 'providers must be a non-empty array' }
  const unique = [...new Set(providers)]
  if (unique.some((provider) => typeof provider !== 'string' || !PROVIDER_ID.test(provider))) {
    return { error: 'providers must contain only lowercase provider ids' }
  }
  const refreshMs = config.refreshMs ?? DEFAULT_REFRESH_MS
  if (!Number.isSafeInteger(refreshMs) || refreshMs < 60_000 || refreshMs > 7 * 24 * 60 * 60 * 1000) {
    return { error: 'refreshMs must be between 60000 and 604800000' }
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
    return { error: 'timeoutMs must be between 1000 and 120000' }
  }
  return { settings: Object.freeze({ enabled, packageName, providers: Object.freeze(unique), refreshMs, timeoutMs }) }
}

export function latestCatalogUrl() {
  return `https://registry.npmjs.org/${DEFAULT_PACKAGE}/latest`
}

export function providerCatalogUrl(version, provider) {
  if (!VERSION_ID.test(version)) throw new Error('invalid package version')
  if (!PROVIDER_ID.test(provider)) throw new Error('invalid provider id')
  return `https://unpkg.com/${DEFAULT_PACKAGE}@${version}/dist/providers/data/${provider}.json`
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function modelIssue(id, reason) {
  return { id, reason }
}

/** Map one upstream provider catalog to the fields DSH accepts, with per-model issues. */
export function mapCatalog(raw, provider) {
  if (!isRecord(raw)) return { models: [], issues: [modelIssue('<catalog>', 'catalog JSON is not an object')] }
  const models = []
  const issues = []
  const seen = new Set()
  for (const [group, entries] of Object.entries(raw)) {
    if (!isRecord(entries)) {
      issues.push(modelIssue(group, 'model group is not an object')
      )
      continue
    }
    for (const [key, model] of Object.entries(entries)) {
      const id = isRecord(model) && typeof model.id === 'string' ? model.id : key
      if (!isRecord(model)) {
        issues.push(modelIssue(id, 'model entry is not an object'))
        continue
      }
      if (seen.has(id)) {
        issues.push(modelIssue(id, 'duplicate model id'))
        continue
      }
      seen.add(id)
      if (model.type !== 'chat') {
        issues.push(modelIssue(id, `unsupported model type ${String(model.type)}`))
        continue
      }
      if (model.provider !== provider) {
        issues.push(modelIssue(id, `provider is ${String(model.provider)}, expected ${provider}`))
        continue
      }
      if (typeof model.baseUrl !== 'string' || !model.baseUrl.startsWith('https://')) {
        issues.push(modelIssue(id, 'baseUrl must be https'))
        continue
      }
      if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0) {
        issues.push(modelIssue(id, 'contextWindow must be a positive integer'))
        continue
      }
      if (!Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0) {
        issues.push(modelIssue(id, 'maxTokens must be a positive integer'))
        continue
      }
      const input = Array.isArray(model.input)
        ? [...new Set(model.input.filter((value) => typeof value === 'string' && MODALITIES.has(value)))]
        : []
      if (input.length === 0) {
        issues.push(modelIssue(id, 'no supported input modality (text or image)'))
        continue
      }
      if (typeof model.reasoning !== 'boolean') {
        issues.push(modelIssue(id, 'reasoning must be a boolean'))
        continue
      }
      const entry = {
        id,
        name: typeof model.name === 'string' && model.name.length > 0 ? model.name : id,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        input,
      }
      if (model.reasoning) {
        if (!isRecord(model.thinkingLevelMap)) {
          issues.push(modelIssue(id, 'a reasoning model needs thinkingLevelMap'))
          continue
        }
        const efforts = {}
        for (const [level, wire] of Object.entries(model.thinkingLevelMap)) {
          if (!LEVELS.has(level)) continue
          // A null upstream value means "unsupported". DSH deliberately
          // treats a null reasoningEfforts value as absent, so copying it
          // would make pi-ai fall back to the wire value "none". Omitting
          // the key instead makes DSH pin that level to null (unsupported).
          if (typeof wire === 'string' && wire.length > 0) efforts[level] = wire
        }
        if (Object.keys(efforts).length === 0) {
          issues.push(modelIssue(id, 'thinkingLevelMap has no supported effort'))
          continue
        }
        entry.reasoningEfforts = efforts
      }
      models.push(entry)
    }
  }
  return { models, issues }
}

/** Add only missing ids; existing entries and every other provider are preserved. */
export function mergeProvider(currentProvider, discovered) {
  const provider = isRecord(currentProvider) ? currentProvider : {}
  if (currentProvider !== undefined && currentProvider !== null && !isRecord(currentProvider)) {
    return { error: 'the provider config is not an object' }
  }
  if (provider.models !== undefined && !Array.isArray(provider.models)) {
    return { error: 'providers.<id>.models is not an array' }
  }
  const existing = provider.models ?? []
  const ids = new Set(existing.map((model) => model?.id))
  const added = discovered.filter((model) => !ids.has(model.id))
  return {
    provider: { ...provider, models: [...existing, ...added] },
    added: added.map((model) => model.id),
  }
}

/** Merge one provider into a whole llm-pi-ai config without touching other fields. */
export function mergeConfig(current, provider, nextProvider) {
  const providers = isRecord(current.providers) ? current.providers : {}
  return { ...current, providers: { ...providers, [provider]: nextProvider } }
}

/** Add only missing provider/model routes to the subagent allow-list. */
export function mergeAllowedModels(currentAllowed, provider, discovered) {
  if (currentAllowed !== undefined && !Array.isArray(currentAllowed)) {
    return { error: 'allowedModels is not an array' }
  }
  const existing = currentAllowed ?? []
  const seen = new Set(existing.map((route) => `${route?.provider}/${route?.model}`))
  const added = discovered
    .filter((model) => !seen.has(`${provider}/${model.id}`))
    .map((model) => ({ provider, model: model.id }))
  return {
    allowedModels: [...existing, ...added],
    added: added.map((route) => route.model),
  }
}

export function statusText(settings, state) {
  const lines = [
    `Model discovery is ${settings.enabled ? 'enabled' : 'disabled'} for ${settings.providers.join(', ')}.`,
    `Checks run every ${Math.round(settings.refreshMs / 60_000)} minutes; /model-discovery sync always checks now.`,
  ]
  if (state.lastVersion !== undefined) lines.push(`Latest published pi-ai: ${state.lastVersion}.`)
  if (state.lastFinishedAt !== undefined) lines.push(`Last finished: ${new Date(state.lastFinishedAt).toISOString()}.`)
  if (state.nextCheckAt !== undefined) lines.push(`Next automatic check: ${new Date(state.nextCheckAt).toISOString()}.`)
  if (state.lastAdded?.length > 0) lines.push(`Added in the last sync: ${state.lastAdded.join(', ')}.`)
  if (state.lastSkipped?.length > 0) lines.push(`Skipped in the last sync: ${state.lastSkipped.join(', ')}.`)
  if (state.lastError !== undefined) lines.push(`Last error: ${state.lastError}`)
  if (state.lastResult !== undefined) lines.push(state.lastResult)
  return lines.join('\n')
}
