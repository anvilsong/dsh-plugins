import assert from 'node:assert/strict'
import test from 'node:test'
import { foldUltracode, INITIAL_ULTRACODE_STATE, viewUltracode, STALE_PENDING_MS } from '../src/state.js'

const run = (args, commandId = 'cmd-1', time = 100) => ({
  type: 'command/run',
  time,
  data: { name: 'ultracode', args, commandId },
})
const done = (kind, commandId = 'cmd-1') => ({ type: 'command/done', data: { kind, commandId } })

test('off by default', () => {
  assert.deepEqual(INITIAL_ULTRACODE_STATE, { active: false, pending: null })
  assert.deepEqual(viewUltracode(INITIAL_ULTRACODE_STATE), { active: false, pending: false })
})

test('successful on commits active', () => {
  const pending = foldUltracode(INITIAL_ULTRACODE_STATE, run('on'))
  assert.equal(pending.pending.arg, true)
  const active = foldUltracode(pending, done('success'))
  assert.deepEqual(active, { active: true, pending: null })
  assert.deepEqual(viewUltracode(active), { active: true, pending: false })
})

test('successful off clears active', () => {
  let state = foldUltracode(INITIAL_ULTRACODE_STATE, run('on'))
  state = foldUltracode(state, done('success'))
  state = foldUltracode(state, run('off', 'cmd-2'))
  state = foldUltracode(state, done('success', 'cmd-2'))
  assert.deepEqual(state, { active: false, pending: null })
})

test('failed commands preserve the previous active value', () => {
  let state = foldUltracode(INITIAL_ULTRACODE_STATE, run('on'))
  state = foldUltracode(state, done('error'))
  assert.equal(state.active, false)
  assert.equal(state.pending, null)
})

test('a second command is rejected while one is pending', () => {
  const pending = foldUltracode(INITIAL_ULTRACODE_STATE, run('on', 'a', 100))
  assert.equal(foldUltracode(pending, run('off', 'b', 200)), pending)
  assert.equal(foldUltracode(pending, run('on', 'b', 200)), pending)
})

test('an expired pending command can be replaced', () => {
  const pending = foldUltracode(INITIAL_ULTRACODE_STATE, run('on', 'a', 100))
  const next = foldUltracode(pending, run('off', 'b', 100 + STALE_PENDING_MS + 1))
  assert.equal(next.pending.commandId, 'b')
  assert.equal(next.pending.arg, false)
})

test('mismatched done is ignored', () => {
  const pending = foldUltracode(INITIAL_ULTRACODE_STATE, run('on'))
  assert.equal(foldUltracode(pending, done('success', 'other')), pending)
})

test('a cold fold reconstructs the latest state from command history', () => {
  const history = [run('on', 'a'), done('success', 'a'), run('off', 'b'), done('success', 'b'), run('on', 'c')]
  const state = history.reduce(foldUltracode, INITIAL_ULTRACODE_STATE)
  assert.equal(state.active, false)
  assert.equal(state.pending.arg, true)
  assert.equal(foldUltracode(state, done('success', 'c')).active, true)
})
