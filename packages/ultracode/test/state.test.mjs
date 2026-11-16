import assert from 'node:assert/strict'
import test from 'node:test'
import { foldUltracode, INITIAL_ULTRACODE_STATE, viewUltracode, STALE_PENDING_MS } from '../src/state.js'

const run = (args, commandId = 'cmd-1', time = 100) => ({
  type: 'command/run',
  time,
  data: { name: 'ultracode', args, commandId },
})
const done = (kind, commandId = 'cmd-1') => ({ type: 'command/done', data: { kind, commandId } })

function activeRun() {
  let state = foldUltracode(INITIAL_ULTRACODE_STATE, run('on'))
  state = foldUltracode(state, done('success'))
  return foldUltracode(state, { type: 'turn/start', time: 500, data: { turn: 1 } })
}

test('off by default', () => {
  assert.deepEqual(INITIAL_ULTRACODE_STATE, { active: false, pending: null, run: null })
  assert.deepEqual(viewUltracode(INITIAL_ULTRACODE_STATE), { active: false, pending: false, run: null })
})

test('successful on commits active', () => {
  const pending = foldUltracode(INITIAL_ULTRACODE_STATE, run('on'))
  assert.equal(pending.pending.arg, true)
  const active = foldUltracode(pending, done('success'))
  assert.deepEqual(active, { active: true, pending: null, run: null })
  assert.deepEqual(viewUltracode(active), { active: true, pending: false, run: null })
})

test('successful off clears active', () => {
  let state = foldUltracode(INITIAL_ULTRACODE_STATE, run('on'))
  state = foldUltracode(state, done('success'))
  state = foldUltracode(state, run('off', 'cmd-2'))
  state = foldUltracode(state, done('success', 'cmd-2'))
  assert.deepEqual(state, { active: false, pending: null, run: null })
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

test('a run opens on turn start, counts delegation attempts, and closes on turn end', () => {
  let state = activeRun()
  assert.equal(state.run.turn, 1)
  assert.equal(state.run.spawnAttempts, 0)
  state = foldUltracode(state, { type: 'tool/call', data: { name: 'subagent' } })
  state = foldUltracode(state, { type: 'tool/call', data: { name: 'read' } })
  assert.equal(state.run.spawnAttempts, 1)
  state = foldUltracode(state, { type: 'tool/result', data: { error: { code: 'ultracode_budget_exhausted', reason: 'spawns' } } })
  assert.equal(state.run.stop, 'ultracode_budget_exhausted:spawns')
  state = foldUltracode(state, { type: 'turn/end', time: 600, data: { turn: 1 } })
  assert.equal(state.run.endedAt, 600)
})

test('off mid-run leaves the run open until turn end', () => {
  let state = activeRun()
  state = foldUltracode(state, run('off', 'cmd-2'))
  state = foldUltracode(state, done('success', 'cmd-2'))
  assert.equal(state.active, false)
  assert.equal(state.run.endedAt, null)
  state = foldUltracode(state, { type: 'turn/end', time: 600, data: { turn: 1 } })
  assert.equal(state.run.endedAt, 600)
})

test('structured stop ignores text-only and unrelated errors', () => {
  let state = activeRun()
  state = foldUltracode(state, { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'ultracode_budget_exhausted:spawns' }] } } })
  assert.equal(state.run.stop, null)
  state = foldUltracode(state, { type: 'tool/result', data: { error: { code: 'other', reason: 'spawns' } } })
  assert.equal(state.run.stop, null)
  state = foldUltracode(state, { type: 'tool/result', data: { error: { code: 'ultracode_budget_exhausted', reason: 'spawns' } } })
  assert.equal(state.run.stop, 'ultracode_budget_exhausted:spawns')
  const stopped = foldUltracode(state, { type: 'tool/result', data: { error: { code: 'ultracode_budget_exhausted', reason: 'other' } } })
  assert.equal(stopped.run.stop, 'ultracode_budget_exhausted:spawns')
})

test('a cold fold reconstructs the latest state from command history', () => {
  const history = [run('on', 'a'), done('success', 'a'), run('off', 'b'), done('success', 'b'), run('on', 'c')]
  const state = history.reduce(foldUltracode, INITIAL_ULTRACODE_STATE)
  assert.equal(state.active, false)
  assert.equal(state.pending.arg, true)
  assert.equal(foldUltracode(state, done('success', 'c')).active, true)
})

test('a done with a missing commandId while nothing is pending returns the same state and does not throw', () => {
  const orphan = { type: 'command/done', data: { kind: 'success' } }
  assert.equal(foldUltracode(INITIAL_ULTRACODE_STATE, orphan), INITIAL_ULTRACODE_STATE)
  const settled = foldUltracode(foldUltracode(INITIAL_ULTRACODE_STATE, run('on')), done('success'))
  assert.equal(foldUltracode(settled, orphan), settled)
})

test('a commandId-less done on a state whose pending field is absent leaves it unchanged and does not throw', () => {
  // Absent (undefined), not null: matched with != null, as the router fold does.
  const absent = { active: true, run: null }
  for (const kind of ['success', 'error']) {
    const orphan = { type: 'command/done', data: { kind } }
    assert.doesNotThrow(() => foldUltracode(absent, orphan))
    assert.equal(foldUltracode(absent, orphan), absent)
  }
})

test('fold replay of a log containing a commandId-less done leaves the state valid', () => {
  const log = [run('on', 'c1'), done('success', 'c1'), { type: 'command/done', data: { kind: 'success' } }, run('off', 'c2', 200), done('success', 'c2')]
  const state = log.reduce(foldUltracode, INITIAL_ULTRACODE_STATE)
  assert.equal(state.active, false)
  assert.equal(state.pending, null)
})
