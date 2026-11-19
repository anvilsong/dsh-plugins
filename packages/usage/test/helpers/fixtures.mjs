/**
 * Fake provider states for the gallery and the harness tests. Every shape
 * follows what the Host half publishes through each provider's Remote
 * `snapshot`/`refresh` (status envelope plus provider data); the values are
 * invented. Fetch time and reset times are fixed so the output is stable.
 */

export const FETCHED_AT = Date.UTC(2026, 10, 18, 14, 30, 0)
/** When the failed refresh after the good read at FETCHED_AT ran: 7 minutes later. */
export const FAILED_AT = FETCHED_AT + 7 * 60_000
const hours = (count) => new Date(FETCHED_AT + count * 3_600_000).toISOString()

/**
 * The status envelope around a provider's data. Like the Host: `fetchedAt` is
 * the last GOOD read, `attemptedAt` the last attempt (equal after a success).
 */
export function envelope(data, patch = {}) {
  return {
    status: 'ready',
    fetchedAt: FETCHED_AT,
    attemptedAt: FETCHED_AT,
    error: null,
    detail: null,
    endpoint: null,
    data,
    ui: { composerChip: true, gate: null },
    ...patch,
  }
}

/** No good read yet: no data and no read times. */
function withoutData(state) {
  const { account, ...rest } = state
  return { ...rest, data: null, fetchedAt: null, attemptedAt: null }
}

/**
 * The same envelope after a failed read: last good data and fetchedAt kept
 * (or no good read at all), attemptedAt moved to the failure.
 */
export function failed(state, { error = 'http-429', detail = 'HTTP 429: Rate limit exceeded. Try again in 30 seconds.', keepData = true, attemptedAt = FAILED_AT } = {}) {
  return { ...(keepData ? state : withoutData(state)), status: 'error', error, detail, attemptedAt }
}

/** The same envelope while a refresh is running (error and detail stay, like the Host). */
export function loading(state, { keepData = true } = {}) {
  return { ...(keepData ? state : withoutData(state)), status: 'loading' }
}

/** The same state as an older Host publishes it: no `attemptedAt` field. */
export function olderHost(state) {
  const { attemptedAt, ...rest } = state
  return rest
}

/** The message of a Remote call that could not reach the Host. */
export const HOST_DOWN = 'connect ECONNREFUSED 127.0.0.1:3080'

/** A Remote-level failure: the call itself did not complete. */
export const wireFailure = () => ({
  ok: false,
  error: { code: 'remote.unavailable', message: 'The usage Remote call failed: the connection was closed.' },
})

// ---- OpenRouter ----

export function openrouter({ remaining = 37.6544, limit = 50, withAccount = true, account } = {}) {
  const state = envelope({
    scope: 'key',
    label: 'work laptop',
    usage: 12.3456,
    usageDaily: 0.42,
    usageWeekly: 3.1,
    usageMonthly: 9.87,
    byokUsage: 1.2,
    limit,
    remaining,
    limitReset: 'monthly',
    isFreeTier: false,
    isManagementKey: false,
    expiresAt: null,
    freeModels: null,
    totalCredits: null,
    totalUsage: null,
  }, { endpoint: 'https://openrouter.ai/api/v1/key' })
  state.account = withAccount
    ? { status: 'ready', data: account ?? { totalCredits: 100, totalUsage: 62.5, remaining: 37.5 }, error: null, detail: null }
    : { status: 'error', data: null, error: 'management-key-required', detail: null }
  return state
}

// ---- Kimi Code ----

export function kimi({ fiveHour = 0.42, sevenDay = 0.81, balanceCents = 1840 } = {}) {
  return envelope({
    quotas: {
      fiveHour: { usedRatio: fiveHour, resetAt: hours(4) },
      sevenDay: { usedRatio: sevenDay, resetAt: hours(70) },
      monthTotal: { usedRatio: 0.35, resetAt: hours(300) },
      monthCode: null,
    },
    extra: {
      balanceCents,
      totalCents: 5000,
      monthlyChargeLimitEnabled: true,
      monthlyChargeLimitCents: 3000,
      monthlyUsedCents: 1160,
      currency: 'USD',
    },
    requests: { limit: 300, used: 96, remaining: 204, resetAt: hours(20) },
  }, { endpoint: 'https://api.kimi.com/coding/v1/usages' })
}

// ---- GLM Coding Plan ----

