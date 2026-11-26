// Local-route reconciliation for a self-hosted OpenAI-compatible endpoint (plan bd791fa9ddef).
//
// The catalog sync and the seed only ever ADD to a provider that lists its models. A local
// route is the one deliberate exception: on a route the user pins by hand, the server that
// the route points at is the authority for membership and for `contextWindow`, so a model
// the server stopped serving may leave the list and a window that changed is updated. Every
// other field of a surviving entry is kept exactly, and only an explicitly confirmed manual
// command removes anything: an automatic plan reports absent ids and never removes.
//
// This module is pure: no fetch, no filesystem, no clock, never mutates its input.

import { clean } from './discovery.js'

/** Most models one local route may advertise in one snapshot. */
export const MAX_LOCAL_MODELS = 2000

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/
const MODEL_ID = /^[A-Za-z0-9._:/~+@-]{1,128}$/
const LOCAL_KEYS = new Set(['baseURL', 'mode'])
const MODES = new Set(['manual', 'auto'])
// A dotted-quad of four decimal octets in 127/8, written without leading zeros, or [::1].
const LOOPBACK_V4 = /^127\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})$/
const LOOPBACK_V6 = '[::1]'
// A path prefix: one or more /segment parts, each a conservative token, no dot segments.
const PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/
const CTX_FLAG = '--ctx-size'
const CTX_FLAG_EQ = '--ctx-size='
const PREDICT_FLAG = '--n-predict'
const PREDICT_FLAG_EQ = '--n-predict='

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The `localRoutes` setting: provider id -> { baseURL, mode }. Absent means no local route,
 * which is the default. An unknown key, a missing baseURL or a mode other than manual/auto
 * is an error, so a typo can never quietly turn polling on.
 * @param raw - the configured value; `undefined` means the default `{}`.
 * @param providers - catalog provider ids, which a local route may not also name.
 * @returns the routes, or `{ error }`.
 */
export function localRoutesOf(raw, providers = []) {
  if (raw === undefined) return {}
  if (!isRecord(raw)) return { error: 'localRoutes must be an object' }
  const routes = {}
  const catalog = new Set(providers)
  for (const [provider, value] of Object.entries(raw)) {
    if (!PROVIDER_ID.test(provider)) return { error: 'localRoutes must use lowercase provider ids' }
    if (catalog.has(provider)) return { error: `local route ${provider} cannot also be a catalog provider` }
    if (!isRecord(value)) return { error: `localRoutes.${provider} must be an object` }
    for (const key of Object.keys(value)) {
      if (!LOCAL_KEYS.has(key)) return { error: `localRoutes.${provider} takes only baseURL and mode` }
    }
    if (typeof value.baseURL !== 'string' || value.baseURL.length === 0) {
      return { error: `localRoutes.${provider}.baseURL is required` }
    }
    const mode = value.mode ?? 'manual'
    if (!MODES.has(mode)) return { error: `localRoutes.${provider}.mode must be manual or auto` }
    routes[provider] = Object.freeze({ baseURL: value.baseURL, mode })
  }
  return routes
}

/**
 * Split a raw config into catalog settings and local routes. `providers` may be empty only
 * when at least one local route is configured, so a local-only profile is expressible.
 * @returns `{ settings: { catalog, localRoutes } }`, or `{ error }`.
 */
export function splitLocalRoutes(config = {}) {
  if (!isRecord(config)) return { error: 'config must be an object' }
  const providers = config.providers ?? ['openai-codex']
  if (!Array.isArray(providers)) return { error: 'providers must be a non-empty array' }
  const unique = [...new Set(providers)]
  if (unique.some((provider) => typeof provider !== 'string' || !PROVIDER_ID.test(provider))) {
    return { error: 'providers must contain only lowercase provider ids' }
  }
  const routes = localRoutesOf(config.localRoutes, unique)
  if (routes.error !== undefined) return { error: routes.error }
  if (unique.length === 0 && Object.keys(routes).length === 0) {
    return { error: 'providers must be a non-empty array' }
  }
  return { settings: { providers: Object.freeze(unique), localRoutes: Object.freeze(routes) } }
}

/**
 * Validate a pinned endpoint on the ORIGINAL string, before any URL parsing that could
 * normalize an odd spelling, and return its canonical form. Only loopback is accepted:
 * a dotted 127.0.0.0/8 literal without leading zeros, or [::1]. A DNS name (including
 * `localhost`), a LAN or public address, an IPv4-mapped IPv6 address, credentials, a query,
 * a fragment, a control character, a backslash, an encoded byte or a dot segment is
 * refused, because any of them can reach something other than the local server.
 * @returns `{ pin }` (no trailing slash) or `{ error }`.
 */
