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

test('Claude usage parses the live weekly window, scoped limit, extra usage, spend, and breakdown', async () => {
  const h = harness({
    five_hour: null,
    seven_day: { utilization: 100, resets_at: '2026-11-16T06:00:00.203647+00:00' },
    limits: [
      { kind: 'weekly_all', percent: 100, resets_at: '2026-11-16T06:00:00.203647+00:00' },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 4,
        severity: 'normal',
        resets_at: '2026-11-16T06:00:00.203776+00:00',
        scope: { model: { id: null, display_name: 'Fable' }, surface: null },
        is_active: false,
      },
    ],
    extra_usage: {
      is_enabled: true,
      monthly_limit: null,
      used_credits: 0,
      utilization: null,
      currency: 'USD',
      disabled_reason: null,
    },
    spend: { used: { amount_minor: 0, currency: 'USD', exponent: 2 }, limit: null, spend_limit_reached: false },
    seven_day_breakdown: {
      rows: [
        { display_name: 'Claude Code', percent: 100 },
        { display_name: 'Chats', percent: 0 },
        { display_name: 'Cowork', percent: 0 },
        { display_name: 'Other', percent: 0 },
      ],
    },
  })
  try {
    mountAnthropic(h.ctx)
    const state = await h.api().refresh()
    assert.equal(state.status, 'ready')
    assert.equal(state.data.kind, 'quota')
    assert.deepEqual(state.data.windows, [{
      key: 'sevenDay',
      label: '7-day window',
      usedRatio: 1,
      resetAt: '2026-11-16T06:00:00.203647+00:00',
    }])
    assert.equal(state.data.windows.some((window) => window.key === 'fiveHour'), false)
    assert.equal(state.data.limits.length, 2)
    assert.deepEqual(state.data.limits[1], {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 4,
      usedRatio: 0.04,
      severity: 'normal',
      resetAt: '2026-11-16T06:00:00.203776+00:00',
      scope: { model: { id: null, displayName: 'Fable' }, surface: null },
      isActive: false,
    })
    assert.equal(state.data.windows.some((window) => window.label.includes('Fable')), false)
    assert.deepEqual(state.data.extra, {
      enabled: true,
      balanceCents: 0,
      monthlyLimitCents: null,
      usedRatio: null,
      currency: 'USD',
      disabledReason: null,
    })
    assert.deepEqual(state.data.spend, {
      usedMinor: 0,
      currency: 'USD',
      exponent: 2,
      limitMinor: null,
      limitCurrency: null,
      limitExponent: null,
      reached: false,
    })
    assert.deepEqual(state.data.breakdown, [
      { displayName: 'Claude Code', percent: 100 },
      { displayName: 'Chats', percent: 0 },
      { displayName: 'Cowork', percent: 0 },
      { displayName: 'Other', percent: 0 },
    ])
    const report = await h.command().handler({})
    assert.match(report.text, /Claude usage/)
    assert.match(report.text, /100.0% used/)
    assert.match(report.text, /Extra usage: 0.00 USD/)
    assert.match(report.text, /Usage credits spent: 0.00 USD/)
    assert.match(report.text, /Fable limit: 4.0% used/)
    assert.match(report.text, /Breakdown: Claude Code 100% · Chats 0% · Cowork 0% · Other 0%/)
    assert.doesNotMatch(report.text, /5-hour window/)
  } finally {
    h.restore()
  }
})

test('Claude usage converts extra and spend amounts without inventing windows', async () => {
  const h = harness({
    seven_day: { utilization: 25, resets_at: '2026-11-20T00:00:00Z' },
    extra_usage: { is_enabled: true, used_credits: 12.34, monthly_limit: 50, utilization: 24.68, currency: 'USD' },
    spend: {
      used: { amount_minor: 1234, currency: 'USD', exponent: 2 },
      limit: { amount_minor: 5000, currency: 'USD', exponent: 2 },
      spend_limit_reached: false,
    },
  })
  try {
    mountAnthropic(h.ctx)
    const state = await h.api().refresh()
    assert.equal(state.status, 'ready')
    assert.deepEqual(state.data.windows.map((window) => window.key), ['sevenDay'])
    assert.equal(state.data.extra.balanceCents, 1234)
    assert.equal(state.data.extra.monthlyLimitCents, 5000)
    assert.equal(state.data.extra.usedRatio, 0.2468)
    assert.equal(state.data.spend.usedMinor, 1234)
    assert.equal(state.data.spend.limitMinor, 5000)
    assert.equal(state.data.spend.limitCurrency, 'USD')
    assert.equal(state.data.spend.limitExponent, 2)
  } finally {
    h.restore()
  }
})

test('Claude usage includes model windows only when the reply contains them', async () => {
  const h = harness({
    five_hour: null,
    seven_day: { utilization: 25 },
    seven_day_opus: { utilization: 30 },
    seven_day_sonnet: { utilization: 40 },
  })
  try {
    mountAnthropic(h.ctx)
    const state = await h.api().refresh()
    assert.equal(state.status, 'ready')
    assert.deepEqual(state.data.windows.map((window) => window.key), ['sevenDay', 'sevenDayOpus', 'sevenDaySonnet'])
    assert.deepEqual(state.data.windows.map((window) => window.usedRatio), [0.25, 0.3, 0.4])
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
