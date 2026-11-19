import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { mountOpenRouter } from '../src/providers/openrouter.js'

// OpenRouter (openrouter.js runtime): /api/v1/key for an ordinary key,
// /api/v1/credits for a management key. fetch is stubbed in every test and
// restored in finally; the after() hook proves the real fetch is back. No
// report footer and no timestamps are asserted (test/stale-state.test.mjs).

const REAL_FETCH = globalThis.fetch
after(() => {
  assert.equal(globalThis.fetch, REAL_FETCH, 'a test leaked its fetch stub')
})

const KEY_URL = 'https://openrouter.ai/api/v1/key'
const CREDITS_URL = 'https://openrouter.ai/api/v1/credits'

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const html = (status) => new Response('<html>gateway</html>', { status, headers: { 'Content-Type': 'text/html' } })
const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })

/**
 * Mount OpenRouter on a fake ctx. `resolve` is the credentials.resolve
 * implementation; `handler(url, init)` answers each fetch. showAccount is off
 * unless a test asks for it, so one reply serves the refresh.
 */
async function run({ config = { showAccount: false }, resolve, handler }, fn) {
  const calls = []
  const resolved = []
  let api
  let command
  const ctx = {
    credentials: {
      resolve: async (ref) => {
        resolved.push(ref)
        if (resolve) return resolve(ref)
        return { value: 'or-key' }
      },
      readRecord: async () => undefined,
    },
    provide(key, value) { if (key === 'openrouterUsage') api = value },
    commands: { register(value) { command = value } },
    effect() {},
  }
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (!handler) throw new Error('unexpected fetch')
    return handler(String(url), init)
  }
  try {
    mountOpenRouter(ctx, config)
    await fn({ api, command, calls, resolved })
  } finally {
    globalThis.fetch = REAL_FETCH
  }
}

const KEY_REPLY = {
  data: {
    label: 'sk-or-v1-abc',
    usage: 12.5,
    usage_daily: 1.25,
    usage_weekly: 4.5,
    usage_monthly: 9,
    byok_usage: 0.75,
    limit: 50,
    limit_remaining: 37.5,
    limit_reset: 'monthly',
    is_free_tier: false,
    is_management_key: false,
    expires_at: '2027-01-01T00:00:00Z',
    free_model_daily_requests: null,
  },
}

test('OpenRouter happy path: /key reply becomes the flat key-scope data', async () => {
  await run({ handler: () => json(KEY_REPLY) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'ready')
    assert.deepEqual(state.data, {
      scope: 'key',
      label: 'sk-or-v1-abc',
      usage: 12.5,
      usageDaily: 1.25,
      usageWeekly: 4.5,
      usageMonthly: 9,
      byokUsage: 0.75,
      limit: 50,
      remaining: 37.5,
      limitReset: 'monthly',
      isFreeTier: false,
      isManagementKey: false,
      expiresAt: '2027-01-01T00:00:00Z',
      freeModels: null,
      totalCredits: null,
      totalUsage: null,
    })
    assert.deepEqual(state.account, { status: 'unavailable', data: null, error: null, detail: null })
  })
})

test('OpenRouter asks GET /key with a Bearer key resolved from OPENROUTER_API_KEY', async () => {
  await run({ resolve: () => ({ value: 'or-secret' }), handler: () => json(KEY_REPLY) }, async (h) => {
    await h.api.refresh()
    assert.deepEqual(h.resolved, ['OPENROUTER_API_KEY'])
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].url, KEY_URL)
    assert.equal(h.calls[0].init.method, 'GET')
    assert.equal(h.calls[0].init.headers.Authorization, 'Bearer or-secret')
    assert.equal(h.calls[0].init.headers.Accept, 'application/json')
  })
})

