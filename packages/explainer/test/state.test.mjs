import assert from 'node:assert/strict'
import test from 'node:test'
import {
  foldExplainer,
  INITIAL_EXPLAINER_STATE,
  parseExplainerArg,
  pendingExplainer,
  STALE_PENDING_MS,
  viewExplainer,
} from '../src/state.js'

const run = (args, commandId = 'cmd-1', time = 100) => ({
  type: 'command/run',
  time,
  data: { name: 'output-style', args, commandId },
})
const done = (kind, commandId = 'cmd-1', text = '') => ({ type: 'command/done', data: { kind, commandId, text } })
const fold = (events, state = INITIAL_EXPLAINER_STATE) => events.reduce(foldExplainer, state)
const turnOn = (id = 'on-1', time = 100) => [run('on', id, time), done('success', id)]
const turnOff = (id = 'off-1', time = 200) => [run('off', id, time), done('success', id)]

test('a new session starts off with nothing pending', () => {
  assert.deepEqual(INITIAL_EXPLAINER_STATE, { on: false, pending: null, failure: null })
  assert.deepEqual(viewExplainer(INITIAL_EXPLAINER_STATE), { on: false, pending: false, pendingSince: null, failure: null })
})

test('parseExplainerArg accepts explainer, on, off and status, case and space insensitive', () => {
  assert.equal(parseExplainerArg('explainer'), 'on')
  assert.equal(parseExplainerArg(' Explainer '), 'on')
  assert.equal(parseExplainerArg('on'), 'on')
  assert.equal(parseExplainerArg('  OFF '), 'off')
  assert.equal(parseExplainerArg('Status'), 'status')
  for (const bad of ['manual', 'toggle', 'on off', 'onn', 'explainers', 'explainer on', 5]) {
    assert.equal(parseExplainerArg(bad), null, String(bad))
  }
})

test('parseExplainerArg reads a bare call as status', () => {
  for (const bare of ['', '   ', undefined, null]) assert.equal(parseExplainerArg(bare), 'status', String(bare))
})

test('on records a pending change and the done event commits it', () => {
  const pending = foldExplainer(INITIAL_EXPLAINER_STATE, run('on'))
  assert.deepEqual(pending.pending, { arg: 'on', commandId: 'cmd-1', startedAt: 100 })
  assert.equal(pending.on, false)
  assert.deepEqual(foldExplainer(pending, done('success')), { on: true, pending: null, failure: null })
})

test('off after on turns the style off again', () => {
  assert.deepEqual(fold([...turnOn(), ...turnOff()]), { on: false, pending: null, failure: null })
})

test('a repeated on is a no-op success', () => {
  const once = fold(turnOn('a'))
  const twice = fold(turnOn('b', 300), once)
  assert.deepEqual(twice, once)
  assert.equal(twice.on, true)
})

test('a repeated off is a no-op success', () => {
  assert.deepEqual(fold(turnOff('x')), INITIAL_EXPLAINER_STATE)
})

test('the argument explainer turns the style on, like its alias on', () => {
  const viaExplainer = fold([run('explainer', 'e-1', 100), done('success', 'e-1')])
  assert.deepEqual(viaExplainer, { on: true, pending: null, failure: null })
  assert.deepEqual(fold([run('  Explainer ', 'e-2', 100), done('success', 'e-2')]), viaExplainer)
  assert.deepEqual(foldExplainer(INITIAL_EXPLAINER_STATE, run('explainer', 'e-3', 5)).pending, { arg: 'on', commandId: 'e-3', startedAt: 5 })
  assert.deepEqual(fold([...turnOn('x'), run('explainer', 'e-4', 300), done('success', 'e-4')]), viaExplainer)
})

test('the argument on is an alias of explainer', () => {
  assert.deepEqual(fold([run('on', 'o-1', 100), done('success', 'o-1')]), { on: true, pending: null, failure: null })
})

test('a bare call changes nothing, like status', () => {
  const on = fold(turnOn())
  assert.equal(foldExplainer(on, run('', 'b-1', 150)), on)
  assert.equal(foldExplainer(on, run(undefined, 'b-2', 150)), on)
  assert.equal(foldExplainer(INITIAL_EXPLAINER_STATE, run('   ', 'b-3', 150)), INITIAL_EXPLAINER_STATE)
  const pending = foldExplainer(INITIAL_EXPLAINER_STATE, run('on'))
  assert.equal(foldExplainer(pending, run('', 'b-4', 150)), pending)
})