export function zhipu({ fiveHour = 0.18, sevenDay = 0.64 } = {}) {
  return envelope({
    kind: 'quota',
    level: 'pro',
    windows: [
      { key: 'fiveHour', label: '5-hour window', usedRatio: fiveHour, limit: 1000, remaining: 820, resetAt: hours(3) },
      { key: 'sevenDay', label: '7-day window', usedRatio: sevenDay, limit: 5000, remaining: 1800, resetAt: hours(90) },
    ],
    prompts: {
      key: 'prompts',
      label: 'Tool calls',
      usedRatio: 0.27,
      limit: 1000,
      remaining: 730,
      resetAt: hours(200),
      details: [{ model: 'search-prime', usage: 182 }, { model: 'web-reader', usage: 88 }],
    },
  }, { endpoint: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit' })
}

// ---- DeepSeek ----

export function deepseek({ cny = 128.5, usd = 0.8 } = {}) {
  return envelope({
    kind: 'balance',
    isAvailable: true,
    balances: [
      { currency: 'CNY', total: cny, granted: 10, toppedUp: cny - 10 },
      { currency: 'USD', total: usd, granted: 0, toppedUp: usd },
    ],
  }, { endpoint: 'https://api.deepseek.com/user/balance' })
}

// ---- OpenAI Codex ----

export function codex({ primary = 0.37, secondary = 0.52 } = {}) {
  const windows = [
    { key: 'primary', label: '5-hour window', usedRatio: primary, resetAt: hours(2), windowSeconds: 18_000 },
    { key: 'secondary', label: '7-day window', usedRatio: secondary, resetAt: hours(110), windowSeconds: 604_800 },
  ]
  return envelope({
    kind: 'quota',
    quotas: { monthTotal: windows[0], monthCode: windows[1] },
    level: 'plus',
    planType: 'plus',
    windows,
    ordinaryUsageAllowed: true,
    spendControlReached: false,
    resetCreditsAvailable: 2,
    extra: { balanceCents: 500, currency: 'USD' },
    credits: { hasCredits: true, unlimited: false, balance: 5 },
  }, { endpoint: 'https://chatgpt.com/backend-api/wham/usage' })
}

// ---- Claude ----

export function anthropic({ fiveHour = 0.23, sevenDay = 0.88 } = {}) {
  const windows = [
    { key: 'fiveHour', label: '5-hour window', usedRatio: fiveHour, resetAt: hours(1) },
    { key: 'sevenDay', label: '7-day window', usedRatio: sevenDay, resetAt: hours(60) },
    { key: 'sevenDaySonnet', label: '7-day Sonnet window', usedRatio: 0.31, resetAt: hours(60) },
  ]
  return envelope({
    kind: 'quota',
    quotas: Object.fromEntries(windows.map((window) => [window.key, window])),
    windows,
    limits: [
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 55,
        usedRatio: 0.55,
        severity: 'info',
        resetAt: hours(60),
        scope: { model: { id: 'model-opus', displayName: 'Opus' }, surface: null },
        isActive: true,
      },
    ],
    extra: {
      enabled: true,
      balanceCents: 1250,
      monthlyLimitCents: 5000,
      usedRatio: 0.25,
      currency: 'USD',
      disabledReason: null,
    },
    spend: { usedMinor: 2350, currency: 'USD', exponent: 2, limitMinor: 10_000, limitCurrency: 'USD', limitExponent: 2, reached: false },
    breakdown: [{ displayName: 'Opus', percent: 55 }, { displayName: 'Sonnet', percent: 45 }],
  }, { endpoint: 'https://api.anthropic.com/api/oauth/usage' })
}

// ---- Sign-in stream events (providerLogin.begin) ----

/** A ~340-character OAuth authorize URL: it has no space, so it only wraps when told to. */
export const LONG_AUTH_URL = 'https://auth.example.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann'
  + '&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid%20profile%20email%20offline_access'
  + '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256'
  + '&state=7f3a9c1d5e8b4a2f9c0d6e1b3a5f7c9d&originator=codex_cli_rs'

/** A notice with a link and a device code. */
export const signInNotice = (patch = {}) => ({
  type: 'notice',
  notice: { message: 'Finish signing in in the browser window that opened.', url: 'https://auth.example.com/device', code: 'ABCD-1234', ...patch },
})

/** A text prompt whose message tells the user what to enter. */
export const textPromptEvent = (patch = {}) => ({
  type: 'prompt',
  id: 'prompt-2',
  prompt: { kind: 'text', message: 'Enter the organisation name', placeholder: 'organisation name', ...patch },
})

/** A readable summary of every fixture, for tests. */
export const FIXTURES = { openrouter, kimi, zhipu, deepseek, codex, anthropic }