test('OpenRouter: limit null (an uncapped key) survives as null, not 0', async () => {
  const body = { data: { label: 'free', usage: 0.5, limit: null, limit_remaining: null, is_free_tier: true, free_model_daily_requests: { daily_limit: 50 } } }
  await run({ handler: () => json(body) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.data.limit, null)
    assert.equal(state.data.remaining, null)
    assert.equal(state.data.isFreeTier, true)
    assert.deepEqual(state.data.freeModels, { daily_limit: 50 })
    assert.equal(state.data.usageDaily, null)
  })
})

test('OpenRouter with showAccount: /credits success adds the account balance beside the key data', async () => {
  await run({
    config: { showAccount: true },
    handler: (url) => (url === KEY_URL ? json(KEY_REPLY) : json({ data: { total_credits: 100, total_usage: 25.5 } })),
  }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'ready')
    assert.deepEqual(h.calls.map((c) => c.url), [KEY_URL, CREDITS_URL])
    assert.equal(h.calls[1].init.headers.Authorization, h.calls[0].init.headers.Authorization, 'the same key')
    assert.equal(state.data.scope, 'key')
    assert.deepEqual(state.account, { status: 'ready', data: { totalCredits: 100, totalUsage: 25.5, remaining: 74.5 }, error: null, detail: null })
  })
})

test('OpenRouter keeps the key data when /credits answers 403 and reports management-key-required', async () => {
  await run({
    config: { showAccount: true },
    handler: (url) => (url === KEY_URL ? json(KEY_REPLY) : json({ error: { message: 'Only management keys can perform this operation' } }, 403)),
  }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'ready', 'a refused account call is not an error')
    assert.equal(state.error, null)
    assert.equal(state.data.scope, 'key')
    assert.equal(state.data.usage, 12.5)
    assert.equal(state.data.limit, 50)
    assert.deepEqual(state.account, {
      status: 'error',
      data: null,
      error: 'management-key-required',
      detail: 'Only management keys can perform this operation',
    })
    const report = await h.command.handler({})
    assert.equal(report.kind, 'success')
    assert.match(report.text, /Used \(lifetime\): \$12\.50/)
    assert.match(report.text, /Account balance: needs a management key \(ordinary key refused\)\./)
  })
})

test('OpenRouter: a /credits failure other than 403 is kept on the account, key data still ready', async () => {
  await run({
    config: { showAccount: true },
    handler: (url) => (url === KEY_URL ? json(KEY_REPLY) : json({}, 500)),
  }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'ready')
    assert.equal(state.account.status, 'error')
    assert.equal(state.account.error, 'http-500')
    assert.equal(state.account.detail, 'HTTP 500')
  })
})

test('OpenRouter endpoint credits: the whole panel is account scope from /credits only', async () => {
  await run({
    config: { endpoint: 'credits', showAccount: true },
    handler: () => json({ data: { total_credits: 40, total_usage: 10 } }),
  }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'ready')
    assert.deepEqual(h.calls.map((c) => c.url), [CREDITS_URL], 'no second account call in account scope')
    assert.deepEqual(state.data, {
      scope: 'account',
      label: null,
      usage: 10,
      usageDaily: null,
      usageWeekly: null,
      usageMonthly: null,
      byokUsage: null,
      limit: 40,
      remaining: 30,
      limitReset: null,
      isFreeTier: false,
      isManagementKey: true,
      expiresAt: null,
      freeModels: null,
      totalCredits: 40,
      totalUsage: 10,
    })
  })
})

test('OpenRouter: a 403 on the primary call is management-key-required with the message', async () => {
  await run({ config: { endpoint: 'credits', showAccount: false }, handler: () => json({ error: { message: 'management key required' } }, 403) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'management-key-required')
    assert.equal(state.detail, 'management key required')
    assert.equal(state.data, null)
  })
})

