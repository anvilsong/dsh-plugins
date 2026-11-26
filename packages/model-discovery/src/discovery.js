// Pure catalog mapping and merge logic for dsh-plugin-model-discovery.
// No file system, environment, clock or network access happens here.

export const DEFAULT_PACKAGE = '@earendil-works/pi-ai'
export const DEFAULT_PROVIDERS = Object.freeze(['openai-codex'])
export const DEFAULT_REFRESH_MS = 6 * 60 * 60 * 1000
export const DEFAULT_TIMEOUT_MS = 15_000
/** New models added to one provider by one sync; the rest wait for the next check. */
export const MAX_MODELS_PER_SYNC = 200
export const MAX_NAME_LENGTH = 120

// pi-ai's thinking levels in escalation order.
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
// pi-ai treats an absent key for these levels as supported and sends the level
// name itself (pi-ai dist/models.js getSupportedThinkingLevels). An absent
// xhigh or max is unsupported there, and an absent off is "supported, send the
// protocol's default".
const IMPLICIT_LEVELS = new Set(['minimal', 'low', 'medium', 'high'])
// Protocols whose pi-ai dispatch sends `thinkingLevelMap[level] ?? level`, so
// an absent key and a key equal to the level name send the same request
// (pi-ai dist/api/openai-codex-responses.js, openai-responses.js,
// azure-openai-responses.js). Other protocols map an absent key to their own
// default (Anthropic and Bedrock send "low" for minimal, Mistral "high"),
// which DSH's explicit reasoningEfforts cannot express.
const LEVEL_NAME_PROTOCOLS = new Set(['openai-codex-responses', 'openai-responses', 'azure-openai-responses'])
const MODALITIES = new Set(['text', 'image'])
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/
const VERSION_ID = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/
const MODEL_ID = /^[A-Za-z0-9._:/~+@-]{1,128}$/
const WIRE_VALUE = /^[A-Za-z0-9._:-]{1,64}$/
// C0/C1 controls, zero-width and bidirectional formatting characters.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g

/** Replace control and formatting characters with spaces and cap the length. */
export function clean(value, max = 200) {
  let text
  try {
    text = String(value)
  } catch {
    text = '?'
  }
  text = text.replace(UNSAFE_TEXT, ' ')
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
}

export function resolveSettings(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return { error: 'config must be an object' }
  const enabled = config.enabled ?? true
  if (typeof enabled !== 'boolean') return { error: 'enabled must be a boolean' }
  const syncAllowedModels = config.syncAllowedModels ?? false
  if (typeof syncAllowedModels !== 'boolean') return { error: 'syncAllowedModels must be a boolean' }
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
    return { error: 'refreshMs must be an integer between 60000 and 604800000' }
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
    return { error: 'timeoutMs must be an integer between 1000 and 120000' }
  }
  return {
    settings: Object.freeze({
      enabled, syncAllowedModels, packageName, providers: Object.freeze(unique), refreshMs, timeoutMs,
    }),
  }
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
  return { id: clean(id, 80), reason: clean(reason, 160) }
}

/**
 * Translate one upstream thinkingLevelMap into DSH reasoningEfforts with the
 * same offered levels and wire values pi-ai derives from it:
 * - a string wire value is copied;
 * - null (unsupported) is omitted, so DSH pins that level unsupported;
 * - an absent minimal/low/medium/high gets its own name as the wire value,
 *   but only on protocols where pi-ai itself sends the level name; on any
 *   other protocol such a map is refused, because DSH would change the request;
 * - an absent off becomes `off: null` (DSH: "supported, send nothing extra",
 *   which leaves pi-ai's own default for off in place);
 * - an absent xhigh/max stays omitted (unsupported, as in pi-ai).
 * Unknown levels and malformed wire values are ignored.
 * @returns `{ efforts }`, or `{ error }` when the map cannot be expressed.
 */
