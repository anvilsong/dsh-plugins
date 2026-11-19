import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { mountKimi } from '../src/providers/kimi.js'

// Kimi Code (kimi.js runtime): GET {base}/usages, Bearer key, its own
// User-Agent. fetch is stubbed in every test and restored in finally; the
// after() hook proves the real fetch is back. No report footer and no
// timestamps are asserted (test/stale-state.test.mjs owns those).

const REAL_FETCH = globalThis.fetch
after(() => {
  assert.equal(globalThis.fetch, REAL_FETCH, 'a test leaked its fetch stub')
})

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const html = (status) => new Response('<html>Just a moment...</html>', { status, headers: { 'Content-Type': 'text/html' } })
const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })

const CN_URL = 'https://api.kimi.com/coding/v1/usages'
const GLOBAL_URL = 'https://api.kimi.ai/coding/v1/usages'

async function run({ config = {}, resolve, handler }, fn) {
  const calls = []
  const resolved = []
  let api
  let command
  const ctx = {
    credentials: {
      resolve: async (ref) => {
        resolved.push(ref)
        if (resolve) return resolve(ref)
        return { value: 'kimi-key' }
      },
      readRecord: async () => undefined,
    },
    provide(key, value) { if (key === 'kimiUsage') api = value },
    commands: { register(value) { command = value } },
    effect() {},
  }
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (!handler) throw new Error('unexpected fetch')
    return handler(String(url), init)
  }
  try {
    mountKimi(ctx, config)
    await fn({ api, command, calls, resolved })
  } finally {
    globalThis.fetch = REAL_FETCH
  }
}

// Extra Usage amounts are fixed-point micro-cents: 1_000_000 = 1 cent.
const REPLY = {
  usages: {
    limit_5h: { used_ratio: 0.25, reset_time: '2026-11-19T05:00:00Z' },
    limit_7d: { used_ratio: '0.5', reset_time: '2026-11-25T00:00:00Z' },
    limit_month_total: { used_ratio: 0.1 },
    limit_month_code: { used_ratio: 'x' },
  },
  boosterWallet: {
    balance: { type: 'BOOSTER', amount: 1_000_000_000, amountLeft: 250_000_000 },
    monthlyChargeLimitEnabled: true,
    monthlyChargeLimit: { priceInCents: 5000, currency: 'EUR' },
    monthlyUsed: { priceInCents: 1200, currency: 'EUR' },
  },
  usage: { limit: 100, used: 40, remaining: 60, resetTime: '2026-11-19T05:00:00Z' },
}

test('Kimi happy path: quotas, booster wallet and request counter', async () => {
  await run({ handler: () => json(REPLY) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'ready')
    assert.deepEqual(state.data, {
      quotas: {
        fiveHour: { usedRatio: 0.25, resetAt: '2026-11-19T05:00:00Z' },
        sevenDay: { usedRatio: 0.5, resetAt: '2026-11-25T00:00:00Z' },
        monthTotal: { usedRatio: 0.1, resetAt: null },
        monthCode: null,
      },
      extra: {
        balanceCents: 250,
        totalCents: 1000,
        monthlyChargeLimitEnabled: true,
        monthlyChargeLimitCents: 5000,
        monthlyUsedCents: 1200,
        currency: 'EUR',
      },
      requests: { limit: 100, used: 40, remaining: 60, resetAt: '2026-11-19T05:00:00Z' },
    })
    assert.equal(state.endpoint, 'https://api.kimi.com/coding/v1')
  })
})

test('Kimi sends its own User-Agent and a Bearer key resolved from KIMI_CODING_API_KEY', async () => {
  await run({ resolve: () => ({ value: 'kimi-secret' }), handler: () => json(REPLY) }, async (h) => {
    await h.api.refresh()
    assert.deepEqual(h.resolved, ['KIMI_CODING_API_KEY'])
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].url, CN_URL)
    assert.equal(h.calls[0].init.method, 'GET')
    const headers = h.calls[0].init.headers
    assert.equal(headers['User-Agent'], 'dsh-plugin-kimi-usage/0.1')
    assert.equal(headers.Authorization, 'Bearer kimi-secret')
    assert.equal(headers.Accept, 'application/json')
  })
})

test('Kimi: region global and an explicit baseUrl pick the endpoint', async () => {
  await run({ config: { region: 'global' }, handler: () => json(REPLY) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(h.calls[0].url, GLOBAL_URL)
    assert.equal(state.endpoint, 'https://api.kimi.ai/coding/v1')
  })
  await run({ config: { region: 'global', baseUrl: 'https://kimi.example/v1//' }, handler: () => json(REPLY) }, async (h) => {
    await h.api.refresh()
    assert.equal(h.calls[0].url, 'https://kimi.example/v1/usages')
  })
})