export function normalizePin(text) {
  if (typeof text !== 'string' || text.length === 0) return { error: 'baseURL must be a non-empty string' }
  if (text.length > 200) return { error: 'baseURL is too long' }
  if (/[\u0000-\u001f\u007f\\]/.test(text)) return { error: 'baseURL contains a control character or a backslash' }
  if (/%/.test(text)) return { error: 'baseURL must not contain percent-encoded bytes' }
  if ('?#'.includes(text.includes('#') ? '#' : text.includes('?') ? '?' : ' ')) return { error: 'baseURL must not carry a query or a fragment' }
  const match = /^(https?):\/\/([^/]*)(\/.*)?$/.exec(text)
  if (match === null) return { error: 'baseURL must be an http or https URL' }
  const rest = match[2]
  if (rest.includes('@')) return { error: 'baseURL must not carry credentials' }
  let host
  let port = ''
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']')
    if (end === -1) return { error: 'baseURL has an unterminated IPv6 address' }
    host = rest.slice(0, end + 1)
    const after = rest.slice(end + 1)
    if (after !== '') {
      if (!after.startsWith(':')) return { error: 'baseURL has an invalid port' }
      port = after.slice(1)
    }
  } else {
    const colon = rest.lastIndexOf(':')
    host = colon === -1 ? rest : rest.slice(0, colon)
    port = colon === -1 ? '' : rest.slice(colon + 1)
  }
  const loopback = host === LOOPBACK_V6 || (LOOPBACK_V4.test(host) && host.split('.').every((octet) => Number(octet) <= 255))
  if (!loopback) return { error: 'baseURL host must be a loopback address (127.x.x.x or [::1])' }
  if (port === '') return { error: 'baseURL must name a port, for example http://127.0.0.1:8898/v1' }
  if (!/^[1-9]\d{0,4}$/.test(port)) return { error: 'baseURL has an invalid port' }
  if (Number(port) > 65535) return { error: 'baseURL has an invalid port' }
  const path = (match[3] ?? '').replace(/\/+$/, '')
  const segments = path === '' ? [] : path.slice(1).split('/')
  if (segments.length === 0) return { error: 'baseURL must name a path prefix such as /v1' }
  for (const segment of segments) {
    if (!PATH_SEGMENT.test(segment) || segment === '.' || segment === '..') {
      return { error: 'baseURL path must be plain segments without dot segments or encoded bytes' }
    }
  }
  return { pin: `${match[1].toLowerCase()}://${host}${port === '' ? '' : `:${port}`}/${segments.join('/')}` }
}

/** The exact URL one local probe requests: the pinned prefix plus `/models`. */
export function modelsUrl(pin) {
  return `${String(pin).replace(/\/+$/, '')}/models`
}

/**
 * The context a snapshot record advertises. One unambiguous positive decimal `--ctx-size`
 * is the authority, because it is the window the server was launched with and therefore the
 * one it serves (the user confirmed this for their router, where `context_length` reports the
 * model's own limit and is lower). `context_length` is only the fallback when the flag is
 * absent or unusable as a number; a disagreement is reported as an informational note, never
 * as a reason to prefer the smaller number. A malformed or repeated flag fails the record
 * instead of becoming absence, and an unsupported `-c` spelling is refused.
 * @returns `{ contextWindow, note? }` or `{ error }`.
 */
export function contextOf(record) {
  const args = isRecord(record) && isRecord(record.status) && Array.isArray(record.status.args) ? record.status.args : []
  if (args.some((argument) => argument === '-c' || (typeof argument === 'string' && argument.startsWith('-c=')))) {
    return { error: 'a -c context flag is not supported; use --ctx-size' }
  }
  const fromArgs = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === CTX_FLAG) {
      fromArgs.push(args[index + 1])
      index += 1
    } else if (typeof argument === 'string' && argument.startsWith(CTX_FLAG_EQ)) {
      fromArgs.push(argument.slice(CTX_FLAG_EQ.length))
    }
  }
  if (fromArgs.length > 1) return { error: 'the status args carry --ctx-size more than once' }
  const parse = (value) => {
    if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value)) return undefined
    const number = Number(value)
    return Number.isSafeInteger(number) ? number : undefined
  }
  const flagged = fromArgs.length === 1 ? parse(fromArgs[0]) : undefined
  if (fromArgs.length === 1 && flagged === undefined) return { error: 'the --ctx-size value is not a positive integer' }
  const declared = record?.context_length
  const declaredOk = Number.isSafeInteger(declared) && declared > 0 ? declared : undefined
  if (flagged === undefined && declaredOk === undefined) return { error: 'the record advertises no usable context' }
  const contextWindow = flagged ?? declaredOk
  if (declaredOk !== undefined && declaredOk !== contextWindow) {
    return { contextWindow, note: `--ctx-size says ${contextWindow} and context_length says ${declaredOk}; using the launch window ${contextWindow}` }
  }
  return { contextWindow }
}