export function mapEfforts(map, api) {
  const efforts = {}
  for (const level of LEVELS) {
    const wire = Object.hasOwn(map, level) ? map[level] : undefined
    if (typeof wire === 'string' && WIRE_VALUE.test(wire)) {
      efforts[level] = wire
    } else if (wire === undefined && IMPLICIT_LEVELS.has(level)) {
      if (!LEVEL_NAME_PROTOCOLS.has(api)) {
        return { error: `thinkingLevelMap leaves ${level} to pi-ai's ${clean(api, 40)} default, which DSH cannot express` }
      }
      efforts[level] = level
    } else if (wire === undefined && level === 'off') {
      efforts.off = null
    }
  }
  return { efforts }
}

/**
 * Map one upstream provider catalog to the fields DSH accepts, with per-model
 * issues. `apis` records each accepted model's upstream wire protocol, which
 * is checked but never copied.
 *
 * `maxTokens` is validated and then NOT copied. In DSH, a `maxTokens` on a model
 * entry is also that model's default per-request output cap, while the installed
 * catalog's value is only a capability: an entry without it keeps the installed
 * cap (or DSH's own default), and an entry for a model the installed catalog
 * does not describe gets no cap of its own, so nothing asks a provider for a
 * capability-sized output. A user who wants a cap sets it by hand.
 */
