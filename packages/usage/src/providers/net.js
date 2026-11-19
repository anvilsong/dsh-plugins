/**
 * Shared HTTP + error taxonomy for the usage provider modules.
 *
 * Every provider fetch returns one of:
 *   { body }                            success, parsed JSON object
 *   { failure, status?, detail }        failure code + operator-readable text
 *
 * Failure codes: missing-credential, credential-read-failed, timeout,
 * network, bad-response, http-<status>. The panel prints `detail` verbatim.
 */

export function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length > 0) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Clamp a configured millisecond value into a safe range. */
export function clampMs(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** The prototype marker the Gateway's SRC discovery reads. */
export const REMOTE_METHOD_MARKER = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** Best-effort operator-facing message from an error reply body. */
export function errorMessage(body, status) {
  if (isRecord(body)) {
    const err = isRecord(body.error) ? body.error : null
    const text = (err && (err.message || err.type)) || body.message || body.msg
    if (typeof text === 'string' && text.length > 0) return `HTTP ${status}: ${text}`
  }
  return `HTTP ${status}`
}

/**
 * Resolve a credential and GET one JSON endpoint, with the shared error
 * taxonomy. `auth` selects the header shape: 'bearer' (default) sends
 * `Authorization: Bearer <key>`; 'raw' sends the key bare (GLM coding plan).
 * Extra provider headers go in `headers`. `signIn` names the OAuth provider id
 * (`openai-codex`, `anthropic`): a missing credential then says how to sign in
 * instead of asking for an API key.
 */
export async function fetchUsageJson(ctx, { credentialRef, recordKey, url, auth = 'bearer', headers = {}, timeoutMs, hint401, signIn }) {
  let key
  try {
    if (recordKey) {
      const record = await ctx.credentials.readRecord(recordKey)
      const payload = record?.payload
      key = typeof payload?.access === 'string' ? payload.access.trim() : typeof payload?.apiKey === 'string' ? payload.apiKey.trim() : ''
    } else {
      const record = await ctx.credentials.resolve(credentialRef)
      key = record && typeof record.value === 'string' ? record.value.trim() : ''
    }
  } catch (error) {
    return { failure: 'credential-read-failed', detail: `Could not read ${recordKey ?? credentialRef}: ${String(error?.message ?? error)}` }
  }
  if (!key) {
    const ref = recordKey ?? credentialRef
    return {
      failure: 'missing-credential',
      detail: signIn
        ? `No sign-in found for ${ref}. Sign in from Settings → Models or run /provider-login ${signIn}.`
        : `No value for ${ref}. Add the API key in Settings → Models.`,
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: auth === 'raw' ? key : `Bearer ${key}`, ...headers, Accept: 'application/json' },
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timer)
    const aborted = error?.name === 'AbortError'
    return {
      failure: aborted ? 'timeout' : 'network',
      detail: aborted ? `No reply within ${timeoutMs} ms.` : String(error?.message ?? error),
    }
  }

  let body
  try {
    body = await response.json()
  } catch {
    clearTimeout(timer)
    return {
      failure: controller.signal.aborted ? 'timeout' : 'bad-response',
      status: response.status,
      detail: controller.signal.aborted
        ? `No reply within ${timeoutMs} ms.`
        : `HTTP ${response.status} with a body that is not JSON.`,
    }
  }
  clearTimeout(timer)

  if (!response.ok) {
    let detail = errorMessage(body, response.status)
    if (response.status === 401 && hint401) detail += ' ' + hint401
    return { failure: `http-${response.status}`, status: response.status, detail }
  }
  if (!isRecord(body)) {
    return { failure: 'bad-response', status: response.status, detail: 'Reply was not a JSON object.' }
  }
  return { body }
}

/** Clock time as the text reports print it. */
function clock(ms) {
  return new Date(ms).toLocaleTimeString()
}

/**
 * The footer every text report ends with, as lines.
 *
 * `fetchedAt` is the last GOOD read; `attemptedAt` the last attempt. The
 * warning appears while the last attempt is a failure (status 'error', or
 * 'loading' with the failure still on the state). A state from an older host
 * has no `attemptedAt`: the warning then falls back to `fetchedAt`.
 */
export function usageFooter(state) {
  const lines = [state.fetchedAt ? `Last good read: ${clock(state.fetchedAt)}` : 'Last good read: never']
  if (state.status === 'error' || state.error) {
    const at = state.attemptedAt ?? state.fetchedAt
    lines.push(`Warning: last refresh failed${at ? ` at ${clock(at)}` : ''} (${state.error}): ${state.detail ?? ''}`.trim())
  }
  return lines
}