test('status never changes the state, in any position', () => {
  const statusEvents = [run('status', 's-1', 150), done('success', 's-1')]
  assert.deepEqual(fold(statusEvents), INITIAL_EXPLAINER_STATE)
  const on = fold(turnOn())
  assert.deepEqual(fold(statusEvents, on), on)
  const pending = foldExplainer(INITIAL_EXPLAINER_STATE, run('on'))
  assert.equal(foldExplainer(pending, run('status', 's-2', 150)), pending)
})

test('invalid or missing arguments leave the state unchanged', () => {
  const on = fold(turnOn())
  for (const args of ['manual', 'toggle', 'on now', 'level hard', 'explainer now', 7]) {
    assert.equal(foldExplainer(on, run(args, 'bad')), on, String(args))
    assert.equal(foldExplainer(on, done('success', 'bad')), on, String(args))
  }
})

test('a failed command leaves the setting unchanged and records the failure', () => {
  const failed = fold([run('on'), done('error', 'cmd-1', 'boom')])
  assert.equal(failed.on, false)
  assert.equal(failed.pending, null)
  assert.deepEqual(failed.failure, { count: 1, text: 'boom', arg: 'on' })
  const on = fold(turnOn())
  const stillOn = fold([run('off', 'f-1', 300), done('error', 'f-1', 'nope')], on)
  assert.equal(stillOn.on, true)
})

test('a later success replaces the recorded failure', () => {
  const failed = fold([run('on'), done('error', 'cmd-1', 'boom')])
  const recovered = fold(turnOn('ok', 400), failed)
  assert.deepEqual(recovered, { on: true, pending: null, failure: null })
})

test('failures are counted', () => {
  const twice = fold([run('on', 'a'), done('error', 'a', 'x'), run('on', 'b'), done('error', 'b', 'y')])
  assert.equal(twice.failure.count, 2)
  assert.equal(twice.failure.text, 'y')
})

test('a command is rejected while a fresh one is pending', () => {
  const pending = foldExplainer(INITIAL_EXPLAINER_STATE, run('on', 'a', 100))
  assert.equal(foldExplainer(pending, run('off', 'b', 200)), pending)
  // The rejected command reports an error; its done event changes nothing.
  assert.equal(foldExplainer(pending, done('error', 'b')), pending)
})

test('an expired pending command can be replaced', () => {
  const pending = foldExplainer(INITIAL_EXPLAINER_STATE, run('on', 'a', 100))
  const next = foldExplainer(pending, run('off', 'b', 100 + STALE_PENDING_MS + 1))
  assert.deepEqual(next.pending, { arg: 'off', commandId: 'b', startedAt: 100 + STALE_PENDING_MS + 1 })
})

test('a done event for another command id is ignored', () => {
  const pending = foldExplainer(INITIAL_EXPLAINER_STATE, run('on'))
  assert.equal(foldExplainer(pending, done('success', 'other')), pending)
})

test('events without a string command id never match', () => {
  const pending = foldExplainer(INITIAL_EXPLAINER_STATE, run('on'))
  assert.equal(foldExplainer(pending, { type: 'command/done', data: { kind: 'success' } }), pending)
  assert.equal(foldExplainer(INITIAL_EXPLAINER_STATE, { type: 'command/run', time: 1, data: { name: 'output-style', args: 'on' } }), INITIAL_EXPLAINER_STATE)
})

test('commands and events of other plugins are ignored', () => {
  const on = fold(turnOn())
  assert.equal(foldExplainer(on, { type: 'command/run', time: 1, data: { name: 'router', args: 'off', commandId: 'r' } }), on)
  assert.equal(foldExplainer(on, { type: 'turn/start', data: { turn: 1 } }), on)
})