export function mapCatalog(raw, provider) {
  const apis = new Map()
  if (!isRecord(raw)) return { models: [], apis, issues: [modelIssue('<catalog>', 'catalog JSON is not an object')] }
  const models = []
  const issues = []
  const seen = new Set()
  for (const [group, entries] of Object.entries(raw)) {
    if (!isRecord(entries)) {
      issues.push(modelIssue(group, 'model group is not an object'))
      continue
    }
    for (const [key, model] of Object.entries(entries)) {
      if (!isRecord(model)) {
        issues.push(modelIssue(key, 'model entry is not an object'))
        continue
      }
      if (typeof model.id !== 'string' || !MODEL_ID.test(model.id)) {
        issues.push(modelIssue(key, 'id is missing, empty, longer than 128 characters or has unsupported characters'))
        continue
      }
      const id = model.id
      // The type is judged first: pi-ai removes duplicate ids only within one
      // type, so a classifier that shares a chat model's id must not hide it.
      if (model.type !== 'chat') {
        issues.push(modelIssue(id, `unsupported model type ${clean(model.type, 40)}`))
        continue
      }
      if (seen.has(id)) {
        issues.push(modelIssue(id, 'duplicate model id'))
        continue
      }
      seen.add(id)
      if (model.provider !== provider) {
        issues.push(modelIssue(id, `provider is ${clean(model.provider, 40)}, expected ${provider}`))
        continue
      }
      if (model.api !== group) {
        issues.push(modelIssue(id, `api ${clean(model.api, 40)} does not match its catalog group ${clean(group, 40)}`))
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
      const name = typeof model.name === 'string' ? clean(model.name, MAX_NAME_LENGTH).trim() : ''
      const entry = {
        id,
        name: name.length > 0 ? name : id,
        contextWindow: model.contextWindow,
        input,
      }
      if (model.reasoning) {
        if (!isRecord(model.thinkingLevelMap)) {
          issues.push(modelIssue(id, 'a reasoning model needs thinkingLevelMap'))
          continue
        }
        const mapped = mapEfforts(model.thinkingLevelMap, group)
        if (mapped.error !== undefined) {
          issues.push(modelIssue(id, mapped.error))
          continue
        }
        const efforts = mapped.efforts
        // DSH rejects a reasoning entry that offers nothing beyond off.
        if (!Object.keys(efforts).some((level) => level !== 'off')) {
          issues.push(modelIssue(id, 'thinkingLevelMap has no supported level besides off'))
          continue
        }
        entry.reasoningEfforts = efforts
      }
      models.push(entry)
      apis.set(id, group)
    }
  }
  return { models, apis, issues }
}

/**
 * The protocol a new model must share before it is added. DSH serves a model
 * its bundled pi-ai catalog does not know on the provider's `api` setting or,
 * when that is unset, on the protocol its bundled catalog uses for the
 * provider. A model of another protocol would be sent with the wrong one.
 */
function expectedApi(current, ids, catalog) {
  if (typeof current.api === 'string' && current.api.length > 0) {
    return { api: current.api, source: 'the provider api setting' }
  }
  const known = new Set([...ids].filter((id) => catalog.apis.has(id)).map((id) => catalog.apis.get(id)))
  if (known.size === 1) return { api: [...known][0], source: 'the protocol of the models you already list' }
  // Listed models span several protocols, so DSH's bundled catalog does too.
  // Which protocol DSH would use for a model it does not know is then
  // unknowable here, so new models are skipped rather than added unchecked.
  if (known.size > 1) return { unknown: true }
  const offered = new Set(catalog.apis.values())
  if (offered.size === 1) return { api: [...offered][0], source: 'the only protocol in the upstream catalog' }
  return { unknown: true }
}

/**
 * Plan the additions for one provider. Never creates a provider, never
 * replaces a provider that serves pi-ai's installed catalog (no `models`
 * list), and never edits, reorders or removes an existing entry.
 */
export function planProvider(providers, provider, catalog, limit = MAX_MODELS_PER_SYNC) {
  if (providers === undefined || providers === null) return { error: `provider ${provider} is not configured` }
  if (!isRecord(providers)) return { error: 'the llm-pi-ai providers setting is not an object' }
  if (!Object.hasOwn(providers, provider)) return { error: `provider ${provider} is not configured` }
  const current = providers[provider]
  if (!isRecord(current)) return { error: `the config of provider ${provider} is not an object` }
  if (current.models !== undefined && !Array.isArray(current.models)) {
    return { error: `providers.${provider}.models is not an array` }
  }
  if (current.models === undefined || current.models.length === 0) {
    return { error: `provider ${provider} serves pi-ai's installed catalog; list its models explicitly first (see README)` }
  }
  const existing = current.models
  const ids = new Set(existing.map((model) => (isRecord(model) ? model.id : undefined)))
  const expected = expectedApi(current, ids, catalog)
  const skipped = []
  const candidates = []
  for (const model of catalog.models) {
    if (ids.has(model.id)) continue
    const api = catalog.apis.get(model.id)
    if (expected.unknown) {
      skipped.push(`${model.id}: the protocol DSH would use for it cannot be determined (your listed models or the upstream catalog span several protocols)`)
      continue
    }
    if (expected.api !== undefined && api !== expected.api) {
      skipped.push(`${model.id}: upstream api ${clean(api, 40)} differs from ${clean(expected.api, 40)} (${expected.source})`)
      continue
    }
    candidates.push(model)
  }
  const added = candidates.slice(0, limit)
  const deferred = candidates.length - added.length
  if (deferred > 0) skipped.push(`${deferred} more new ${provider} models wait for the next check (at most ${limit} per sync)`)
  return {
    provider: { ...current, models: [...existing, ...added] },
    added: added.map((model) => model.id),
    skipped,
    deferred,
  }
}

/** Replace one provider inside a whole llm-pi-ai config without touching other fields. */
export function mergeConfig(current, provider, nextProvider) {
  if (!isRecord(current?.providers)) throw new Error('the llm-pi-ai providers setting is not an object')
  return { ...current, providers: { ...current.providers, [provider]: nextProvider } }
}

/** Add only the missing provider/model routes for the given model ids. */
export function mergeAllowedModels(currentAllowed, provider, modelIds) {
  if (currentAllowed !== undefined && !Array.isArray(currentAllowed)) {
    return { error: 'allowedModels is not an array' }
  }
  const existing = currentAllowed ?? []
  const seen = new Set(existing.map((route) => (isRecord(route) ? `${route.provider}\0${route.model}` : '')))
  const added = [...new Set(modelIds)]
    .filter((id) => !seen.has(`${provider}\0${id}`))
    .map((model) => ({ provider, model }))
  return {
    allowedModels: [...existing, ...added],
    added: added.map((route) => route.model),
  }
}

/** Most ids one seed lists; DSH's own list is read once and never paged. */
export const MAX_SEED_IDS = 2000

/**
 * The wire protocol of each id in one latest provider catalog, for the seed.
 * An id has a protocol only when it has exactly one chat entry, that entry is
 * of the requested provider, its `api` equals the catalog group it sits in
 * and the group name is a plain protocol name. pi-ai itself keeps the last
 * duplicate and trusts the entry's own `api`, which `mapCatalog` does not,
 * so an id with several chat entries, or whose entry disagrees with its
 * group, is never given a guessed protocol: it is reported in `unusable`
 * with the reason. Non-chat entries (images, classifiers) never count, so an
 * id shared by a chat and an image entry keeps its chat protocol. Unlike
 * mapCatalog's `apis` it does not need the entry to be mappable, because the
 * seed lists ids, not entries.
 * @returns `{ protocols: Map<id, api>, unusable: Map<id, reason> }`, plus
 * `error` when the catalog is not an object.
 */
export function catalogProtocols(raw, provider) {
  const protocols = new Map()
  const unusable = new Map()
  if (!isRecord(raw)) return { protocols, unusable, error: 'catalog JSON is not an object' }
  const chat = new Map()
  for (const [group, entries] of Object.entries(raw)) {
    if (!isRecord(entries)) continue
    for (const model of Object.values(entries)) {
      if (!isRecord(model)) continue
      if (typeof model.id !== 'string' || !MODEL_ID.test(model.id)) continue
      if (model.type !== 'chat') continue
      const list = chat.get(model.id) ?? []
      list.push({ group, model })
      chat.set(model.id, list)
    }
  }
  for (const [id, list] of chat) {
    if (!list.some((item) => item.model.provider === provider)) continue
    if (list.length > 1) {
      unusable.set(id, 'has more than one chat entry in the latest catalog, so its protocol is ambiguous')
      continue
    }
    const { group, model } = list[0]
    if (!PROVIDER_ID.test(group)) {
      unusable.set(id, `its catalog group name ${clean(group, 40)} is not a protocol name`)
    } else if (model.api !== group) {
      unusable.set(id, `its latest catalog entry names api ${clean(model.api, 40)} but sits in group ${clean(group, 40)}`)
    } else {
      protocols.set(id, group)
    }
  }
  return { protocols, unusable }
}

/**
 * Validate what `llm.listModels(provider)` returned. Every entry must be an
 * object with a string id and, when it names a provider, the asked one.
 * @returns `{ ids }` in the service's order, or `{ error }`.
 */
export function readServed(list, provider) {
  if (!Array.isArray(list)) return { error: 'llm.listModels did not return a list' }
  if (list.length === 0) return { error: `DSH serves no models for provider ${provider}` }
  if (list.length > MAX_SEED_IDS) return { error: `DSH serves more than ${MAX_SEED_IDS} models for provider ${provider}` }
  const ids = []
  for (const item of list) {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id.length === 0) {
      return { error: 'llm.listModels returned an entry without an id' }
    }
    if (item.provider !== undefined && item.provider !== provider) {
      return { error: `llm.listModels returned a model of another provider (${clean(item.provider, 40)})` }
    }
    ids.push(item.id)
  }
  return { ids }
}

