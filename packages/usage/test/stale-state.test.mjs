import assert from 'node:assert/strict'
import test from 'node:test'
import { usageFooter } from '../src/providers/net.js'
import { mountAnthropic } from '../src/providers/anthropic.js'
import { mountCodex } from '../src/providers/codex.js'
import { mountDeepSeek } from '../src/providers/deepseek.js'
import { mountKimi } from '../src/providers/kimi.js'
import { mountMiniMax } from '../src/providers/minimax.js'
import { mountNewApi } from '../src/providers/newapi.js'
import { mountOpenRouter } from '../src/providers/openrouter.js'
import { mountZhipu } from '../src/providers/zhipu.js'

// Honest refresh state on the Host: fetchedAt is the last GOOD read,
// attemptedAt the last attempt, error/detail survive the loading transition,
// and a refresh made during a flight resolves to the state after that flight.
// Every test stubs fetch and Date.now and restores both.

const BASE = 1_700_000_000_000
const FAIL_BODY = { error: { message: 'boom' } }

/** The eight providers: how to mount them, a good reply, and a number their report prints. */
const PROVIDERS = [
  {
    name: 'DeepSeek', runtime: 'net.js', mount: mountDeepSeek, key: 'deepseekUsage', command: 'usage-deepseek', config: {},
    ok: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '0', topped_up_balance: '12.34' }] },
    numbers: /12\.34 CNY/,
  },
  {
    name: 'GLM', runtime: 'net.js', mount: mountZhipu, key: 'zhipuUsage', command: 'usage-zhipu', config: {},
    ok: { success: true, data: { level: 'pro', limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 25, usage: 100, remaining: 75, nextResetTime: 1797339952000 }] } },
    numbers: /25\.0% used/,
  },
  {
    name: 'MiniMax', runtime: 'net.js', mount: mountMiniMax, key: 'minimaxUsage', command: 'usage-minimax', config: {},
    ok: { base_resp: { status_code: 0 }, model_remains: [{ model_name: 'general', current_interval_remaining_percent: 80, end_time: 1797339952000 }] },
    numbers: /20\.0% used/,
  },
  {
    name: 'NewAPI', runtime: 'net.js', mount: mountNewApi, key: 'newapiUsage', command: 'usage-newapi', config: { baseUrl: 'https://relay.test' },
    ok: { code: 200, data: { total_granted: 1_000_000, total_used: 500_000, total_available: 500_000 } },
    numbers: /remaining: \$1\.00/,
  },
  {
    name: 'Codex', runtime: 'net.js', mount: mountCodex, key: 'codexUsage', command: 'usage-codex', config: {}, oauth: 'openai-codex',
    ok: { plan_type: 'plus', rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } },
    numbers: /10\.0% used/,
  },
  {
    name: 'Claude', runtime: 'net.js', mount: mountAnthropic, key: 'anthropicUsage', command: 'usage-anthropic', config: {}, oauth: 'anthropic',
    ok: { five_hour: { utilization: 10, resets_at: '2026-11-19T00:00:00Z' } },
    numbers: /10\.0% used/,
  },
  {
    name: 'OpenRouter', runtime: 'openrouter.js', mount: mountOpenRouter, key: 'openrouterUsage', command: 'usage-openrouter', config: { showAccount: false },
    ok: { data: { label: 'k', usage: 1.5, limit: null, limit_remaining: null } },
    numbers: /\$1\.50/,
  },
  {
    name: 'Kimi', runtime: 'kimi.js', mount: mountKimi, key: 'kimiUsage', command: 'usage-kimi', config: {},
    ok: { usages: { limit_5h: { used_ratio: 0.1, reset_time: '2026-11-19T00:00:00Z' } } },
    numbers: /10\.0% used/,
  },
]

/** The three runtimes that own a state: net.js (via DeepSeek), openrouter.js, kimi.js. */
const RUNTIMES = PROVIDERS.filter((p) => ['DeepSeek', 'OpenRouter', 'Kimi'].includes(p.name))

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

/**
 * Mount one provider against a scripted fetch and a settable clock.
 * `h.reply` is the next reply ({ status, body }); `h.gate`, when set, holds the
 * next fetch until `h.gate.resolve()`.
 */
function mount(provider, { missingCredential = false } = {}) {
  let api
  let command
  const h = { calls: 0, reply: { status: 200, body: provider.ok }, gate: null }
  const credentials = missingCredential
    ? { resolve: async () => undefined, readRecord: async () => undefined }
    : { resolve: async () => ({ value: 'test-key' }), readRecord: async () => ({ kind: 'grant', payload: { access: 'test-token' } }) }
  const ctx = {
    credentials,
    provide(key, value) { if (key === provider.key) api = value },
    commands: { register(value) { command = value } },
    effect() {},
  }
  const realFetch = globalThis.fetch
  const realNow = Date.now
  let now = BASE
  Date.now = () => now
  globalThis.fetch = async () => {
    h.calls += 1
    const reply = h.reply
    const gate = h.gate
    if (gate) await gate.promise
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } })
  }
  provider.mount(ctx, provider.config)
  return Object.assign(h, {
    api,
    command,
    setNow(value) { now = value },
    fail() { h.reply = { status: 500, body: FAIL_BODY } },
    succeed() { h.reply = { status: 200, body: provider.ok } },
    restore() { globalThis.fetch = realFetch; Date.now = realNow },
  })
}

