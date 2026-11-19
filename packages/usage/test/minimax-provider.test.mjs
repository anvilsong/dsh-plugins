import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { mountMiniMax } from '../src/providers/minimax.js'

// MiniMax Coding Plan (minimax.js): the reply carries REMAINING percents and
// the provider converts them to a used ratio. fetch is stubbed in every test
// and restored; no footer or timestamp assertions (test/stale-state.test.mjs).

const REAL_FETCH = globalThis.fetch
after(() => {
  assert.equal(globalThis.fetch, REAL_FETCH, 'a test leaked its fetch stub')
})

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

async function run({ config = {}, credential = 'mm-key', handler }, fn) {
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
    provide(key, value) { if (key === 'minimaxUsage') api = value },
    commands: { register(value) { command = value } },
    effect() {},
  }
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (!handler) throw new Error('unexpected fetch')
    return handler(url, init)
  }
  try {
    mountMiniMax(ctx, config)
    await fn({ api, command, calls, resolved })
  } finally {
    globalThis.fetch = REAL_FETCH
  }
}

const END_5H = 1797339952000
const END_7D = 1797900000000

function reply(general, extra = {}) {
  return { base_resp: { status_code: 0, status_msg: 'success' }, model_remains: [{ model_name: 'other', current_interval_remaining_percent: 1 }, { model_name: 'general', ...general }], ...extra }
}

test('MiniMax happy path: 5-hour and 7-day windows from the general entry', async () => {
  const body = reply({ current_interval_remaining_percent: 80, end_time: END_5H, current_weekly_status: 1, current_weekly_remaining_percent: 55, weekly_end_time: END_7D })
  await run({ handler: () => json(body) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'ready')
    assert.deepEqual(state.data, {
      kind: 'quota',
      windows: [
        { key: 'fiveHour', label: '5-hour window', usedRatio: 0.2, resetAt: new Date(END_5H).toISOString() },
        { key: 'sevenDay', label: '7-day window', usedRatio: 0.45, resetAt: new Date(END_7D).toISOString() },
      ],
    })
    assert.equal(state.endpoint, 'https://api.minimaxi.com')
  })
})

test('MiniMax converts REMAINING percent to a used ratio (100 left = 0 used, 0 left = all used)', async () => {
  for (const [remaining, used] of [[100, 0], [75, 0.25], [0, 1]]) {
    await run({ handler: () => json(reply({ current_interval_remaining_percent: remaining })) }, async (h) => {
      const state = await h.api.refresh()
      assert.equal(state.data.windows[0].usedRatio, used, `${remaining}% remaining`)
      assert.notEqual(state.data.windows[0].usedRatio, remaining / 100, 'remaining is not reported as used')
    })
  }
})

test('MiniMax: more than 100 percent remaining clamps used to 0, never negative', async () => {
  await run({ handler: () => json(reply({ current_interval_remaining_percent: 130 })) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.data.windows[0].usedRatio, 0)
  })
})

test('MiniMax: the 7-day window appears only when current_weekly_status is 1', async () => {
  const general = { current_interval_remaining_percent: 50, current_weekly_status: 0, current_weekly_remaining_percent: 10, weekly_end_time: END_7D }
  await run({ handler: () => json(reply(general)) }, async (h) => {
    const state = await h.api.refresh()
    assert.deepEqual(state.data.windows.map((w) => w.key), ['fiveHour'])
  })
})

test('MiniMax: a window without end_time has resetAt null', async () => {
  await run({ handler: () => json(reply({ current_interval_remaining_percent: 50 })) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.data.windows[0].resetAt, null)
  })
})

test('MiniMax asks the cn base with a Bearer key; region global and baseUrl change the base', async () => {
  await run({ credential: ' mm-secret ', handler: () => json(reply({ current_interval_remaining_percent: 50 })) }, async (h) => {
    await h.api.refresh()
    assert.deepEqual(h.resolved, ['MINIMAX_API_KEY'])
    assert.equal(h.calls[0].url, 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains')
    assert.equal(h.calls[0].init.headers.Authorization, 'Bearer mm-secret')
  })
  await run({ config: { region: 'global' }, handler: () => json(reply({ current_interval_remaining_percent: 50 })) }, async (h) => {
    await h.api.refresh()
    assert.equal(h.calls[0].url, 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains')
  })
  await run({ config: { baseUrl: 'https://mm.example/' }, handler: () => json(reply({ current_interval_remaining_percent: 50 })) }, async (h) => {
    await h.api.refresh()
    assert.equal(h.calls[0].url, 'https://mm.example/v1/api/openplatform/coding_plan/remains')
  })
})

test('MiniMax: a non-zero base_resp.status_code is an api-error with the status message', async () => {
  await run({ handler: () => json({ base_resp: { status_code: 1004, status_msg: 'login fail' } }) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'api-error')
    assert.equal(state.detail, 'login fail')
  })
})

test('MiniMax: no general entry is bad-response', async () => {
  await run({ handler: () => json({ base_resp: { status_code: 0 }, model_remains: [{ model_name: 'other' }] }) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.error, 'bad-response')
    assert.equal(state.detail, 'Reply lacks the "general" model entry.')
  })
})

test('MiniMax: a general entry without any percent is bad-response', async () => {
  await run({ handler: () => json(reply({ end_time: END_5H })) }, async (h) => {
    const state = await h.api.refresh()
    assert.equal(state.error, 'bad-response')
    assert.equal(state.detail, 'Reply carries no usage windows.')
  })
})

test('MiniMax report prints the used percent, not the remaining percent', async () => {
  await run({ handler: () => json(reply({ current_interval_remaining_percent: 80, end_time: END_5H })) }, async (h) => {
    await h.api.refresh()
    const report = await h.command.handler({})
    const lines = report.text.split('\n')
    assert.equal(lines[0], 'MiniMax Coding Plan usage')
    assert.ok(lines.includes(`5-hour window: 20.0% used · resets ${new Date(END_5H).toISOString()}`))
  })
})

// Drift needing a real reply: whether the field is a 0-100 percent or a 0-1
// fraction is unconfirmed, so no desired value is pinned beyond "not silently
// read as 0.4 percent".

test('MiniMax remaining 0.4 vs 40 scale', { todo: 'needs a real reply: today 0.4 is read as 0.4 percent remaining (used ratio 0.996); if the live API sends fractions the answer is 0.6' }, async () => {
  await run({ handler: () => json(reply({ current_interval_remaining_percent: 0.4 })) }, async (h) => {
    const state = await h.api.refresh()
    // No desired value is pinned: percent versus fraction needs a real reply. Replace this line with the
    // confirmed expectation (0.996 if the field is a percent, 0.6 if it is a fraction) and drop the todo.
    assert.fail(`needs a real reply: usedRatio is ${state.data.windows[0].usedRatio} for remaining 0.4`)
  })
})