/**
 * Config checks of a seed that need neither the served list nor the catalog.
 * A seed only converts a provider that serves pi-ai's installed catalog: it
 * never creates a provider and never replaces a `models` list.
 * @returns `{ current, routeApi }` (routeApi is undefined when unset), or `{ error }`.
 */
export function seedPrecheck(providers, provider, api, { local = false } = {}) {
  if (providers === undefined || providers === null) return { error: `provider ${provider} is not configured` }
  if (!isRecord(providers)) return { error: 'the llm-pi-ai providers setting is not an object' }
  if (!Object.hasOwn(providers, provider)) return { error: `provider ${provider} is not configured` }
  const current = providers[provider]
  if (!isRecord(current)) return { error: `the config of provider ${provider} is not an object` }
  if (current.models !== undefined && !Array.isArray(current.models)) {
    return { error: `providers.${provider}.models is not an array` }
  }
  if (Array.isArray(current.models) && current.models.length > 0) {
    // A local route already has a list and is synced by `/model-discovery local`, not by seed.
    return local
      ? { error: `provider ${provider} already lists models; a local route reconciles that list with /model-discovery local` }
      : { error: `provider ${provider} already lists models; seed only converts a provider that serves pi-ai's installed catalog (sync adds new models to a list)` }
  }
  if (current.modelOverrides !== undefined) {
    return { error: `provider ${provider} has modelOverrides, which DSH refuses together with models; move them onto model entries by hand first (see README)` }
  }
  let routeApi
  if (current.api !== undefined) {
    if (typeof current.api !== 'string' || current.api.length === 0) {
      return { error: `the api setting of provider ${provider} is not a non-empty string` }
    }
    routeApi = current.api
    if (api !== undefined && api !== routeApi) {
      return { error: `${clean(api, 40)} differs from the provider api setting ${clean(routeApi, 40)}; nothing was changed` }
    }
  }
  return { current, routeApi }
}