const time = (ms) => new Date(ms).toLocaleTimeString()

for (const p of RUNTIMES) {
  test(`${p.name} (${p.runtime}): a failed refresh keeps data and fetchedAt, and attemptedAt is the failure time`, async () => {
    const h = mount(p)
    try {
      const ready = await h.api.refresh()
      assert.equal(ready.status, 'ready')
      h.setNow(BASE + 60_000)
      h.fail()
      const failed = await h.api.refresh()
      assert.equal(failed.status, 'error')
      assert.equal(failed.data, ready.data, 'data is the last good object')
      assert.equal(failed.fetchedAt, BASE, 'fetchedAt is the last good read')
      assert.equal(failed.attemptedAt, BASE + 60_000, 'attemptedAt is the failure time')
      assert.equal((await h.api.snapshot()).fetchedAt, BASE)
    } finally {
      h.restore()
    }
  })

  test(`${p.name} (${p.runtime}): a successful refresh sets fetchedAt and attemptedAt together and clears error and detail`, async () => {
    const h = mount(p)
    try {
      const first = await h.api.refresh()
      assert.equal(first.fetchedAt, BASE)
      assert.equal(first.attemptedAt, BASE)
      h.setNow(BASE + 60_000)
      h.fail()
      const failed = await h.api.refresh()
      assert.ok(failed.error)
      assert.ok(failed.detail)
      h.setNow(BASE + 120_000)
      h.succeed()
      const ready = await h.api.refresh()
      assert.equal(ready.status, 'ready')
      assert.equal(ready.fetchedAt, BASE + 120_000)
      assert.equal(ready.attemptedAt, BASE + 120_000)
      assert.equal(ready.error, null)
      assert.equal(ready.detail, null)
    } finally {
      h.restore()
    }
  })

  test(`${p.name} (${p.runtime}): error and detail keep their last values while status is loading after a failure`, async () => {
    const h = mount(p)
    try {
      await h.api.refresh()
      h.fail()
      const failed = await h.api.refresh()
      const { error, detail } = failed
      assert.ok(error && detail)
      h.succeed()
      h.gate = deferred()
      const pending = h.api.refresh()
      const loading = await h.api.snapshot()
      assert.equal(loading.status, 'loading')
      assert.equal(loading.error, error)
      assert.equal(loading.detail, detail)
      assert.equal(loading.fetchedAt, BASE, 'fetchedAt stays the last good read while loading')
      h.gate.resolve()
      const done = await pending
      assert.equal(done.status, 'ready')
      assert.equal(done.error, null)
    } finally {
      h.restore()
    }
  })

  test(`${p.name} (${p.runtime}): refresh() during a flight resolves to the state after that flight, never loading`, async () => {
    const h = mount(p)
    try {
      h.gate = deferred()
      const first = h.api.refresh()
      const second = h.api.refresh()
      assert.equal((await h.api.snapshot()).status, 'loading')
      h.gate.resolve()
      const [a, b] = await Promise.all([first, second])
      assert.equal(h.calls, 1, 'one fetch serves both callers')
      assert.equal(a.status, 'ready')
      assert.equal(b.status, 'ready')
      assert.equal(b.fetchedAt, BASE)
      // A failing flight is joined the same way.
      h.fail()
      h.gate = deferred()
      const f1 = h.api.refresh()
      const f2 = h.api.refresh()
      h.gate.resolve()
      const failed = await f2
      await f1
      assert.equal(failed.status, 'error')
      assert.equal(h.calls, 2)
    } finally {
      h.restore()
    }
  })

  test(`${p.name} (${p.runtime}): the /usage command during a poll prints the numbers`, async () => {
    const h = mount(p)
    try {
      h.gate = deferred()
      const poll = h.api.refresh()
      const reported = h.command.handler({})
      h.gate.resolve()
      await poll
      const result = await reported
      assert.equal(result.kind, 'success')
      assert.match(result.text, p.numbers)
      assert.equal(h.calls, 1)
    } finally {
      h.restore()
    }
  })
}

