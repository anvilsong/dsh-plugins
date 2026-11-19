import assert from 'node:assert/strict'
import test from 'node:test'
import { mountCodex } from '../src/providers/codex.js'
import { readFileSync } from 'node:fs'

function harness(body) {
  let api
  let command
  const ctx = {
    credentials: { readRecord: async () => ({ kind: 'grant', payload: { access: 'test-token' } }) },
    provide(key, value) { if (key === 'codexUsage') api = value },
    commands: { register(value) { command = value } },
    effect() {},
  }
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  return { ctx, api: () => api, command: () => command, restore: () => { globalThis.fetch = oldFetch } }
}

test('Codex usage parses the live plan, sole window, credits, and reset credits', async () => {
  const h = harness({
    plan_type: 'free',
    rate_limit: {
      allowed: true,
      primary_window: { used_percent: 0, limit_window_seconds: 2592000, reset_at: 1797339952 },
      secondary_window: null,
    },
    credits: { has_credits: false, unlimited: false, balance: null },
    spend_control: { reached: false },
    rate_limit_reset_credits: { available_count: 0 },
    model_usage: {},
    additional_rate_limits: null,
  })
  try {
    mountCodex(h.ctx)
    const state = await h.api().refresh()
    assert.equal(state.status, 'ready')
    assert.equal(state.data.kind, 'quota')
    assert.equal(state.data.level, 'free')
    assert.equal(state.data.planType, 'free')
    assert.deepEqual(state.data.windows, [{
      key: 'primary',
      label: '30-day window',
      usedRatio: 0,
      resetAt: new Date(1797339952 * 1000).toISOString(),
      windowSeconds: 2592000,
    }])
    assert.equal(state.data.windows.some((window) => window.key === 'secondary'), false)
    assert.deepEqual(state.data.credits, { hasCredits: false, unlimited: false, balance: null })
    assert.equal(state.data.resetCreditsAvailable, 0)
    assert.equal(state.data.ordinaryUsageAllowed, true)
    assert.equal(state.data.spendControlReached, false)
    const report = await h.command().handler({})
    assert.match(report.text, /OpenAI Codex usage/)
    assert.match(report.text, /Plan: free/)
    assert.match(report.text, /0\.0% used/)
    assert.match(report.text, /Credits: none/)
    assert.match(report.text, /Rate-limit reset credits available: 0/)
  } finally {
    h.restore()
  }
})

test('Codex usage normalizes numeric and numeric-string credit balances', async () => {
  for (const balance of [12.5, '12.5']) {
    const h = harness({
      plan_type: 'pro',
      rate_limit: { primary_window: { used_percent: 42.5, limit_window_seconds: 18000 } },
      credits: { has_credits: true, unlimited: false, balance },
      rate_limit_reset_credits: { available_count: 2 },
    })
    try {
      mountCodex(h.ctx)
      const state = await h.api().refresh()
      assert.equal(state.status, 'ready')
      assert.equal(state.data.credits.balance, 12.5)
      assert.equal(state.data.windows[0].label, '5-hour window')
      assert.equal(state.data.windows[0].usedRatio, 0.425)
      assert.equal(state.data.resetCreditsAvailable, 2)
    } finally {
      h.restore()
    }
  }
})

test('Codex card uses DSH model-card design tokens', () => {
  const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.match(source, /settings-card-stroke/)
  assert.match(source, /settings-card-fill/)
  assert.match(source, /border-radius:var\(--dsw-radius-xl\)/)
  assert.match(source, /border-radius:var\(--dsw-radius-sm\);height:28px;padding:0 10px/)
  assert.match(source, /interactive-bg-hover-solid/)
})

test('Codex usage rejects a malformed response', async () => {
  const h = harness({ plan_type: 'free' })
  try {
    mountCodex(h.ctx)
    const state = await h.api().refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'bad-response')
  } finally {
    h.restore()
  }
})

function windowBody(resetAt) {
  return { plan_type: 'plus', rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: resetAt } } }
}

test('Codex reset_at that is out of range, negative or not a number gives resetAt null with status ready', async () => {
  for (const value of [1e20, -1, -1797339952, 'garbage', null, Number.MAX_VALUE, 8.64e12 + 1]) {
    const h = harness(windowBody(value))
    try {
      mountCodex(h.ctx)
      const state = await h.api().refresh()
      assert.equal(state.status, 'ready', String(value))
      assert.equal(state.error, null, String(value))
      assert.equal(state.data.windows[0].resetAt, null, String(value))
      assert.equal(state.data.windows[0].usedRatio, 0.1, String(value))
      const report = await h.command().handler({})
      assert.equal(report.kind, 'success')
      assert.doesNotMatch(report.text, /resets /)
    } finally {
      h.restore()
    }
  }
})

test('Codex reset_at as a number or a numeric string still gives the ISO time (epoch seconds)', async () => {
  for (const value of [1797339952, '1797339952']) {
    const h = harness(windowBody(value))
    try {
      mountCodex(h.ctx)
      const state = await h.api().refresh()
      assert.equal(state.status, 'ready')
      assert.equal(state.data.windows[0].resetAt, new Date(1797339952 * 1000).toISOString(), String(value))
    } finally {
      h.restore()
    }
  }
})