test('OpenRouter report: key scope lines with meters, key limit and BYOK usage', async () => {
  await run({ handler: () => json(KEY_REPLY) }, async (h) => {
    await h.api.refresh()
    const report = await h.command.handler({})
    assert.equal(report.kind, 'success')
    const lines = report.text.split('\n')
    assert.equal(lines[0], 'OpenRouter usage')
    assert.ok(lines.includes('Key: sk-or-v1-abc'))
    assert.ok(lines.includes('Used (lifetime): $12.50'))
    assert.ok(lines.includes('Meters: today $1.25 · this week $4.50 · this month $9.00'))
    assert.ok(lines.includes('BYOK usage: $0.75'))
    assert.ok(lines.includes('Key limit: $50.00 · remaining $37.50 · resets monthly'))
  })
})

test('OpenRouter: a reply with no data object is bad-response', async () => {
  await run({ handler: () => json({ nope: true }) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'bad-response')
    assert.equal(state.detail, 'Reply carried no data object.')
  })
})

// --- failure taxonomy for the openrouter.js runtime ---

test('OpenRouter failure: a missing credential names the reference and makes no request', async () => {
  for (const missing of [undefined, { value: '' }]) {
    await run({ resolve: () => missing, handler: () => json(KEY_REPLY) }, async (h) => {
      const state = await h.api.refresh()
      assert.equal(state.status, 'error')
      assert.equal(state.error, 'missing-credential')
      assert.equal(state.detail, 'No value for OPENROUTER_API_KEY. Add an OpenRouter API key in Settings → Models.')
      assert.equal(h.calls.length, 0)
      const result = await h.command.handler({})
      assert.equal(result.kind, 'error')
      assert.match(result.text, /^OpenRouter usage unavailable: No value for OPENROUTER_API_KEY/)
    })
  }
})

test('OpenRouter failure: a credential read failure carries the reason and makes no request', async () => {
  await run({
    resolve: () => { throw new Error('keychain locked') },
    handler: () => json(KEY_REPLY),
  }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'credential-read-failed')
    assert.equal(state.detail, 'keychain locked')
    assert.equal(h.calls.length, 0)
  })
})

test('OpenRouter failure: HTTP 401 is http-401 with the server message (this runtime has no extra hint)', async () => {
  await run({ handler: () => json({ error: { message: 'No auth credentials found' } }, 401) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'http-401')
    assert.equal(state.detail, 'No auth credentials found')
    assert.equal(state.data, null)
  })
  await run({ handler: () => json({}, 401) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.detail, 'HTTP 401', 'no message in the body: the status text')
  })
})

test('OpenRouter failure: a body that is not JSON is bad-response with the status', async () => {
  await run({ handler: () => html(502) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'bad-response')
    assert.equal(state.detail, 'HTTP 502 with a body that is not JSON.')
  })
})

test('OpenRouter failure: an AbortError is timeout', async () => {
  await run({ handler: () => { throw abortError() } }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'timeout')
    assert.equal(state.detail, 'No reply within 15000 ms.')
  })
})

test('OpenRouter failure: a hung reply is aborted by the timeout budget (mock timers, no real wait)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await run({
    config: { showAccount: false, timeoutMs: 7000 },
    handler: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(abortError()))
    }),
  }, async (h) => {
    const pending = h.api.refresh()
    await new Promise((resolve) => setImmediate(resolve))
    t.mock.timers.tick(7000)
    const state = await pending
    assert.equal(state.error, 'timeout')
    assert.equal(state.detail, 'No reply within 7000 ms.')
  })
})

test('OpenRouter failure: a network error is network with the message', async () => {
  await run({ handler: () => { throw new TypeError('fetch failed') } }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'network')
    assert.equal(state.detail, 'fetch failed')
  })
})

// --- known drift: desired behaviour, failing today ---

test('OpenRouter renamed /key fields should become bad-response', { todo: 'today: status ready, every figure null (usage, limit, remaining), label null' }, async () => {
  const renamed = { data: { name: 'k', spent: 12.5, cap: 50, cap_remaining: 37.5 } }
  await run({ handler: () => json(renamed) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'bad-response')
  })
})