/** The output cap a record advertises, from `--n-predict` (the server's own limit); absent means none. */
export function predictOf(record) {
  const args = isRecord(record) && isRecord(record.status) && Array.isArray(record.status.args) ? record.status.args : []
  const values = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === PREDICT_FLAG) {
      values.push(args[index + 1])
      index += 1
    } else if (typeof argument === 'string' && argument.startsWith(PREDICT_FLAG_EQ)) {
      values.push(argument.slice(PREDICT_FLAG_EQ.length))
    }
  }
  if (values.length > 1) return { error: 'the status args carry --n-predict more than once' }
  if (values.length === 0) return {}
  // -1 and 0 mean "no limit" in llama.cpp, so neither becomes a cap.
  const raw = values[0]
  if (typeof raw !== 'string' || !/^-?(0|[1-9]\d{0,15})$/.test(raw)) return { error: 'the --n-predict value is not an integer' }
  const number = Number(raw)
  if (!Number.isSafeInteger(number)) return { error: 'the --n-predict value is not a safe integer' }
  if (number <= 0) return {}
  return { maxTokens: number }
}

/**
 * Validate one `GET /models` reply as a whole. Identity is the model id alone: aliases,
 * `can_remove`, `status.value`, `source` and `tags` never decide membership, and an unloaded
 * model is still present. A malformed entry, a duplicate id or an over-large list fails the
 * whole snapshot, never a truncated subset, so a partial reply can never look like a removal.
 * @returns `{ models: [{ id, contextWindow, maxTokens?, contextNote?, input }] }` or `{ error }`.
 */
export function localSnapshot(body, provider) {
  if (!isRecord(body)) return { error: 'the models reply is not an object' }
  const data = body.data
  if (!Array.isArray(data)) return { error: 'the models reply has no data array' }
  if (data.length === 0) return { error: `the server ${clean(provider, 40)} serves no models` }
  if (data.length > MAX_LOCAL_MODELS) return { error: `the server advertises more than ${MAX_LOCAL_MODELS} models` }
  const seen = new Set()
  const models = []
  for (const [index, entry] of data.entries()) {
    if (!isRecord(entry)) return { error: `entry ${index} is not an object` }
    const id = entry.id
    if (typeof id !== 'string' || !MODEL_ID.test(id)) return { error: `entry ${index} has no usable model id` }
    if (seen.has(id)) return { error: `model ${clean(id, 80)} appears more than once (duplicate id)` }
    seen.add(id)
    const context = contextOf(entry)
    if (context.error !== undefined) return { error: `model ${clean(id, 80)}: ${context.error}` }
    const predict = predictOf(entry)
    if (predict.error !== undefined) return { error: `model ${clean(id, 80)}: ${predict.error}` }
    const advertised = isRecord(entry.architecture) && Array.isArray(entry.architecture.input_modalities)
      ? entry.architecture.input_modalities
      : []
    const input = advertised.includes('image') ? ['text', 'image'] : ['text']
    if (predict.maxTokens !== undefined && predict.maxTokens > context.contextWindow) {
      return { error: `model ${clean(id, 80)}: --n-predict ${predict.maxTokens} is larger than its context ${context.contextWindow}` }
    }
    models.push({
      id,
      contextWindow: context.contextWindow,
      ...(predict.maxTokens === undefined ? {} : { maxTokens: predict.maxTokens }),
      ...(context.note === undefined ? {} : { contextNote: context.note }),
      input,
    })
  }
  return { models }
}

/**
 * The preconditions of a local route, checked before any network request: the route exists,
 * names exactly the pinned endpoint, speaks `openai-completions`, has no `modelOverrides`
 * and offers a non-empty list of unique, valid ids without per-model routing.
 * @returns `{ models: existing entries }` or `{ error }`.
 */
export function localPrecheck(provider, pin, route) {
  if (!isRecord(route)) return { error: `provider ${clean(provider, 40)} was not found in the llm-pi-ai config` }
  const normalized = normalizePin(route.baseURL)
  if (normalized.error !== undefined) return { error: `provider ${clean(provider, 40)}: ${normalized.error}` }
  if (normalized.pin !== pin) return { error: `provider ${clean(provider, 40)} baseURL ${clean(normalized.pin, 120)} does not match the pinned ${clean(pin, 120)}` }
  if (route.api !== 'openai-completions') return { error: `provider ${clean(provider, 40)} api must be openai-completions` }
  if (route.modelOverrides !== undefined) return { error: `provider ${clean(provider, 40)} has modelOverrides, which a local route does not support` }
  if (!Array.isArray(route.models) || route.models.length === 0) {
    // A local route has no installed catalog to describe its names: seed it first.
    return { error: `provider ${clean(provider, 40)} has no models list; run /model-discovery seed ${clean(provider, 40)} first (a local route has no catalog to name its models from)` }
  }
  const seen = new Set()
  for (const [index, model] of route.models.entries()) {
    if (!isRecord(model)) return { error: `provider ${clean(provider, 40)} model ${index} is not an object` }
    if (typeof model.id !== 'string' || !MODEL_ID.test(model.id)) return { error: `provider ${clean(provider, 40)} model ${index} has unsupported characters in its id` }
    if (seen.has(model.id)) return { error: `provider ${clean(provider, 40)} lists ${clean(model.id, 80)} twice (duplicate id)` }
    seen.add(model.id)
    if (model.api !== undefined) return { error: `provider ${clean(provider, 40)} model ${clean(model.id, 80)} sets a per-model api, which local sync does not support` }
    if (model.baseURL !== undefined) return { error: `provider ${clean(provider, 40)} model ${clean(model.id, 80)} sets a per-model baseURL, which local sync does not support` }
  }
  return { models: route.models }
}

