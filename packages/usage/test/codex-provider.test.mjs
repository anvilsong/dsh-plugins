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

test('Codex usage parses plan, windows, credits, and report', async () => {
  const h = harness({
    plan_type: 'free',
    rate_limit: {
      allowed: true,
      primary_window: { used_percent: 42.5, limit_window_seconds: 2592000, reset_at: 1797339952 },
      secondary_window: null,
    },
    credits: { has_credits: false, unlimited: false, balance: null },
    spend_control: { reached: false },
    rate_limit_reset_credits: { available_count: 0 },
  })
  try {
    mountCodex(h.ctx)
    const state = await h.api().refresh()
    assert.equal(state.status, 'ready')
    assert.equal(state.data.kind, 'quota')
    assert.equal(state.data.planType, 'free')
    assert.equal(state.data.windows.length, 1)
    assert.equal(state.data.windows[0].label, '30-day window')
    assert.equal(state.data.windows[0].usedRatio, 0.425)
    const report = await h.command().handler({})
    assert.match(report.text, /OpenAI Codex usage/)
    assert.match(report.text, /42.5% used/)
    assert.match(report.text, /Credits: none/)
  } finally {
    h.restore()
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