test('Kimi: a sub-cent wallet balance rounds up to 1 cent; no BOOSTER wallet gives extra null', async () => {
  const sub = { usages: { limit_5h: { used_ratio: 0.1 } }, boosterWallet: { balance: { type: 'BOOSTER', amount: 2_000_000, amountLeft: 500_000 } } }
  await run({ handler: () => json(sub) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.data.extra.balanceCents, 1)
    assert.equal(state.data.extra.totalCents, 2)
    assert.equal(state.data.extra.currency, 'USD', 'no currency in the reply: USD')
    assert.equal(state.data.extra.monthlyChargeLimitEnabled, false)
  })
  const none = { usages: { limit_5h: { used_ratio: 0.1 } }, boosterWallet: { balance: { type: 'OTHER', amount: 5_000_000 } } }
  await run({ handler: () => json(none) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.data.extra, null)
    assert.equal(state.data.requests, null)
  })
})

test('Kimi report prints each window, the request counter and the wallet (no footer asserted)', async () => {
  await run({ handler: () => json(REPLY) }, async (h) => {
    await h.api.refresh()
    const report = await h.command.handler({})
    assert.equal(report.kind, 'success')
    const lines = report.text.split('\n')
    assert.equal(lines[0], 'Kimi Code usage')
    assert.ok(lines.includes('5-hour window: 25.0% used (resets 2026-11-19T05:00:00Z)'))
    assert.ok(lines.includes('7-day window: 50.0% used (resets 2026-11-25T00:00:00Z)'))
    assert.ok(lines.includes('Monthly (all): 10.0% used'))
    assert.ok(!lines.some((l) => l.startsWith('Monthly (code)')), 'a window the plan omits is not printed')
    assert.ok(lines.includes('Requests: 40 / 100 (resets 2026-11-19T05:00:00Z)'))
    assert.ok(lines.includes('Extra usage: EUR 2.50 left of EUR 10.00 · monthly cap EUR 50.00, used EUR 12.00'))
  })
})

// --- failure taxonomy for the kimi.js runtime ---

test('Kimi failure: a missing credential names the reference and makes no request', async () => {
  for (const missing of [undefined, { value: '' }]) {
    await run({ resolve: () => missing, handler: () => json(REPLY) }, async (h) => {
      const state = await h.api.refresh()
      assert.equal(state.status, 'error')
      assert.equal(state.error, 'missing-credential')
      assert.equal(state.detail, 'No value for KIMI_CODING_API_KEY. Add a Kimi Code API key in Settings → Models, or sign in with Kimi Code.')
      assert.equal(h.calls.length, 0)
      const result = await h.command.handler({})
      assert.equal(result.kind, 'error')
      assert.match(result.text, /^Kimi Code usage unavailable: No value for KIMI_CODING_API_KEY/)
    })
  }
})

test('Kimi failure: a credential read failure carries the reason and makes no request', async () => {
  await run({
    resolve: () => { throw new Error('keychain locked') },
    handler: () => json(REPLY),
  }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'credential-read-failed')
    assert.equal(state.detail, 'keychain locked')
    assert.equal(h.calls.length, 0)
  })
})

test('Kimi failure: HTTP 401 carries the message and the Kimi Code Console hint', async () => {
  await run({ handler: () => json({ error: { message: 'invalid api key' } }, 401) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'http-401')
    assert.equal(
      state.detail,
      'invalid api key A Kimi Platform key (platform.kimi.ai) is not valid here — create the key in the Kimi Code Console (kimi.com/code/console).',
    )
  })
  await run({ handler: () => json({ error: { message: 'busy' } }, 429) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.error, 'http-429')
    assert.equal(state.detail, 'busy', 'the hint is for 401 only')
  })
})

test('Kimi failure: a body that is not JSON is bad-response with the Cloudflare hint', async () => {
  await run({ handler: () => html(403) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'bad-response')
    assert.match(state.detail, /^HTTP 403 with a body that is not JSON\./)
    assert.match(state.detail, /Cloudflare challenge/)
    assert.match(state.detail, /switch region to cn/)
  })
})

test('Kimi failure: an AbortError is timeout', async () => {
  await run({ handler: () => { throw abortError() } }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'timeout')
    assert.equal(state.detail, 'No reply within 15000 ms.')
  })
})

