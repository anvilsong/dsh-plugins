/**
 * OpenRouter usage plugin — Host half.
 *
 * Responsibilities, in order:
 *   1. Resolve the OpenRouter API key through the credentials service on every
 *      call. The service documents resolution as per-call and never cached, so a
 *      key rotated in Settings → Models reaches the next refresh without a
 *      restart. We must not hold the resolved value across calls.
 *   2. Call OpenRouter and normalize the reply into one flat shape.
 *   3. Publish that shape as a Typert Remote service the browser half calls
 *      through `ctx.remote.openrouterUsage`.
 *
 * The service exposes two zero-argument Remote methods:
 *   - `snapshot`  the current cached state (no OpenRouter call).
 *   - `refresh`   resolve the key, call OpenRouter, publish, return the state.
 *
 * Zero-argument methods need no parameter codecs, so the Gateway's conservative
 * SRC path can resolve them without generated schemas. The return values are
 * plain JSON objects, which is all the wire carries.
 *
 * Two endpoints are supported and they are NOT interchangeable:
 *   - /api/v1/key      works with an ordinary key; per-key scope.
 *   - /api/v1/credits  requires a MANAGEMENT key; account-wide scope.
 * The plugin asks for whichever is configured and reports the refusal verbatim
 * rather than masking it, because "403 management key required" is the answer
 * the operator needs.
 */

import {
  DEFAULT_CREDENTIAL_REF,
  DEFAULT_REFRESH_MS,
  DEFAULT_SHOW_ACCOUNT,
  DEFAULT_TIMEOUT_MS,
  ENDPOINT_CREDITS,
  ENDPOINT_KEY,
} from './openrouter-defaults.js'
import { cleanDetail, mountSurfaces, requestJson, safeMessage, usageFooter } from './net.js'


/**
 * Normalize a numeric field, tolerating null and undefined.
 * OpenRouter sends `limit: null` for an uncapped key, which is meaningful and
 * must survive as null rather than collapsing to 0.
 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Build the panel state from a /api/v1/key reply.
 *
 * @param data the `data` object of the reply.
 */
function fromKey(data) {
  const usage = num(data.usage)
  const limit = num(data.limit)
  const remaining = num(data.limit_remaining)

  return {
    scope: 'key',
    label: typeof data.label === 'string' ? data.label : null,
    usage,
    usageDaily: num(data.usage_daily),
    usageWeekly: num(data.usage_weekly),
    usageMonthly: num(data.usage_monthly),
    byokUsage: num(data.byok_usage),
    limit,
    remaining,
    limitReset: typeof data.limit_reset === 'string' ? data.limit_reset : null,
    isFreeTier: data.is_free_tier === true,
    isManagementKey: data.is_management_key === true,
    expiresAt: typeof data.expires_at === 'string' ? data.expires_at : null,
    freeModels: data.free_model_daily_requests ?? null,
    totalCredits: null,
    totalUsage: null,
  }
}

/** Build the account section from a /api/v1/credits reply. */
function accountFromCredits(data) {
  const totalCredits = num(data.total_credits)
  const totalUsage = num(data.total_usage)

  // The credits endpoint reports purchased and used totals; the difference is
  // the account-wide remaining balance.
  const remaining =
    totalCredits !== null && totalUsage !== null ? totalCredits - totalUsage : null

  return { totalCredits, totalUsage, remaining }
}

/** Build the flat panel state when the whole panel runs in account scope. */
function fromCredits(data) {
  const a = accountFromCredits(data)
  return {
    scope: 'account',
    label: null,
    usage: a.totalUsage,
    usageDaily: null,
    usageWeekly: null,
    usageMonthly: null,
    byokUsage: null,
    limit: a.totalCredits,
    remaining: a.remaining,
    limitReset: null,
    isFreeTier: false,
    isManagementKey: true,
    expiresAt: null,
    freeModels: null,
    totalCredits: a.totalCredits,
    totalUsage: a.totalUsage,
  }
}

