import assert from 'node:assert/strict'
import test from 'node:test'
import { foldUltracode, INITIAL_ULTRACODE_STATE, viewUltracode } from '../src/state.js'

const run = (args, commandId = 'cmd-1') => ({
  type: 'command/run',
  data: { name: 'ultracode', args, commandId },
})
const done = (kind, commandId = 'cmd-1') => ({
  type: 'command/done',
  data: { kind, commandId },
})

test('off by default', () => {
  assert.deepEqual(INITIAL_ULTRACODE_STATE, { active: false, pending: null, commandId: null })
  assert.deepEqual(viewUltracode(INITIAL_ULTRACODE_STATE), { active: false, pending: false })
})

test('successful on commits active', () => {
  const pending = foldUltracode(INITIAL_ULTRACODE_STATE, run('on'))
  assert.deepEqual(pending, { active: false, pending: true, commandId: 'cmd-1' })
  assert.deepEqual(viewUltracode(pending), { active: false, pending: true })
  const active = foldUltracode(pending, done('success'))
  assert.deepEqual(active, { active: true, pending: null, commandId: null })
  assert.deepEqual(viewUltracode(active), { active: true, pending: false })
})

test('successful off disables after an on', () => {
  const active = foldUltracode(foldUltracode(INITIAL_ULTRACODE_STATE, run('on')), done('success'))
  const pending = foldUltracode(active, run('off', 'cmd-2'))
  const off = foldUltracode(pending, done('success', 'cmd-2'))
  assert.equal(off.active, false)
  assert.equal(off.pending, null)
})

test('an error preserves the previous active value', () => {
  const active = foldUltracode(foldUltracode(INITIAL_ULTRACODE_STATE, run('on')), done('success'))
  const failed = foldUltracode(foldUltracode(active, run('off', 'cmd-2')), done('error', 'cmd-2'))
  assert.equal(failed.active, true)
  assert.equal(failed.pending, null)
})

test('a cold fold reconstructs the latest state from command history', () => {
  const history = [
    run('on', 'a'),
    done('success', 'a'),
    run('off', 'b'),
    done('success', 'b'),
    run('on', 'c'),
  ]
  const state = history.reduce(foldUltracode, INITIAL_ULTRACODE_STATE)
  assert.equal(state.active, false)
  assert.equal(state.pending, true)
  assert.equal(state.commandId, 'c')
  const settled = foldUltracode(state, done('success', 'c'))
  assert.equal(settled.active, true)
})

test('other commands and malformed args do not change state', () => {
  const state = { active: true, pending: null, commandId: null }
  assert.equal(foldUltracode(state, { type: 'command/run', data: { name: 'plan', args: 'off' } }), state)
  assert.equal(foldUltracode(state, run('status')), state)
  assert.equal(foldUltracode(state, { type: 'turn/end', data: {} }), state)
})