/**
 * Plan the seed of one provider: the id-only `models` list and, only when the
 * seed itself picks the route protocol, the `api` to write.
 *
 * DSH serves a listed model on the route `api` when its bundled catalog does
 * not know it, so an id may only be listed under an `api` the seed writes when
 * the latest catalog puts that id in the same protocol group. Every other id
 * is left out and named. Without a requested api nothing is written for the
 * protocol: the route's own `api`, or the single protocol the ids share,
 * already decides, and all valid served ids are listed.
 *
 * Pure: `providers` is never modified. Same inputs, same plan.
 * @returns `{ error }` or `{ provider, api, ids, leftOut, served, protocolCounts, signature }`
 */
export function planSeed(providers, provider, api, servedIds, protocols, version, unusable = new Map()) {
  const checked = seedPrecheck(providers, provider, api)
  if (checked.error !== undefined) return checked
  const { current, routeApi } = checked
  if (protocols.size === 0 && unusable.size === 0) {
    return { error: `the latest pi-ai catalog (${clean(version, 40)}) has no chat model for provider ${provider}; nothing was changed` }
  }
  const notChat = `not a chat model of ${provider} in the latest pi-ai catalog (${clean(version, 40)})`
  // Pass 1: which served ids are valid candidates, and how the catalog groups them.
  const invalid = new Map()
  const candidates = []
  const seen = new Set()
  servedIds.forEach((id, index) => {
    if (typeof id !== 'string' || !MODEL_ID.test(id)) {
      invalid.set(index, 'id is empty, longer than 128 characters or has unsupported characters')
    } else if (seen.has(id)) {
      invalid.set(index, 'duplicate id in the served list')
    } else {
      seen.add(id)
      candidates.push(id)
    }
  })
  const counts = new Map()
  let unknown = 0
  for (const id of candidates) {
    const protocol = protocols.get(id)
    if (protocol === undefined) unknown += 1
    else counts.set(protocol, (counts.get(protocol) ?? 0) + 1)
  }
  const protocolCounts = [...counts].map(([name, count]) => ({ api: name, count }))
  const protocolList = protocolCounts.map((entry) => `${clean(entry.api, 40)} (${entry.count})`).join(', ')
  let writeApi = null
  let filter = false
  if (api !== undefined) {
    if (!counts.has(api)) {
      return { error: `no served model uses ${clean(api, 40)} in the latest pi-ai catalog${protocolList.length > 0 ? ` (protocols found: ${protocolList})` : ''}; nothing was changed` }
    }
    filter = true
    if (routeApi === undefined) writeApi = api
  } else if (routeApi === undefined && counts.size > 1) {
    const commands = protocolCounts.map((entry) => `/model-discovery seed ${provider} ${clean(entry.api, 40)}`).join(' or ')
    return { error: `the served models of ${provider} use several protocols in the latest pi-ai catalog: ${protocolList}. A route sends its models on one protocol, so name one (the other protocols' models are left out): ${commands}. Nothing was changed.` }
  }
  // Pass 2, in the served order: list or leave out.
  const ids = []
  const leftOut = []
  servedIds.forEach((id, index) => {
    if (invalid.has(index)) {
      leftOut.push({ id: clean(id, 80), reason: invalid.get(index) })
      return
    }
    const protocol = protocols.get(id)
    if (!filter || protocol === api) ids.push(id)
    else if (unusable.has(id)) leftOut.push({ id, reason: unusable.get(id) })
    else if (protocol === undefined) leftOut.push({ id, reason: notChat })
    else leftOut.push({ id, reason: `protocol ${clean(protocol, 40)} in the latest catalog, not ${clean(api, 40)}` })
  })
  if (ids.length === 0) return { error: `no id is left to list: none of the ${servedIds.length} served ids can be listed; nothing was changed` }
  const served = servedIds.length
  const next = { ...current, ...(writeApi === null ? {} : { api: writeApi }), models: ids.map((id) => ({ id })) }
  return {
    provider: next,
    routeApi,
    api: writeApi,
    ids,
    leftOut,
    served,
    unknown,
    protocolCounts,
    version,
    filtered: filter,
    signature: JSON.stringify({ version, routeApi: routeApi ?? null, api: writeApi, ids, leftOut: leftOut.map((entry) => [entry.id, entry.reason]) }),
  }
}