/** Read the `message` out of an OpenRouter error body, when it has one. */
function errorMessage(body, status) {
  const message = body?.error?.message
  if (typeof message === 'string' && message.length > 0) return message
  return `HTTP ${status}`
}

/**
 * One GET against OpenRouter through the shared request function (net.js
 * requestJson: same-origin redirects only, 1 MiB cap, the timeout covering the
 * body read, the key redacted from the reply). The failure mapping stays
 * OpenRouter's own: 403 is management-key-required.
 * @returns the parsed body, or an object describing the failure.
 */
async function getOpenRouter(url, key, timeoutMs) {
  const reply = await requestJson(url, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
    },
    timeoutMs,
  })
  if (reply.failure !== undefined) return reply
  if (reply.notJson) {
    return { failure: 'bad-response', status: reply.status, detail: `HTTP ${reply.status} with a body that is not JSON.` }
  }

  if (!reply.ok) {
    return {
      failure: reply.status === 403 ? 'management-key-required' : `http-${reply.status}`,
      status: reply.status,
      detail: errorMessage(reply.body, reply.status),
    }
  }

  const data = reply.body?.data
  if (!data || typeof data !== 'object') {
    return { failure: 'bad-response', status: reply.status, detail: 'Reply carried no data object.' }
  }
  return { data }
}

