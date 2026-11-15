import assert from 'node:assert/strict'
import test from 'node:test'
import { mountAnthropic } from '../src/providers/anthropic.js'

function harness(body) {
  let api
  let command
  const ctx = {
    credentials: { readRecord: async () => ({ kind: 'grant', payload: { access: 'test-token' } }) },
    provide(key, value) { if (key === 'anthropicUsage') api = value },
    commands: { register(value) { command = value } },
    effect() {},
  }
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  return { ctx, api: () => api, command: () => command, restore: () => { globalThis.fetch = oldFetch } }
}

test('Claude usage parses weekly windows, extra usage, and spend', async () => {
  const h = harness({
    five_hour: null,
    seven_day: { utilization: 100, resets_at: '2026-11-16T06:00:00.203647+00:00' },
    limits: [{ kind: 'weekly_all', percent: 100, resets_at: '2026-11-16T06:00:00.203647+00:00' }],
    extra_usage: { is_enabled: true, used_credits: 0, monthly_limit: null, currency: 'USD', disabled_reason: null },
    spend: { used: { amount_minor: 0, currency: 'USD', exponent: 2 }, limit: null, spend_limit_reached: false },
    seven_day_breakdown: { rows: [{ display_name: 'Claude Code', percent: 100 }] },
  })
  try {
    mountAnthropic(h.ctx)
    const state = await h.api().refresh()
    assert.equal(state.status, 'ready')
    assert.equal(state.data.kind, 'quota')
    assert.equal(state.data.windows[0].usedRatio, 1)
    assert.equal(state.data.extra.balanceCents, 0)
    assert.equal(state.data.spend.usedMinor, 0)
    assert.equal(state.data.breakdown[0].displayName, 'Claude Code')
    const report = await h.command().handler({})
    assert.match(report.text, /Claude usage/)
    assert.match(report.text, /100.0% used/)
    assert.match(report.text, /Extra usage: 0.00 USD/)
  } finally {
    h.restore()
  }
})

test('Claude usage rejects a response without windows', async () => {
  const h = harness({})
  try {
    mountAnthropic(h.ctx)
    const state = await h.api().refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'bad-response')
  } finally {
    h.restore()
  }
})
