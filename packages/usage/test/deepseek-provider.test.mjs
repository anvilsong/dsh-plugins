import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { mountDeepSeek } from '../src/providers/deepseek.js'

// DeepSeek provider: GET {base}/user/balance, Bearer auth, string amounts.
// fetch is stubbed in every test and restored in its finally block; the
// after() hook proves the real fetch is back. No report footer and no
// timestamps are asserted here: test/stale-state.test.mjs owns those.

const REAL_FETCH = globalThis.fetch
after(() => {
  assert.equal(globalThis.fetch, REAL_FETCH, 'a test leaked its fetch stub')
})

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Mount DeepSeek on a fake ctx with a scripted fetch; fn gets the handle. */
async function run({ config = {}, credential = 'test-key', handler }, fn) {
  const calls = []
  const resolved = []
  let api
  let command
  const ctx = {
    credentials: {
      resolve: async (ref) => {
        resolved.push(ref)
        return credential === undefined ? undefined : { value: credential }
      },
      readRecord: async () => undefined,
    },
    provide(key, value) { if (key === 'deepseekUsage') api = value },
    commands: { register(value) { command = value } },
    effect() {},
  }
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (!handler) throw new Error('unexpected fetch')
    return handler(url, init)
  }
  try {
    mountDeepSeek(ctx, config)
    await fn({ api, command, calls, resolved })
  } finally {
    globalThis.fetch = REAL_FETCH
  }
}

const REPLY = {
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
    { currency: 'USD', total_balance: '3.5', granted_balance: '0', topped_up_balance: '3.5' },
  ],
}

test('DeepSeek happy path: string amounts become numbers, per currency', async () => {
  await run({ handler: () => json(REPLY) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'ready')
    assert.equal(state.error, null)
    assert.deepEqual(state.data, {
      kind: 'balance',
      isAvailable: true,
      balances: [
        { currency: 'CNY', total: 110, granted: 10, toppedUp: 100 },
        { currency: 'USD', total: 3.5, granted: 0, toppedUp: 3.5 },
      ],
    })
    assert.equal(state.endpoint, 'https://api.deepseek.com')
  })
})

test('DeepSeek asks GET /user/balance with a Bearer key resolved from DEEPSEEK_API_KEY', async () => {
  await run({ credential: '  sk-secret  ', handler: () => json(REPLY) }, async (h) => {
    await h.api.refresh()
    assert.deepEqual(h.resolved, ['DEEPSEEK_API_KEY'])
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].url, 'https://api.deepseek.com/user/balance')
    assert.equal(h.calls[0].init.method, 'GET')
    assert.equal(h.calls[0].init.headers.Authorization, 'Bearer sk-secret', 'trimmed key with the Bearer prefix')
    assert.equal(h.calls[0].init.headers.Accept, 'application/json')
  })
})

test('DeepSeek honours credentialRef and baseUrl (trailing slashes trimmed)', async () => {
  await run({ config: { credentialRef: 'MY_DS_KEY', baseUrl: 'https://ds.example/' }, handler: () => json(REPLY) }, async (h) => {
    const state = await h.api.refresh()
    assert.deepEqual(h.resolved, ['MY_DS_KEY'])
    assert.equal(h.calls[0].url, 'https://ds.example/user/balance')
    assert.equal(state.endpoint, 'https://ds.example')
  })
})

test('DeepSeek: is_available false is kept as isAvailable false and the report says so', async () => {
  const body = { is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00', granted_balance: '0', topped_up_balance: '0.00' }] }
  await run({ handler: () => json(body) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'ready')
    assert.equal(state.data.isAvailable, false)
    const report = await h.command.handler({})
    assert.equal(report.kind, 'success')
    assert.match(report.text, /Balance status: insufficient/)
  })
})

test('DeepSeek: amounts that are not numbers stay null instead of becoming 0', async () => {
  const body = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: 'n/a', granted_balance: null, topped_up_balance: '' }] }
  await run({ handler: () => json(body) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'ready')
    assert.deepEqual(state.data.balances, [{ currency: 'CNY', total: null, granted: null, toppedUp: null }])
  })
})

test('DeepSeek report lists each currency with its topped-up and granted parts', async () => {
  await run({ handler: () => json(REPLY) }, async (h) => {
    await h.api.refresh()
    const report = await h.command.handler({})
    assert.equal(report.kind, 'success')
    const lines = report.text.split('\n')
    assert.equal(lines[0], 'DeepSeek balance')
    assert.ok(lines.includes('CNY: 110.00 CNY (topped up 100.00 CNY · granted 10.00 CNY)'))
    assert.ok(lines.includes('USD: 3.50 USD (topped up 3.50 USD)'))
    assert.ok(lines.includes('Endpoint: api.deepseek.com'))
  })
})

test('DeepSeek: an error object in the reply is an api-error with its message', async () => {
  await run({ handler: () => json({ error: { message: 'account suspended' } }) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'api-error')
    assert.equal(state.detail, 'account suspended')
    assert.equal(state.data, null)
  })
})

test('DeepSeek: a reply without balance_infos is bad-response', async () => {
  await run({ handler: () => json({ is_available: true }) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'bad-response')
    assert.equal(state.detail, 'Reply lacks balance_infos.')
  })
})

test('DeepSeek: a command with no good read returns kind error with the detail', async () => {
  await run({ handler: () => json({ error: { message: 'bad key' } }, 401) }, async (h) => {
    const result = await h.command.handler({})
    assert.equal(result.kind, 'error')
    assert.equal(result.text, 'DeepSeek usage unavailable: HTTP 401: bad key')
  })
})

// Known drift: today these pass through as a ready state with invented or
// empty values. The desired behaviour is pinned here as todo tests.

test('DeepSeek renamed fields should become bad-response', { todo: 'today: ready with every amount null and currency CNY' }, async () => {
  const renamed = { is_available: true, balance_infos: [{ cur: 'CNY', total: '12.34', granted: '0', topped_up: '12.34' }] }
  await run({ handler: () => json(renamed) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'bad-response')
  })
})

test('DeepSeek balance without a currency should not be invented as CNY', { todo: 'today: the currency defaults to CNY (deepseek.js:73)' }, async () => {
  const body = { is_available: true, balance_infos: [{ total_balance: '5.00', granted_balance: '0', topped_up_balance: '5.00' }] }
  await run({ handler: () => json(body) }, async (h) => {
    const state = await h.api.refresh()
    assert.notEqual(state.data?.balances?.[0]?.currency, 'CNY')
  })
})