test('only the command named exactly output-style is folded', () => {
  const on = fold(turnOn())
  const off = INITIAL_EXPLAINER_STATE
  for (const name of ['output-style-x', 'output_style', 'explainer', 'router', 'Output-Style', 'output-styles', 'my-output-style', ' output-style', 'output', '']) {
    assert.equal(foldExplainer(off, { type: 'command/run', time: 1, data: { name, args: 'on', commandId: 'n' } }), off, `on via ${JSON.stringify(name)}`)
    assert.equal(foldExplainer(on, { type: 'command/run', time: 1, data: { name, args: 'off', commandId: 'n' } }), on, `off via ${JSON.stringify(name)}`)
  }
  assert.equal(foldExplainer(off, { type: 'command/run', time: 1, data: { args: 'on', commandId: 'n' } }), off)
  assert.equal(foldExplainer(off, { type: 'command/run', time: 1, data: { name: '/router on', args: 'on', commandId: 'n' } }), off)
  assert.equal(foldExplainer(off, { type: 'command/run', time: 1, data: { name: '/output-style', args: 'on', commandId: 'n' } }), off)
  // The legacy name no longer turns the style on, even with a matching done event.
  const legacy = [{ type: 'command/run', time: 1, data: { name: 'explainer', args: 'on', commandId: 'l' } }, done('success', 'l')]
  assert.deepEqual(fold(legacy), off)
})

test('the stale-pending window is five minutes', () => {
  assert.equal(STALE_PENDING_MS, 300000)
})

test('a pending command older than five minutes can be replaced, one just under cannot', () => {
  const pending = foldExplainer(INITIAL_EXPLAINER_STATE, run('on', 'a', 1000))
  assert.equal(foldExplainer(pending, run('off', 'b', 1000 + 299999)), pending)
  assert.deepEqual(foldExplainer(pending, run('off', 'b', 1000 + 300000)).pending, { arg: 'off', commandId: 'b', startedAt: 301000 })
})

test('the fold reads no clock: the same events give the same state at any Date.now', (t) => {
  const log = [...turnOn('a', 100), run('off', 'b', 200), run('explainer', 'c', 300)]
  let now = 1
  t.mock.method(Date, 'now', () => now)
  const early = fold(log)
  now = 9e15
  const late = fold(log)
  assert.deepEqual(late, early)
  assert.deepEqual(early.pending, { arg: 'off', commandId: 'b', startedAt: 200 })
  // A later timed command is judged against event times, not the wall clock.
  assert.equal(foldExplainer(early, run('on', 'd', 250)), early)
})

test('an event without a time starts the pending command at 0', () => {
  const untimed = { type: 'command/run', data: { name: 'output-style', args: 'on', commandId: 'u' } }
  assert.deepEqual(foldExplainer(INITIAL_EXPLAINER_STATE, untimed).pending, { arg: 'on', commandId: 'u', startedAt: 0 })
})

test('the fold does not mutate its input', () => {
  const before = fold([run('on')])
  const snapshot = structuredClone(before)
  foldExplainer(before, done('success'))
  assert.deepEqual(before, snapshot)
  assert.throws(() => { INITIAL_EXPLAINER_STATE.on = true }, TypeError)
})

test('replaying the same log gives the same state, with no clock read', () => {
  const log = [...turnOn('a', 100), run('status', 's', 120), run('bogus', 'z', 130), ...turnOff('b', 200), run('on', 'c', 300), done('error', 'c', 'e'), ...turnOn('d', 400)]
  const first = fold(log)
  assert.deepEqual(fold(log), first)
  assert.equal(first.on, true)
  // An event without a time is deterministic too.
  const untimed = [{ type: 'command/run', data: { name: 'output-style', args: 'on', commandId: 'u' } }]
  assert.deepEqual(fold(untimed), fold(untimed))
})

test('the setting is retained across off and on cycles from a log prefix', () => {
  const log = [...turnOn('a', 100), ...turnOff('b', 200), ...turnOn('c', 300)]
  assert.deepEqual(log.map((_, i) => fold(log.slice(0, i + 1)).on), [false, true, true, false, false, true])
})

test('pendingExplainer hides an expired pending command', () => {
  const pending = foldExplainer(INITIAL_EXPLAINER_STATE, run('on', 'a', 1000))
  assert.equal(pendingExplainer(pending, 1000 + STALE_PENDING_MS - 1)?.commandId, 'a')
  assert.equal(pendingExplainer(pending, 1000 + STALE_PENDING_MS), null)
  assert.equal(pendingExplainer(INITIAL_EXPLAINER_STATE), null)
})

test('the view reports the switch, pending and failure', () => {
  const pending = foldExplainer(INITIAL_EXPLAINER_STATE, run('on', 'a', 100))
  assert.deepEqual(viewExplainer(pending), { on: false, pending: true, pendingSince: 100, failure: null })
  const failed = fold([run('on'), done('error', 'cmd-1', 'boom')])
  assert.deepEqual(viewExplainer(failed).failure, { count: 1, text: 'boom', arg: 'on' })
})