/**
 * The shared provider runtime: cache, publish, single-flight refresh,
 * Remote service provide, command register, poll timer.
 *
 * @param ctx     plugin context
 * @param spec    { id, serviceKey, commandName, commandDescription, formatReport, fetchState }
 *                fetchState(cfg) → { endpoint, data } | { failure, status?, detail }
 * @param cfg     the provider's config section (already defaults-merged)
 */
export function mountProvider(ctx, spec, cfg) {
  const refreshMs = clampMs(cfg.refreshMs, 120_000, 30_000, 3_600_000)
  const timeoutMs = clampMs(cfg.timeoutMs, 15_000, 5_000, 120_000)

  const cache = {
    state: {
      status: 'idle',
      // fetchedAt: the last GOOD read. attemptedAt: the last attempt, good or not.
      fetchedAt: null,
      attemptedAt: null,
      error: null,
      detail: null,
      endpoint: spec.endpoint ?? null,
      data: null,
      ui: {
        composerChip: cfg.showComposerChip ?? true,
        // Which model-provider ids unhide the composer chip. Config wins over
        // the module default; the client falls back to its own table.
        gate: Array.isArray(cfg.gate) ? cfg.gate : (spec.defaultGate ?? null),
      },
    },
    listeners: new Set(),
  }

  function publish(patch) {
    cache.state = { ...cache.state, ...patch }
    for (const listener of cache.listeners) {
      try {
        listener(cache.state)
      } catch {
        // A broken listener must not stop the others, nor the refresh loop.
      }
    }
  }

  /** The refresh in progress, shared by every caller that arrives meanwhile. */
  let flight = null

  /**
   * Fetch once and publish the outcome; the last good data and fetchedAt
   * survive a failure. A caller that arrives while a refresh is in flight gets
   * that flight's final state, never the transient 'loading'.
   */
  function refresh() {
    if (flight) return flight
    flight = run().finally(() => {
      flight = null
    })
    return flight
  }

  async function run() {
    // error and detail keep their last values while loading.
    publish({ status: 'loading' })
    try {
      const result = await spec.fetchState(ctx, { ...cfg, timeoutMs })
      const now = Date.now()
      if (result.failure) {
        publish({
          status: 'error',
          error: result.failure,
          detail: result.detail ?? null,
          attemptedAt: now,
        })
      } else {
        publish({
          status: 'ready',
          error: null,
          detail: null,
          endpoint: result.endpoint ?? cache.state.endpoint,
          data: result.data,
          fetchedAt: now,
          attemptedAt: now,
        })
      }
    } catch (error) {
      publish({ status: 'error', error: 'unexpected', detail: String(error?.message ?? error), attemptedAt: Date.now() })
    }
    return cache.state
  }

  // The Remote service: a class instance with the frozen, versioned prototype
  // marker the Gateway's SRC discovery reads — the same shape the shipped
  // TypertRemoteService base produces, hand-written so no codegen is involved.
  class UsageApi {
    snapshot() {
      return cache.state
    }
    refresh() {
      return refresh()
    }
  }
  Object.defineProperty(UsageApi.prototype, REMOTE_METHOD_MARKER, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze([
        Object.freeze({ method: 'snapshot', invocation: Object.freeze({ kind: 'direct' }) }),
        Object.freeze({ method: 'refresh', invocation: Object.freeze({ kind: 'direct' }) }),
      ]),
    }),
  })
  const api = new UsageApi()
  api.typertRemote = Object.freeze({ service: api, serviceKey: spec.serviceKey, namespace: spec.serviceKey })

  ctx.provide(spec.serviceKey, api)

  ctx.commands.register({
    definitionId: `dsh-plugin-provider-usage/${spec.commandName}`,
    name: spec.commandName,
    description: spec.commandDescription,
    handler: async () => {
      const state = await refresh()
      if (state.status === 'error' && !state.data) {
        return { kind: 'error', text: `${spec.title} usage unavailable: ${state.detail ?? state.error}` }
      }
      return { kind: 'success', text: spec.formatReport(state) }
    },
  })

  ctx.effect(() => {
    let cancelled = false
    const tick = () => {
      if (!cancelled) void refresh()
    }
    const initial = setTimeout(tick, 1_000)
    const interval = setInterval(tick, refreshMs)
    return () => {
      cancelled = true
      clearTimeout(initial)
      clearInterval(interval)
    }
  }, `usage: poll ${spec.id}`)
}