for (const p of PROVIDERS) {
  test(`${p.name}: the report ends with the shared footer (ready: last good read; stale: plus the failure warning)`, async () => {
    const h = mount(p)
    try {
      await h.api.refresh()
      const ready = await h.command.handler({})
      assert.equal(ready.kind, 'success')
      const readyLines = ready.text.split('\n')
      assert.equal(readyLines.at(-1), `Last good read: ${time(BASE)}`)
      assert.ok(!readyLines.some((line) => line.startsWith('Warning:')))
      assert.ok(!readyLines.some((line) => line.startsWith('Read at')), 'the old Read-at line is gone')

      h.setNow(BASE + 60_000)
      h.fail()
      const stale = await h.command.handler({})
      assert.equal(stale.kind, 'success', 'a stale report still carries the last good numbers')
      assert.match(stale.text, p.numbers)
      const state = await h.api.snapshot()
      const staleLines = stale.text.split('\n')
      assert.equal(staleLines.at(-2), `Last good read: ${time(BASE)}`)
      assert.equal(staleLines.at(-1), `Warning: last refresh failed at ${time(BASE + 60_000)} (${state.error}): ${state.detail}`)
    } finally {
      h.restore()
    }
  })

  test(`${p.name}: with no good read the command still returns kind error`, async () => {
    const h = mount(p)
    try {
      h.fail()
      const result = await h.command.handler({})
      assert.equal(result.kind, 'error')
      assert.match(result.text, /usage unavailable/)
      const state = await h.api.snapshot()
      assert.equal(state.fetchedAt, null, 'no good read: fetchedAt stays null')
      assert.equal(state.attemptedAt, BASE)
    } finally {
      h.restore()
    }
  })
}

test('the state is additive: attemptedAt is new, nothing is versioned or renamed', async () => {
  const h = mount(PROVIDERS[0])
  try {
    const idle = await h.api.snapshot()
    assert.deepEqual(Object.keys(idle).sort(), ['attemptedAt', 'data', 'detail', 'endpoint', 'error', 'fetchedAt', 'status', 'ui'])
    const ready = await h.api.refresh()
    assert.deepEqual(Object.keys(ready).sort(), Object.keys(idle).sort())
    assert.ok(!Object.keys(ready).some((key) => /version/i.test(key)))
  } finally {
    h.restore()
  }
  const o = mount(PROVIDERS.find((p) => p.name === 'OpenRouter'))
  try {
    const keys = Object.keys(await o.api.snapshot()).sort()
    assert.deepEqual(keys, ['account', 'attemptedAt', 'data', 'detail', 'error', 'fetchedAt', 'status', 'ui'])
  } finally {
    o.restore()
  }
  const k = mount(PROVIDERS.find((p) => p.name === 'Kimi'))
  try {
    const keys = Object.keys(await k.api.snapshot()).sort()
    assert.deepEqual(keys, ['attemptedAt', 'data', 'detail', 'endpoint', 'error', 'fetchedAt', 'status', 'ui'])
  } finally {
    k.restore()
  }
})

test('usageFooter formats a state without attemptedAt (an older host or test fixture)', () => {
  const old = { status: 'error', error: 'network', detail: 'offline', fetchedAt: BASE, data: {} }
  assert.deepEqual(usageFooter(old), [
    `Last good read: ${time(BASE)}`,
    `Warning: last refresh failed at ${time(BASE)} (network): offline`,
  ])
  assert.deepEqual(usageFooter({ status: 'ready', fetchedAt: BASE, data: {} }), [`Last good read: ${time(BASE)}`])
  assert.deepEqual(usageFooter({ status: 'error', error: 'timeout', detail: 'slow', fetchedAt: BASE, attemptedAt: BASE + 5000 }), [
    `Last good read: ${time(BASE)}`,
    `Warning: last refresh failed at ${time(BASE + 5000)} (timeout): slow`,
  ])
  assert.deepEqual(usageFooter({ status: 'error', error: 'timeout', detail: null, fetchedAt: null, attemptedAt: BASE }), [
    'Last good read: never',
    `Warning: last refresh failed at ${time(BASE)} (timeout):`,
  ])
})

for (const p of PROVIDERS.filter((x) => x.runtime === 'net.js')) {
  test(`${p.name}: a missing credential says ${p.oauth ? 'how to sign in' : 'to add the API key'}`, async () => {
    const h = mount(p, { missingCredential: true })
    try {
      const state = await h.api.refresh()
      assert.equal(state.status, 'error')
      assert.equal(state.error, 'missing-credential')
      assert.equal(h.calls, 0, 'no request without a credential')
      if (p.oauth) {
        assert.match(state.detail, new RegExp(`Sign in from Settings → Models or run /provider-login ${p.oauth}`))
        assert.ok(!state.detail.includes('Add the API key'))
      } else {
        assert.match(state.detail, /Add the API key in Settings → Models/)
        assert.ok(!state.detail.includes('provider-login'))
      }
      const result = await h.command.handler({})
      assert.equal(result.kind, 'error')
      assert.ok(result.text.includes(state.detail))
    } finally {
      h.restore()
    }
  })
}
