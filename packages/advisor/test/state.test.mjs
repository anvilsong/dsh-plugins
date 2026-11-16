import assert from 'node:assert/strict'
import test from 'node:test'
import { foldAdvisor, INITIAL_ADVISOR_STATE, viewAdvisor } from '../src/state.js'

const run = (args, commandId = 'a', time = 100) => ({ type: 'command/run', time, data: { name: 'advisor', args, commandId } })
const done = (kind, commandId = 'a') => ({ type: 'command/done', data: { kind, commandId } })

test('off by default', () => {
  assert.deepEqual(INITIAL_ADVISOR_STATE, { active: false, pending: null })
  assert.deepEqual(viewAdvisor(INITIAL_ADVISOR_STATE), { active: false, pending: false })
})

test('on and off commit only on success', () => {
  let state = foldAdvisor(INITIAL_ADVISOR_STATE, run('on'))
  assert.equal(state.pending.arg, true)
  state = foldAdvisor(state, done('success'))
  assert.equal(state.active, true)
  state = foldAdvisor(state, run('off', 'b'))
  state = foldAdvisor(state, done('success', 'b'))
  assert.equal(state.active, false)
})

test('error preserves active and rejects overlapping commands', () => {
  let state = foldAdvisor(INITIAL_ADVISOR_STATE, run('on'))
  state = foldAdvisor(state, done('error'))
  assert.equal(state.active, false)
  const pending = foldAdvisor(state, run('on', 'a', 100))
  assert.equal(foldAdvisor(pending, run('off', 'b', 200)), pending)
})