export function statusText(settings, state) {
  const lines = [
    `Model discovery is ${settings.enabled ? 'enabled' : 'disabled'} for ${settings.providers.join(', ')}.`,
    settings.enabled
      ? `Automatic checks run every ${Math.round(settings.refreshMs / 60_000)} minutes; /model-discovery sync checks now.`
      : 'Automatic checks are off; /model-discovery sync still checks now.',
    settings.syncAllowedModels
      ? 'Subagent routes: added for the models this plugin adds (syncAllowedModels is true).'
      : 'Subagent routes: not changed (syncAllowedModels is false).',
  ]
  if (state.lastVersion !== undefined) lines.push(`Latest published pi-ai: ${state.lastVersion}.`)
  if (state.lastFinishedAt !== undefined) lines.push(`Last finished: ${new Date(state.lastFinishedAt).toISOString()}.`)
  if (state.nextCheckAt !== undefined) lines.push(`Next automatic check: ${new Date(state.nextCheckAt).toISOString()}.`)
  if (state.pendingRoutes?.length > 0) lines.push(`Subagent routes waiting for a retry: ${state.pendingRoutes.join(', ')}.`)
  const localRoutes = settings.localRoutes ?? {}
  const localIds = Object.keys(localRoutes)
  if (localIds.length > 0) {
    lines.push(`Local routes: ${localIds.map((id) => `${id} (${localRoutes[id].mode})`).join(', ')}. /model-discovery local <provider> previews one; a confirmed manual run may remove, an automatic run never does.`)
    for (const id of localIds) {
      const last = state.lastLocal?.[id]
      if (last === undefined) continue
      lines.push(`  ${id}: ${last.mode}, last ${last.outcome}.`)
    }
  }
  if (state.lastResult !== undefined) lines.push(state.lastResult)
  return lines.join('\n')
}
