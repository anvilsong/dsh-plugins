import assert from 'node:assert/strict'
import test from 'node:test'
import { foldAdvisor, INITIAL_ADVISOR_STATE, viewAdvisor } from '../src/state.js'

const run = (args, commandId = 'a', time = 100) => ({ type: 'command/run', time, data: { name: 'advisor', args, commandId } })
const done = (kind, commandId = 'a', text) => ({ type: 'command/done', data: { kind, commandId, ...(text === undefined ? {} : { text }) } })
const selected = { provider: 'openrouter', model: '~deepseek/deepseek-flash-latest' }

test('off and Inherit by default, with legacy verifier commands ignored', () => {
  assert.deepEqual(INITIAL_ADVISOR_STATE, { active: false, verifierModel: null, advisorModel: null, pending: null, lastRun: null, failure: null })
  assert.deepEqual(viewAdvisor(INITIAL_ADVISOR_STATE), {
    active: false, verifierModel: null, advisorModel: null, pending: false, pendingTarget: null, pendingSince: null, failure: null,
  })
  assert.equal(foldAdvisor(INITIAL_ADVISOR_STATE, run('verifier on')), INITIAL_ADVISOR_STATE)
  assert.equal(foldAdvisor(INITIAL_ADVISOR_STATE, run('verifier off')), INITIAL_ADVISOR_STATE)
})

test('on, off, and verifier-model transitions commit only on success', () => {
  let state = foldAdvisor(INITIAL_ADVISOR_STATE, run('on'))
  assert.equal(state.pending.target, 'advisor')
  assert.equal(viewAdvisor(state).pendingTarget, 'advisor')
  state = foldAdvisor(state, done('success'))
  assert.equal(state.active, true)
  assert.equal(state.verifierModel, null)
  state = foldAdvisor(state, run('verifier-model openrouter/~deepseek/deepseek-flash-latest', 'm'))
  assert.deepEqual(state.pending.route, selected)
  state = foldAdvisor(state, done('success', 'm'))
  assert.deepEqual(state.verifierModel, selected)
  state = foldAdvisor(state, run('off', 'b'))
  state = foldAdvisor(state, done('success', 'b'))
  assert.equal(state.active, false)
  assert.deepEqual(state.verifierModel, selected)
  state = foldAdvisor(state, run('on', 'c'))
  state = foldAdvisor(state, done('success', 'c'))
  assert.equal(state.active, true)
  assert.deepEqual(state.verifierModel, selected)
  state = foldAdvisor(state, run('verifier-model inherit', 'i'))
  state = foldAdvisor(state, done('success', 'i'))
  assert.equal(state.verifierModel, null)
})

test('errors preserve active and model, clear pending, and reject overlaps', () => {
  const enabled = { active: true, verifierModel: selected, pending: null }
  let state = foldAdvisor(enabled, run('off', 'a', 100))
  state = foldAdvisor(state, done('error'))
  assert.equal(state.active, true)
  assert.deepEqual(state.verifierModel, selected)
  assert.equal(state.pending, null)
  const pending = foldAdvisor(state, run('verifier-model anthropic/claude-haiku-5-5', 'a', 100))
  const overlapped = foldAdvisor(pending, run('off', 'b', 200))
  assert.equal(overlapped.pending, pending.pending)
  state = foldAdvisor(overlapped, done('error', 'b', 'Advisor is already updating. Try again after it finishes.'))
  assert.deepEqual(state.failure, { count: 2, text: 'Advisor is already updating. Try again after it finishes.', target: 'advisor' })
  assert.equal(state.pending.commandId, 'a')
  state = foldAdvisor(state, done('error', 'a', 'Route is not authorized'))
  assert.deepEqual(viewAdvisor(state).failure, { count: 3, text: 'Route is not authorized', target: 'verifierModel' })
  assert.equal(state.active, true)
  assert.deepEqual(state.verifierModel, selected)
  state = foldAdvisor(state, run('verifier-model anthropic/claude-haiku-5-5', 'c', 300))
  state = foldAdvisor(state, done('success', 'c'))
  assert.deepEqual(state.verifierModel, { provider: 'anthropic', model: 'claude-haiku-5-5' })
  assert.equal(foldAdvisor(state, run('verifier-model broken')), state)
})

test('advisor model is Inherit or a route and commits only on success', () => {
  let state = foldAdvisor(INITIAL_ADVISOR_STATE, run('model anthropic/claude-fable-5-2', 'p'))
  assert.equal(state.pending.target, 'advisorModel')
  assert.equal(state.advisorModel, null)
  state = foldAdvisor(state, done('error', 'p', 'not authorized'))
  assert.equal(state.advisorModel, null)
  assert.deepEqual(state.failure, { count: 1, text: 'not authorized', target: 'advisorModel' })
  state = foldAdvisor(state, run('model anthropic/claude-fable-5-2', 'q'))
  state = foldAdvisor(state, done('success', 'q'))
  assert.deepEqual(state.advisorModel, { provider: 'anthropic', model: 'claude-fable-5-2' })
  assert.deepEqual(viewAdvisor(state).advisorModel, { provider: 'anthropic', model: 'claude-fable-5-2' })
  assert.equal(state.verifierModel, null, 'the verifier model is independent')
  state = foldAdvisor(state, run('model INHERIT', 'r'))
  state = foldAdvisor(state, done('success', 'r'))
  assert.equal(state.advisorModel, null)
  assert.equal(foldAdvisor(state, run('model nonsense')), state)
  assert.equal(foldAdvisor(state, run('model /x')), state)
  assert.equal(foldAdvisor(state, run('planner inherit')), state, 'the 0.5 planner command is not folded')
})
