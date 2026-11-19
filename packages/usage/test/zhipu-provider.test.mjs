import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { mountZhipu } from '../src/providers/zhipu.js'

// GLM Coding Plan (zhipu.js): the RAW key goes in Authorization, no Bearer.
// fetch is stubbed in every test and restored; no footer or timestamp
// assertions (test/stale-state.test.mjs owns those).

const REAL_FETCH = globalThis.fetch
after(() => {
  assert.equal(globalThis.fetch, REAL_FETCH, 'a test leaked its fetch stub')
})

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

async function run({ config = {}, credential = 'glm-key', handler }, fn) {
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
    provide(key, value) { if (key === 'zhipuUsage') api = value },
    commands: { register(value) { command = value } },
    effect() {},
  }
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (!handler) throw new Error('unexpected fetch')
    return handler(url, init)
  }
  try {
    mountZhipu(ctx, config)
    await fn({ api, command, calls, resolved })
  } finally {
    globalThis.fetch = REAL_FETCH
  }
}

const RESET_5H = 1797339952000
const RESET_7D = 1797900000000
const REPLY = {
  success: true,
  data: {
    level: 'pro',
    limits: [
      { type: 'TOKENS_LIMIT', unit: 3, percentage: 25, usage: 100, remaining: 75, nextResetTime: RESET_5H },
      { type: 'TOKENS_LIMIT', unit: 6, percentage: 40, usage: 1000, remaining: 600, nextResetTime: RESET_7D },
      {
        type: 'TIME_LIMIT',
        unit: 5,
        percentage: 10,
        usage: 1000,
        remaining: 900,
        nextResetTime: RESET_7D,
        usageDetails: [{ modelCode: 'search-prime', usage: 12 }, { modelCode: 'web-reader', usage: 3 }, { modelCode: 'broken' }],
      },
    ],
  },
}

test('GLM happy path: 5-hour and 7-day windows, tool calls, plan level', async () => {
  await run({ handler: () => json(REPLY) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'ready')
    assert.deepEqual(state.data, {
      kind: 'quota',
      level: 'pro',
      windows: [
        { key: 'fiveHour', label: '5-hour window', usedRatio: 0.25, limit: 100, remaining: 75, resetAt: new Date(RESET_5H).toISOString() },
        { key: 'sevenDay', label: '7-day window', usedRatio: 0.4, limit: 1000, remaining: 600, resetAt: new Date(RESET_7D).toISOString() },
      ],
      prompts: {
        key: 'prompts',
        label: 'Tool calls',
        usedRatio: 0.1,
        limit: 1000,
        remaining: 900,
        resetAt: new Date(RESET_7D).toISOString(),
        details: [{ model: 'search-prime', usage: 12 }, { model: 'web-reader', usage: 3 }],
      },
    })
    assert.equal(state.endpoint, 'https://open.bigmodel.cn')
  })
})

test('GLM sends the RAW key in Authorization, with no Bearer prefix', async () => {
  await run({ credential: '  abc.secret  ', handler: () => json(REPLY) }, async (h) => {
    await h.api.refresh()
    assert.deepEqual(h.resolved, ['ZHIPU_API_KEY'])
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].url, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit')
    assert.equal(h.calls[0].init.headers.Authorization, 'abc.secret')
    assert.ok(!/bearer/i.test(h.calls[0].init.headers.Authorization))
  })
})

test('GLM picks the global base for region global and an explicit baseUrl over both', async () => {
  await run({ config: { region: 'global' }, handler: () => json(REPLY) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(h.calls[0].url, 'https://api.z.ai/api/monitor/usage/quota/limit')
    assert.equal(state.endpoint, 'https://api.z.ai')
  })
  await run({ config: { region: 'global', baseUrl: 'https://glm.example//' }, handler: () => json(REPLY) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(h.calls[0].url, 'https://glm.example/api/monitor/usage/quota/limit')
    assert.equal(state.endpoint, 'https://glm.example')
  })
})

test('GLM 401 appends the raw-key hint to the HTTP message', async () => {
  await run({ handler: () => json({ msg: 'token expired' }, 401) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'http-401')
    assert.equal(state.detail, 'HTTP 401: token expired Check the GLM Coding Plan key — this API takes the raw key, no Bearer prefix.')
  })
})

test('GLM: success false is an api-error with the msg', async () => {
  await run({ handler: () => json({ success: false, msg: 'plan expired' }) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.error, 'api-error')
    assert.equal(state.detail, 'plan expired')
  })
})

