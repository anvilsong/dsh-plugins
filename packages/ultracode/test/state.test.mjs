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
  assert.deepEqual(INITIAL_ULTRACODE_STATE, {
    active: false,
    pending: null,
    commandId: null,
    teamEnabled: false,
    teamBeforeOn: null,
    teamChangedByUs: false,
  })
  assert.deepEqual(viewUltracode(INITIAL_ULTRACODE_STATE), { active: false, pending: false, teamEnabled: false })
})

test('successful on commits active', () => {
  const pending = foldUltracode(INITIAL_ULTRACODE_STATE, run('on'))
  assert.deepEqual(pending, {
    active: false,
    pending: true,
    commandId: 'cmd-1',
    teamEnabled: false,
    teamBeforeOn: false,
    teamChangedByUs: false,
  })
  assert.deepEqual(viewUltracode(pending), { active: false, pending: true, teamEnabled: false })
  const active = foldUltracode(pending, done('success'))
  assert.deepEqual(active, {
    active: true,
    pending: null,
    commandId: null,
    teamEnabled: false,
    teamBeforeOn: false,
    teamChangedByUs: false,
  })
  assert.deepEqual(viewUltracode(active), { active: true, pending: false, teamEnabled: false })
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

test('team enable marks plugin ownership and off restores prior off', () => {
  const pending = foldUltracode(INITIAL_ULTRACODE_STATE, run('on'))
  const teamOn = foldUltracode(pending, { type: 'team/mode', data: { enabled: true } })
  assert.equal(teamOn.teamEnabled, true)
  assert.equal(teamOn.teamChangedByUs, true)
  assert.equal(teamOn.teamBeforeOn, false)
  const active = foldUltracode(teamOn, done('success'))
  const offPending = foldUltracode(active, run('off', 'cmd-2'))
  const teamOff = foldUltracode(offPending, { type: 'team/mode', data: { enabled: false } })
  assert.equal(teamOff.teamEnabled, false)
  assert.equal(teamOff.teamChangedByUs, false)
  assert.equal(foldUltracode(teamOff, done('success', 'cmd-2')).active, false)
})

test('a pre-enabled Team is not disabled by Ultracode off', () => {
  const teamOn = foldUltracode(INITIAL_ULTRACODE_STATE, { type: 'team/mode', data: { enabled: true } })
  const active = foldUltracode(foldUltracode(teamOn, run('on')), done('success'))
  assert.equal(active.teamChangedByUs, false)
  const off = foldUltracode(active, run('off', 'cmd-2'))
  assert.equal(off.teamEnabled, true)
  assert.equal(off.teamChangedByUs, false)
})

test('other commands and malformed args do not change state', () => {
  const state = { active: true, pending: null, commandId: null }
  assert.equal(foldUltracode(state, { type: 'command/run', data: { name: 'plan', args: 'off' } }), state)
  assert.equal(foldUltracode(state, run('status')), state)
  assert.equal(foldUltracode(state, { type: 'turn/end', data: {} }), state)
})