test('Kimi failure: a hung reply is aborted by the timeout budget (mock timers, no real wait)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await run({
    config: { timeoutMs: 9000 },
    handler: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(abortError()))
    }),
  }, async (h) => {
    const pending = h.api.refresh()
    await new Promise((resolve) => setImmediate(resolve))
    t.mock.timers.tick(9000)
    const state = await pending
    assert.equal(state.error, 'timeout')
    assert.equal(state.detail, 'No reply within 9000 ms.')
  })
})

test('Kimi failure: a network error is network with the message', async () => {
  await run({ handler: () => { throw new TypeError('fetch failed') } }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'network')
    assert.equal(state.detail, 'fetch failed')
  })
})

test('Kimi failure: a JSON reply that is not an object is bad-response', async () => {
  await run({ handler: () => json([1, 2]) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.error, 'bad-response')
    assert.equal(state.detail, 'Reply was not a JSON object.')
  })
})

/** Run fn with Date.now fixed at `now`, restored afterwards. */
async function withNow(now, fn) {
  const real = Date.now
  Date.now = () => now
  try {
    return await fn()
  } finally {
    Date.now = real
  }
}
test('Kimi: every failure path sets attemptedAt and leaves fetchedAt null: a missing credential, a credential read failure and an HTTP error', async () => {
  for (const options of [
    { resolve: () => undefined, handler: () => json(REPLY) },
    { resolve: () => { throw new Error('keychain locked') }, handler: () => json(REPLY) },
    { handler: () => json({ error: { message: 'nope' } }, 500) },
  ]) {
    await withNow(1_700_000_000_000, async () => {
      await run(options, async (h) => {
        const state = await h.api.refresh()
        assert.equal(state.status, 'error')
        assert.equal(state.attemptedAt, 1_700_000_000_000, state.error)
        assert.equal(state.fetchedAt, null)
      })
    })
  }
})

// --- a catch-all around the whole refresh (the shared runtime in net.js has one) ---

/** A thrown value with no prototype: `String(value)` throws on it. */
const unprintable = () => Object.create(null)

/** A credentials.resolve result whose `value` getter throws `thrown`. */
const throwingValue = (thrown) => ({ get value() { throw thrown } })

test('Kimi catch-all: a credential read that rejects with an unprintable value is a credential-read-failed state, and the command still answers', async () => {
  await run({ resolve: () => { throw unprintable() }, handler: () => json(REPLYKimi) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'credential-read-failed')
    assert.equal(typeof state.detail, 'string')
    assert.ok(state.detail.length > 0)
    assert.equal(h.calls.length, 0)
    assert.equal((await h.command.handler({})).kind, 'error')
  })
})

test('Kimi catch-all: a throw outside the credential read becomes an unexpected error with a message, never a stuck loading state or a rejected refresh', async () => {
  for (const [thrown, expected] of [[new Error('getter boom'), 'getter boom'], [unprintable(), undefined]]) {
    await withNow(1_700_000_000_000, async () => {
      await run({ resolve: () => throwingValue(thrown), handler: () => json(REPLYKimi) }, async (h) => {
        const state = await h.api.refresh()
        assert.equal(state.status, 'error', 'not stuck at loading')
        assert.equal(state.error, 'unexpected')
        assert.equal(typeof state.detail, 'string')
        if (expected !== undefined) assert.equal(state.detail, expected)
        assert.ok(state.detail.length > 0)
        assert.equal(state.attemptedAt, 1_700_000_000_000)
        assert.equal(state.fetchedAt, null)
        assert.equal((await h.api.snapshot()).status, 'error')
        const result = await h.command.handler({})
        assert.equal(result.kind, 'error')
        assert.ok(result.text.includes(state.detail))
      })
    })
  }
})

test('Kimi catch-all: the poll tick of a refresh that throws is not an unhandled rejection', async (t) => {
  const unhandled = []
  const listener = (reason) => { unhandled.push(reason) }
  process.on('unhandledRejection', listener)
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let api
  let poll
  mountKimi({
    credentials: { resolve: async () => throwingValue(new Error('getter boom')), readRecord: async () => undefined },
    provide(key, value) { api = value },
    commands: { register() {} },
    effect(fn) { poll = fn },
  }, {})
  const stop = poll()
  try {
    t.mock.timers.tick(1_000)
    for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve))
    assert.equal((await api.snapshot()).error, 'unexpected', 'the tick ran the refresh')
    assert.deepEqual(unhandled, [])
  } finally {
    stop()
    process.off('unhandledRejection', listener)
  }
})

// --- known drift: desired behaviour, failing today ---

test('Kimi reply without usages should become an error bad-response', { todo: 'today: status ready with every quota null, extra null and requests null' }, async () => {
  await run({ handler: () => json({ message: 'ok' }) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'bad-response')
  })
})