/** Clamp a configured millisecond value into a safe range. */
function clampMs(value, fallback, min, max) {
  const n = Number(value)
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** Format a dollar figure for the command report; null becomes an em dash. */
function usd(value) {
  return value === null ? '—' : `$${value.toFixed(2)}`
}

/**
 * Render the `/usage-openrouter` report as plain text. Lines with no data are
 * omitted, so a free-tier key and a limited key read differently.
 */
function formatReport(state) {
  const lines = ['OpenRouter usage']
  const d = state.data
  if (d) {
    const title = d.label ? `Key: ${d.label}` : d.scope === 'account' ? 'Account scope (management key)' : 'Key scope'
    lines.push(title)
    if (d.scope === 'key') {
      lines.push(`Used (lifetime): ${usd(d.usage)}`)
      const meters = []
      if (d.usageDaily !== null) meters.push(`today ${usd(d.usageDaily)}`)
      if (d.usageWeekly !== null) meters.push(`this week ${usd(d.usageWeekly)}`)
      if (d.usageMonthly !== null) meters.push(`this month ${usd(d.usageMonthly)}`)
      if (meters.length > 0) lines.push(`Meters: ${meters.join(' · ')}`)
      if (d.byokUsage !== null && d.byokUsage > 0) lines.push(`BYOK usage: ${usd(d.byokUsage)}`)
      if (d.limit !== null) {
        lines.push(`Key limit: ${usd(d.limit)} · remaining ${usd(d.remaining)}${d.limitReset ? ` · resets ${d.limitReset}` : ''}`)
      }
      if (d.isFreeTier && d.freeModels && typeof d.freeModels === 'object') {
        lines.push(`Free tier: ${d.freeModels.daily_limit ?? '?'} requests/day on :free models`)
      }
    } else {
      lines.push(`Credits purchased: ${usd(d.totalCredits)} · used: ${usd(d.totalUsage)} · remaining: ${usd(d.remaining)}`)
    }
  }
  const a = state.account
  if (a && a.status === 'ready' && a.data) {
    lines.push(`Account: credits ${usd(a.data.totalCredits)} · used ${usd(a.data.totalUsage)} · left ${usd(a.data.remaining)}`)
  } else if (a && a.status === 'error' && a.error === 'management-key-required') {
    lines.push('Account balance: needs a management key (ordinary key refused).')
  }
  lines.push(...usageFooter(state))
  return lines.join('\n')
}

/**
 * The prototype marker the Gateway's SRC discovery reads. Frozen, versioned,
 * and shaped exactly like the markers the shipped `TypertRemoteService` base
 * produces — but hand-written, so no build-time codegen is involved.
 */
const REMOTE_METHOD_MARKER = '@deepseek-ai/dsh-typert-protocol/remote-methods'

export function mountOpenRouter(ctx, config = {}) {
  const credentialRef = config.credentialRef ?? DEFAULT_CREDENTIAL_REF
  // Primary scope: `credits` switches the whole panel to the account view.
  const endpoint = config.endpoint === 'credits' ? ENDPOINT_CREDITS : ENDPOINT_KEY
  // `showAccount`: also fetch /api/v1/credits with the SAME key and render the
  // account balance beside the key figures. 403 for an ordinary key renders as
  // a plain note, not an error.
  const showAccount = config.showAccount ?? DEFAULT_SHOW_ACCOUNT
  // Clamps: a billing endpoint polled at 0 ms hammers OpenRouter; a timeout of
  // 0 ms aborts every call. Defaults sit well inside both ranges.
  const refreshMs = clampMs(config.refreshMs, DEFAULT_REFRESH_MS, 30_000, 3_600_000)
  const timeoutMs = clampMs(config.timeoutMs, DEFAULT_TIMEOUT_MS, 5_000, 120_000)

  // `showComposerChip`: whether the browser half renders the compact usage
  // chip below the composer card. It rides the state as `ui.composerChip`,
  // because the row config lives on the Host and the Client never sees it.
  const showComposerChip = config.showComposerChip ?? true

  const cache = {
    state: {
      status: 'idle',
      // fetchedAt: the last GOOD read. attemptedAt: the last attempt, good or not.
      fetchedAt: null,
      attemptedAt: null,
      error: null,
      detail: null,
      data: null,
      account: { status: 'unavailable', data: null, error: null, detail: null },
      ui: { composerChip: showComposerChip },
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

  /**
   * One refresh at a time: an interval tick, a button press and the command
   * share this. A caller that arrives mid-flight gets that flight's final
   * state, never the transient 'loading'.
   */
  let flight = null

  /**
   * Fetch once and publish the outcome.
   *
   * Every failure path publishes `status: 'error'` with a code and a
   * human-readable `detail`. The last good numbers stay in `data`, so the panel
   * can show them next to the error and state how old they are.
   *
   * The key section and the account section are independent: a refused account
   * call never hides the key figures.
   *
   * `fetchedAt` stays the time of the last GOOD read; a failure moves only
   * `attemptedAt`. `error` and `detail` keep their last values while loading.
   *
   * @returns the current state after the attempt.
   */
  function refresh() {
    if (flight) return flight
    flight = run().finally(() => {
      flight = null
    })
    return flight
  }

  async function run() {
    publish({ status: 'loading' })
    // A catch-all, like the shared runtime in net.js: whatever else throws
    // (a credential object with a throwing getter, an odd reply) ends in an
    // error state instead of leaving 'loading' behind and rejecting the
    // refresh, the command and the poll tick.
    try {
      return await attempt()
    } catch (error) {
      publish({ status: 'error', error: 'unexpected', detail: cleanDetail(safeMessage(error)), attemptedAt: Date.now() })
      return cache.state
    }
  }

  // Every detail below goes through cleanDetail: one line, at most 300
  // characters. requestJson has already redacted the key from the reply and
  // from its own failure texts.
  async function attempt() {

    // Step 1 — resolve the key. Per-call read, never cached.
    let resolved
    try {
      resolved = await ctx.credentials.resolve(credentialRef)
    } catch (error) {
      publish({
        status: 'error',
        error: 'credential-read-failed',
        detail: cleanDetail(safeMessage(error)),
        attemptedAt: Date.now(),
      })
      return cache.state
    }

    if (!resolved || typeof resolved.value !== 'string' || resolved.value.length === 0) {
      // The credentials service treats an empty stored value as absent, so this
      // branch covers both "never set" and "set to blank".
      publish({
        status: 'error',
        error: 'missing-credential',
        detail: `No value for ${credentialRef}. Add an OpenRouter API key in Settings → Models.`,
        attemptedAt: Date.now(),
      })
      return cache.state
    }

    // Step 2 — primary call.
    const primary = await getOpenRouter(endpoint, resolved.value, timeoutMs)
    if (primary.failure !== undefined) {
      publish({
        status: 'error',
        error: primary.failure,
        detail: cleanDetail(primary.detail),
        attemptedAt: Date.now(),
      })
      return cache.state
    }

    // Step 3 — account call with the SAME key, independent of the primary.
    let account = { status: 'unavailable', data: null, error: null, detail: null }
    if (showAccount && endpoint === ENDPOINT_KEY) {
      const credits = await getOpenRouter(ENDPOINT_CREDITS, resolved.value, timeoutMs)
      if (credits.data !== undefined) {
        account = { status: 'ready', data: accountFromCredits(credits.data), error: null, detail: null }
      } else {
        account = {
          status: 'error',
          data: null,
          // An ordinary key is expected here: the refusal is information,
          // not a fault. The panel renders it as a note.
          error: credits.failure,
          detail: cleanDetail(credits.detail),
        }
      }
    }

    const data = endpoint === ENDPOINT_CREDITS ? fromCredits(primary.data) : fromKey(primary.data)
    // No numeric usage, limit or remaining means renamed fields, not an empty
    // account. A free key (usage 0, limit null) still has a numeric usage.
    if (data.usage === null && data.limit === null && data.remaining === null) {
      publish({
        status: 'error',
        error: 'bad-response',
        detail: 'Reply carried no numeric usage, limit or remaining figure.',
        attemptedAt: Date.now(),
      })
      return cache.state
    }

    const now = Date.now()
    publish({
      status: 'ready',
      error: null,
      detail: null,
      fetchedAt: now,
      attemptedAt: now,
      data,
      account,
    })
    return cache.state
  }

  /**
   * The Remote service the browser half calls through
   * `ctx.remote.openrouterUsage`.
   *
   * Methods are zero-argument and closure-based (they never read `this`),
   * because the Gateway invokes them with a shadowed `this` bound to a
   * per-call Context.
   */
  class OpenRouterUsageApi {
    /** The current cached state. No OpenRouter call. */
    async snapshot() {
      return cache.state
    }

    /** Resolve, call OpenRouter, publish, and return the state. */
    async refresh() {
      return refresh()
    }
  }

  Object.defineProperty(OpenRouterUsageApi.prototype, REMOTE_METHOD_MARKER, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze([
        Object.freeze({ method: 'snapshot', invocation: Object.freeze({ kind: 'direct' }) }),
        Object.freeze({ method: 'refresh', invocation: Object.freeze({ kind: 'direct' }) }),
      ]),
    }),
  })

  const api = new OpenRouterUsageApi()
  // The visible Gateway binding. The Gateway's SRC discovery reads exactly
  // these three fields; the shape mirrors what `TypertRemoteService` produces.
  api.typertRemote = Object.freeze({
    service: api,
    serviceKey: 'openrouterUsage',
    namespace: 'openrouterUsage',
  })

  // The `/usage-openrouter` report command. The handler refreshes first, so
  // the report is never a stale read. A failed refresh with no cached data is
  // a command error; a failed refresh WITH cached data reports the numbers
  // plus a warning line.
  mountSurfaces(ctx, {
    id: 'openrouter',
    serviceKey: 'openrouterUsage',
    api,
    command: {
      definitionId: 'dsh-plugin-openrouter-usage/usage-openrouter',
      name: 'usage-openrouter',
      description: 'OpenRouter credit balance and per-key usage meters',
      handler: async () => {
        const state = await refresh()
        if (state.status === 'error' && !state.data) {
          return { kind: 'error', text: `OpenRouter usage unavailable: ${state.detail ?? state.error}` }
        }
        return { kind: 'success', text: formatReport(state) }
      },
    },
    poll: () => {
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
    },
  })
}
