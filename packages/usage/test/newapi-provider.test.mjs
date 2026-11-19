import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { mountNewApi } from '../src/providers/newapi.js'

// NewAPI (newapi.js): no default base URL; mounts nothing without baseUrl.
// 500000 quota units = 1 USD. fetch is stubbed in every test and restored;
// no footer or timestamp assertions (test/stale-state.test.mjs owns those).

const REAL_FETCH = globalThis.fetch
after(() => {
  assert.equal(globalThis.fetch, REAL_FETCH, 'a test leaked its fetch stub')
})

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const BASE = 'https://relay.test'

/** Mount NewAPI; `m` records what was mounted so "mounts nothing" is provable. */
async function run({ config = { baseUrl: BASE }, credential = 'relay-token', handler }, fn) {
  const calls = []
  const resolved = []
  const m = { services: new Map(), commands: new Map(), effects: [] }
  const ctx = {
    credentials: {
      resolve: async (ref) => {
        resolved.push(ref)
        return credential === undefined ? undefined : { value: credential }
      },
      readRecord: async () => undefined,
    },
    provide(key, value) { m.services.set(key, value) },
    commands: { register(value) { m.commands.set(value.name, value) } },
    effect(fn, label) { m.effects.push({ fn, label }) },
  }
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (!handler) throw new Error('unexpected fetch')
    return handler(url, init)
  }
  const realWarn = console.warn
  const warnings = []
  console.warn = (...args) => { warnings.push(args.join(' ')) }
  try {
    mountNewApi(ctx, config)
  } finally {
    console.warn = realWarn
  }
  try {
    await fn({ api: m.services.get('newapiUsage'), command: m.commands.get('usage-newapi'), m, calls, resolved, warnings })
  } finally {
    globalThis.fetch = REAL_FETCH
  }
}

test('NewAPI happy path: quota units become USD (500000 = $1)', async () => {
  const body = { code: 200, message: 'ok', data: { total_granted: 2_500_000, total_used: 1_000_000, total_available: 1_500_000, unlimited_quota: false } }
  await run({ handler: () => json(body) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'ready')
    assert.deepEqual(state.data, { kind: 'balance', total: 5, used: 2, remaining: 3, currency: 'USD' })
    assert.equal(state.endpoint, BASE)
  })
})

test('NewAPI asks GET {baseUrl}/api/usage/token with a Bearer token from NEWAPI_API_KEY', async () => {
  const body = { code: 200, data: { total_granted: 500_000, total_available: 500_000 } }
  await run({ config: { baseUrl: 'https://relay.test///' }, credential: ' tok ', handler: () => json(body) }, async (h) => {
    await h.api.refresh()
    assert.deepEqual(h.resolved, ['NEWAPI_API_KEY'])
    assert.equal(h.calls[0].url, 'https://relay.test/api/usage/token')
    assert.equal(h.calls[0].init.method, 'GET')
    assert.equal(h.calls[0].init.headers.Authorization, 'Bearer tok')
  })
})

test('NewAPI: a missing total_used stays null while granted and available convert', async () => {
  await run({ handler: () => json({ code: 200, data: { total_granted: 1_000_000, total_available: 250_000 } }) }, async (h) => {
    const state = await h.api.refresh()
    assert.deepEqual(state.data, { kind: 'balance', total: 2, used: null, remaining: 0.5, currency: 'USD' })
  })
})

test('NewAPI report prints granted, used and remaining in USD', async () => {
  const body = { code: 200, data: { total_granted: 1_000_000, total_used: 500_000, total_available: 500_000 } }
  await run({ handler: () => json(body) }, async (h) => {
    await h.api.refresh()
    const report = await h.command.handler({})
    const lines = report.text.split('\n')
    assert.equal(lines[0], 'NewAPI token quota')
    assert.ok(lines.includes('Granted: $2.00 · used: $1.00 · remaining: $1.00'))
    assert.ok(lines.includes('Endpoint: relay.test'))
  })
})

test('NewAPI does not mount without baseUrl: no service, command or poll, one warning, no fetch', async () => {
  for (const config of [{}, { baseUrl: '' }, { baseUrl: 42 }]) {
    await run({ config }, async (h) => {
      assert.equal(h.m.services.size, 0)
      assert.equal(h.m.commands.size, 0)
      assert.equal(h.m.effects.length, 0)
      assert.equal(h.calls.length, 0)
      assert.equal(h.warnings.length, 1)
      assert.match(h.warnings[0], /newapi.*no baseUrl/)
    })
  }
})

test('NewAPI with a baseUrl mounts the service, the command and one poll effect, with no warning', async () => {
  await run({}, async (h) => {
    assert.ok(h.m.services.has('newapiUsage'))
    assert.ok(h.m.commands.has('usage-newapi'))
    assert.equal(h.m.effects.length, 1)
    assert.deepEqual(h.warnings, [])
  })
})

test('NewAPI reports unlimited-quota when the token has no limit', async () => {
  await run({ handler: () => json({ code: 200, data: { unlimited_quota: true, total_granted: 0, total_used: 0, total_available: 0 } }) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'unlimited-quota')
    assert.match(state.detail, /unlimited quota/)
    assert.equal(state.data, null)
  })
})

test('NewAPI reports api-error with the message when code is not 200', async () => {
  await run({ handler: () => json({ code: 401, message: 'Invalid token' }) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'api-error')
    assert.equal(state.detail, 'Invalid token')
  })
})

test('NewAPI: a reply without data is bad-response', async () => {
  await run({ handler: () => json({ code: 200 }) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.error, 'bad-response')
    assert.equal(state.detail, 'Reply lacks data.')
  })
})

test('NewAPI: data without total_granted or total_available is bad-response', async () => {
  await run({ handler: () => json({ code: 200, data: { total_used: 10 } }) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.error, 'bad-response')
    assert.equal(state.detail, 'Reply lacks total_granted/total_available.')
  })
})

test('NewAPI: the command with no good read is kind error with the api message', async () => {
  await run({ handler: () => json({ code: 500, message: 'relay down' }) }, async (h) => {
    const result = await h.command.handler({})
    assert.equal(result.kind, 'error')
    assert.equal(result.text, 'NewAPI usage unavailable: relay down')
  })
})

// Drift needing a real reply: a boolean code and a success message look like
// an OK envelope but today are read as an api-error because code !== 200.

test('NewAPI {code:true,message:"ok"} is not an api-error', { todo: "needs a real reply: today status 'error', error 'api-error', detail 'ok'" }, async () => {
  await run({ handler: () => json({ code: true, message: 'ok' }) }, async (h) => {
    const state = await h.api.refresh()
    assert.notEqual(state.error, 'api-error')
  })
})