test('GLM: a reply without data.limits is bad-response', async () => {
  await run({ handler: () => json({ success: true, data: {} }) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.error, 'bad-response')
    assert.equal(state.detail, 'Reply lacks data.limits.')
  })
})

test('GLM: limits with no usable type are bad-response and name the types seen', async () => {
  await run({ handler: () => json({ success: true, data: { limits: [{ type: 'MYSTERY_LIMIT', percentage: 5 }] } }) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.error, 'bad-response')
    assert.equal(state.detail, 'No parseable quota window; types seen: mystery_limit.')
  })
})

test('GLM: percentage is optional, currentValue / usage is used instead', async () => {
  const body = { success: true, data: { limits: [{ type: 'CREDIT_LIMIT', unit: 3, currentValue: 30, usage: 120, nextResetTime: RESET_5H }] } }
  await run({ handler: () => json(body) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'ready')
    assert.equal(state.data.level, null)
    assert.equal(state.data.windows.length, 1)
    assert.equal(state.data.windows[0].key, 'fiveHour')
    assert.equal(state.data.windows[0].usedRatio, 0.25)
    assert.equal(state.data.prompts, null)
  })
})

test('GLM: windows with an unknown unit fill empty slots, soonest reset first', async () => {
  const body = {
    success: true,
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', unit: 9, percentage: 70, nextResetTime: RESET_7D },
        { type: 'TOKENS_LIMIT', unit: 8, percentage: 20, nextResetTime: RESET_5H },
      ],
    },
  }
  await run({ handler: () => json(body) }, async (h) => {
    const state = await h.api.refresh()
    assert.deepEqual(state.data.windows.map((w) => [w.key, w.usedRatio]), [['fiveHour', 0.2], ['sevenDay', 0.7]])
  })
})

test('GLM report prints each window and the tool-call details (no footer asserted)', async () => {
  await run({ handler: () => json(REPLY) }, async (h) => {
    await h.api.refresh()
    const report = await h.command.handler({})
    const lines = report.text.split('\n')
    assert.equal(lines[0], 'GLM Coding Plan usage')
    assert.ok(lines.includes('Plan: pro'))
    assert.ok(lines.includes(`5-hour window: 25.0% used (25 / 100) · resets ${new Date(RESET_5H).toISOString()}`))
    assert.ok(lines.includes('  search-prime: 12'))
  })
})

// A reset time that is not a usable epoch gives resetAt null; it never throws
// 'Invalid time value' (new Date(1e20).toISOString()) and never fails the provider.

const limitWith = (nextResetTime, extra = {}) => ({ success: true, data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 25, usage: 100, remaining: 75, nextResetTime, ...extra }] } })

test('GLM nextResetTime 1e20 gives resetAt null with status ready', async () => {
  await run({ handler: () => json(limitWith(1e20)) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'ready')
    assert.equal(state.error, null)
    assert.equal(state.data.windows[0].resetAt, null)
    assert.equal(state.data.windows[0].usedRatio, 0.25)
  })
})

test('GLM: negative, NaN-like and non-numeric reset times give resetAt null, valid ones still work', async () => {
  const cases = [[-1, null], [-1797339952000, null], ['not a number', null], [null, null], [Number.MAX_VALUE, null], [8.64e15 + 1, null], [String(RESET_5H), new Date(RESET_5H).toISOString()], [RESET_5H, new Date(RESET_5H).toISOString()]]
  for (const [value, expected] of cases) {
    await run({ handler: () => json(limitWith(value)) }, async (h) => {
      const state = await h.api.refresh()
      assert.equal(state.status, 'ready', String(value))
      assert.equal(state.data.windows[0].resetAt, expected, String(value))
    })
  }
})

test('GLM: a bad reset time on one limit does not drop the other windows or the tool-call detail', async () => {
  const body = { success: true, data: { limits: [
    { type: 'TOKENS_LIMIT', unit: 3, percentage: 25, usage: 100, remaining: 75, nextResetTime: 1e20 },
    { type: 'TOKENS_LIMIT', unit: 6, percentage: 40, usage: 1000, remaining: 600, nextResetTime: RESET_7D },
    { type: 'TIME_LIMIT', unit: 5, percentage: 10, usage: 1000, remaining: 900, nextResetTime: -5, usageDetails: [] },
  ] } }
  await run({ handler: () => json(body) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'ready')
    assert.equal(state.data.windows[0].resetAt, null)
    assert.equal(state.data.windows[1].resetAt, new Date(RESET_7D).toISOString())
    assert.equal(state.data.prompts.resetAt, null)
  })
})