/**
 * The new provider entry a reconciliation proposes. Never changes `api`, `baseURL` or
 * anything else: the caller writes the returned `models` list only.
 * @returns a plan with `route` (the proposed provider entry), `changed`, `added`,
 * `removed`, `pendingRemovals`, `contextChanges`, `retained` and `warnings`, or `{ error }`.
 */
export function planLocalRoute({ provider, pin, mode, route, models }) {
  const checked = localPrecheck(provider, pin, route)
  if (checked.error !== undefined) return { error: checked.error }
  if (!Array.isArray(models)) return { error: 'the snapshot was not read' }
  const live = new Map(models.map((model) => [model.id, model]))
  const existing = checked.models
  const kept = []
  const added = []
  const pendingRemovals = []
  const removed = []
  const contextChanges = []
  const maxTokensChanges = []
  const retained = []
  const warnings = []
  for (const model of existing) {
    const seen = live.get(model.id)
    if (seen === undefined) {
      pendingRemovals.push(model.id)
      if (mode === 'manual') removed.push(model.id)
      else kept.push(model)
      continue
    }
    const current = model.contextWindow
    if (seen.contextWindow < (Number.isSafeInteger(model.maxTokens) ? model.maxTokens : 0)) {
      return { error: `model ${clean(model.id, 80)}: the server advertises ${seen.contextWindow} tokens, below its own maxTokens ${model.maxTokens}; not changed` }
    }
    // contextWindow follows the server; maxTokens is written only when the server states one
    // (--n-predict) and is otherwise left exactly as the user set it.
    const next = { ...model, contextWindow: seen.contextWindow }
    if (seen.maxTokens !== undefined && model.maxTokens !== seen.maxTokens) {
      next.maxTokens = seen.maxTokens
      maxTokensChanges.push({ id: model.id, from: model.maxTokens ?? null, to: seen.maxTokens })
    }
    if (current !== seen.contextWindow) contextChanges.push({ id: model.id, from: current, to: seen.contextWindow })
    else if (next.maxTokens === model.maxTokens) retained.push(model.id)
    kept.push(next)
  }
  // A manual plan may drop every id already listed; it must then append at least one live
  // model that it keeps, because a route with no models would stop serving anything.
  if (kept.length === 0) {
    return { error: 'the plan would empty the models list; the server serves none of the listed ids, so nothing was changed' }
  }
  for (const model of models) {
    if (existing.some((entry) => entry.id === model.id)) continue
    added.push(model.id)
    kept.push({
      id: model.id,
      contextWindow: model.contextWindow,
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      input: [...model.input],
    })
  }
  for (const model of models) {
    if (model.contextNote !== undefined) warnings.push(`${clean(model.id, 80)}: ${model.contextNote}`)
  }
  const changed = added.length > 0 || contextChanges.length > 0 || maxTokensChanges.length > 0 || (mode === 'manual' && removed.length > 0)
  return {
    provider,
    mode,
    route: { ...route, models: kept },
    changed,
    added,
    removed,
    pendingRemovals,
    contextChanges,
    maxTokensChanges,
    retained,
    warnings,
  }
}

/**
 * A deterministic signature of one plan: the provider, the mode, the target provider entry
 * as it was read, and the proposed `models` list. Unrelated network fields and unrelated
 * providers never enter it, so a preview's signature still matches when only those changed.
 * @returns a string.
 */
export function planSignature(plan, before) {
  return JSON.stringify({
    provider: plan.provider,
    mode: plan.mode,
    before: isRecord(before)
      ? { api: before.api ?? null, baseURL: before.baseURL ?? null, models: Array.isArray(before.models) ? before.models.map((model) => (isRecord(model) ? model.id : null)) : null }
      : null,
    after: plan.route.models.map((model) => [model.id, model.contextWindow, model.maxTokens ?? null]),
  })
}
