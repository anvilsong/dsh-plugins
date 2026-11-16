import assert from 'node:assert/strict'
import test from 'node:test'
import { foldRouter, INITIAL_ROUTER_STATE, viewRouter } from '../src/state.js'

const run = (args, commandId = 'a', time = 100) => ({ type: 'command/run', time, data: { name: 'router', args, commandId } })
const done = (kind, commandId = 'a', text) => ({ type: 'command/done', data: { kind, commandId, ...(text === undefined ? {} : { text }) } })
const selected = [{ provider: 'openrouter', model: '~deepseek/deepseek-flash-latest' }]

test('router is off with Inherit at every level by default', () => {
  assert.deepEqual(INITIAL_ROUTER_STATE, {
    mode: 'off',
    selections: { mechanical: null, ordinary: null, hard: null },
    pending: null,
    lastRun: null,
    failure: null,
  })
  assert.deepEqual(viewRouter(INITIAL_ROUTER_STATE), {
    mode: 'off',
    pending: false,
    pendingTarget: null,
    pendingLevel: null,
    pendingSince: null,
    selections: { mechanical: null, ordinary: null, hard: null },
    failure: null,
  })
})

test('manual and off commit only on success and retain level selections', () => {
  let state = foldRouter(INITIAL_ROUTER_STATE, run('manual'))
  assert.equal(state.pending.arg, 'manual')
  state = foldRouter(state, done('success'))
  assert.equal(state.mode, 'manual')
  state = foldRouter(state, run('level mechanical openrouter/~deepseek/deepseek-flash-latest', 'l'))
  assert.equal(state.pending.target, 'level')
  assert.equal(state.pending.level, 'mechanical')
  state = foldRouter(state, done('success', 'l'))
  assert.deepEqual(state.selections.mechanical, selected)
  assert.equal(viewRouter(state).pendingLevel, null)
  state = foldRouter(state, run('off', 'b'))
  state = foldRouter(state, done('success', 'b'))
  assert.equal(state.mode, 'off')
  assert.deepEqual(state.selections.mechanical, selected)
  state = foldRouter(state, run('on', 'c'))
  state = foldRouter(state, done('success', 'c'))
  assert.equal(state.mode, 'manual')
  assert.deepEqual(state.selections.mechanical, selected)
})

test('bare command toggles mode and level inherit resets selection', () => {
  let state = foldRouter(INITIAL_ROUTER_STATE, run(''))
  state = foldRouter(state, done('success'))
  assert.equal(state.mode, 'manual')
  state = foldRouter(state, run('level hard anthropic/claude-opus-5-5', 'l'))
  state = foldRouter(state, done('success', 'l'))
  assert.equal(state.selections.hard[0].provider, 'anthropic')
  state = foldRouter(state, run('level hard inherit', 'i'))
  state = foldRouter(state, done('success', 'i'))
  assert.equal(state.selections.hard, null)
  state = foldRouter(state, run('', 'b'))
  state = foldRouter(state, done('success', 'b'))
  assert.equal(state.mode, 'off')
})

test('errors preserve mode and selections, clear pending, and reject overlaps', () => {
  const enabled = {
    mode: 'manual',
    selections: { mechanical: selected, ordinary: null, hard: null },
    pending: null,
  }
  let state = foldRouter(enabled, run('off', 'a', 100))
  state = foldRouter(state, done('error'))
  assert.equal(state.mode, 'manual')
  assert.deepEqual(state.selections.mechanical, selected)
  assert.equal(state.pending, null)
  const pending = foldRouter(state, run('level mechanical anthropic/claude-haiku-5-5', 'a', 100))
  const overlapped = foldRouter(pending, run('off', 'b', 200))
  assert.equal(overlapped.pending, pending.pending)
  assert.equal(overlapped.mode, pending.mode)
  state = foldRouter(pending, done('error'))
  assert.equal(state.mode, 'manual')
  assert.deepEqual(state.selections.mechanical, selected)
  state = foldRouter(state, run('level mechanical anthropic/claude-haiku-5-5', 'c', 300))
  state = foldRouter(state, done('success', 'c'))
  assert.equal(state.selections.mechanical[0].provider, 'anthropic')
  assert.deepEqual(foldRouter(state, run('level mechanical broken')), state)
  const restored = {
    ...state,
    pending: { target: 'mode', arg: 'off', commandId: 'interrupted', startedAt: 1 },
  }
  // The view stays pure; the Client ages pendingSince against its own clock.
  assert.equal(viewRouter(restored).pending, true)
  assert.equal(viewRouter(restored).pendingSince, 1)
})

test('failures from admitted and rejected-overlap commands are recorded with their text', () => {
  let state = foldRouter(INITIAL_ROUTER_STATE, run('level ordinary anthropic/claude-haiku-5-5', 'a', 100))
  state = foldRouter(state, run('off', 'b', 150))
  state = foldRouter(state, done('error', 'b', 'Router is already updating. Try again after it finishes.'))
  assert.deepEqual(state.failure, { count: 1, text: 'Router is already updating. Try again after it finishes.', target: 'mode', level: null })
  assert.equal(state.pending.commandId, 'a')
  state = foldRouter(state, done('error', 'a', 'Route x is not authorized'))
  assert.deepEqual(state.failure, { count: 2, text: 'Route x is not authorized', target: 'level', level: 'ordinary' })
  assert.equal(state.pending, null)
  assert.deepEqual(viewRouter(state).failure, state.failure)
  const unchanged = foldRouter(state, done('error', 'unknown'))
  assert.equal(unchanged, state)
})

test('a done event without a commandId leaves the state unchanged when nothing is pending', () => {
  // The fold sees every command's done event, not only router ones.
  const idle = foldRouter(foldRouter(INITIAL_ROUTER_STATE, run('manual')), done('success'))
  assert.equal(idle.pending, null)
  for (const state of [INITIAL_ROUTER_STATE, idle]) {
    for (const kind of ['success', 'error']) {
      const event = { type: 'command/done', data: { kind } }
      assert.doesNotThrow(() => foldRouter(state, event))
      assert.equal(foldRouter(state, event), state)
    }
  }
})

test('a done event without a commandId does not match a missing lastRun', () => {
  const restored = { ...INITIAL_ROUTER_STATE, pending: { target: 'mode', arg: 'off', commandId: 'p', startedAt: 1 } }
  const event = { type: 'command/done', data: { kind: 'error', text: 'unrelated' } }
  assert.doesNotThrow(() => foldRouter(restored, event))
  assert.equal(foldRouter(restored, event), restored)
})
