import assert from 'node:assert/strict'
import test from 'node:test'
import {
  effortReset,
  foldAdvisor,
  inheritWithEffort,
  INITIAL_ADVISOR_STATE,
  parseModelSetting,
  pendingAdvisor,
  routeLabel,
  spawnArgs,
  spawnPolicy,
  STALE_PENDING_MS,
  viewAdvisor,
} from '../src/state.js'

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

test('a done with a missing commandId while nothing is pending returns the same state and does not throw', () => {
  const orphan = { type: 'command/done', data: { kind: 'success' } }
  assert.equal(foldAdvisor(INITIAL_ADVISOR_STATE, orphan), INITIAL_ADVISOR_STATE)
  const explicit = { type: 'command/done', data: { kind: 'error', commandId: undefined, text: 'x' } }
  assert.equal(foldAdvisor(INITIAL_ADVISOR_STATE, explicit), INITIAL_ADVISOR_STATE)
  const settled = foldAdvisor(foldAdvisor(INITIAL_ADVISOR_STATE, run('on', 'a', 100)), done('success', 'a'))
  assert.equal(foldAdvisor(settled, orphan), settled)
})

test('fold replay of a log containing a commandId-less done leaves the state valid', () => {
  const log = [run('on', 'a', 100), done('success', 'a'), { type: 'command/done', data: { kind: 'success' } }, run('off', 'b', 200), done('success', 'b')]
  const state = log.reduce(foldAdvisor, INITIAL_ADVISOR_STATE)
  assert.equal(state.active, false)
  assert.equal(state.pending, null)
  assert.equal(state.failure, null)
})

test('a state whose pending marker is undefined or missing folds and views like no pending marker', () => {
  const orphan = { type: 'command/done', data: { kind: 'success' } }
  const orphanError = { type: 'command/done', data: { kind: 'error', text: 'x' } }
  const legacy = [
    { ...INITIAL_ADVISOR_STATE, pending: undefined },
    { active: true, verifierModel: null, advisorModel: null, lastRun: null, failure: null },
  ]
  for (const state of legacy) {
    assert.doesNotThrow(() => foldAdvisor(state, orphan))
    assert.equal(foldAdvisor(state, orphan), state)
    assert.equal(foldAdvisor(state, orphanError), state)
    assert.equal(foldAdvisor(state, done('success', 'a')), state)
    assert.equal(viewAdvisor(state).pending, false, 'no marker is not an update in progress')
    assert.equal(viewAdvisor(state).pendingTarget, null)
    assert.equal(pendingAdvisor(state), null)
    const next = foldAdvisor(state, run('off', 'b', 100))
    assert.equal(next.pending.commandId, 'b')
    assert.equal(foldAdvisor(next, done('success', 'b')).active, false)
  }
})

test('pendingAdvisor hides a pending marker older than STALE_PENDING_MS', () => {
  const state = foldAdvisor(INITIAL_ADVISOR_STATE, run('on', 'a', 1000))
  assert.equal(pendingAdvisor(INITIAL_ADVISOR_STATE, 5000), null)
  assert.equal(pendingAdvisor(state, 1000 + STALE_PENDING_MS - 1), state.pending)
  assert.equal(pendingAdvisor(state, 1000 + STALE_PENDING_MS), null)
})

// ---------------------------------------------------------------------------
// Effort: `<provider>/<model> [effort=<id>]`, one parser for the fold and the
// command handler.

// [setting, parsed]: a route without an effort has no effort key; null is
// Inherit; undefined is a usage error.
const PARSE_TABLE = [
  ['p/m', { provider: 'p', model: 'm' }],
  ['  p/m  ', { provider: 'p', model: 'm' }],
  [`${selected.provider}/${selected.model} effort=high`, { ...selected, effort: 'high' }],
  ['p/~a/b  effort=x', { provider: 'p', model: '~a/b', effort: 'x' }],
  // Whitespace inside a model id stays in the model; only the last token is the effort.
  ['p/my model', { provider: 'p', model: 'my model' }],
  ['p/my model effort=low', { provider: 'p', model: 'my model', effort: 'low' }],
  ['p/m\teffort=low', { provider: 'p', model: 'm', effort: 'low' }],
  ['p/m effort=low  ', { provider: 'p', model: 'm', effort: 'low' }],
  // Stored verbatim: no case folding, no names, no other normalization.
  ['p/m effort=HiGh', { provider: 'p', model: 'm', effort: 'HiGh' }],
  ['p/m effort=x-high_2.5', { provider: 'p', model: 'm', effort: 'x-high_2.5' }],
  ['p/m effort==high', { provider: 'p', model: 'm', effort: '=high' }],
  // The keyword is lowercase: EFFORT= is not a token, so it stays in the model id.
  ['p/m EFFORT=high', { provider: 'p', model: 'm EFFORT=high' }],
  // Trailing junk: the setting does not end in a token, so all of it is the model id.
  ['p/m effort=high extra', { provider: 'p', model: 'm effort=high extra' }],
  // Duplicate tokens: only the last is the effort; the earlier one stays in the model id.
  ['p/m effort=low effort=high', { provider: 'p', model: 'm effort=low', effort: 'high' }],
  ['inherit', null],
  ['Inherit', null],
  ['INHERIT', null],
  ['  inherit  ', null],
  // Invalid: an empty value, an effort with Inherit, or no route before the token.
  ['p/m effort=', undefined],
  ['p/m effort=   ', undefined],
  ['inherit effort=x', undefined],
  ['Inherit effort=x', undefined],
  ['INHERIT  effort=high', undefined],
  ['inherit effort=', undefined],
  ['inherit effort=x effort=y', undefined],
  ['effort=x', undefined],
  ['  effort=x', undefined],
  ['p/ effort=x', undefined],
  ['/m effort=x', undefined],
  ['p /m effort=x', undefined],
  ['p/ m effort=x', undefined],
  ['nonsense', undefined],
  ['', undefined],
]

test('parseModelSetting: inherit or <provider>/<model> with an optional last effort=<id> token, kept verbatim', () => {
  for (const [setting, expected] of PARSE_TABLE) {
    const parsed = parseModelSetting(setting)
    assert.deepEqual(parsed, expected, JSON.stringify(setting))
    if (parsed !== null && parsed !== undefined && !Object.hasOwn(expected, 'effort')) {
      assert.equal(Object.hasOwn(parsed, 'effort'), false, `${JSON.stringify(setting)}: no effort key without the token`)
    }
  }
  for (const value of [undefined, null, 7, {}]) assert.equal(parseModelSetting(value), undefined, String(value))
})

test('inheritWithEffort: true exactly for the settings refused because Inherit got an effort token', () => {
  for (const setting of ['inherit effort=x', 'Inherit effort=x', 'INHERIT  effort=high', 'inherit effort=', '  inherit\teffort=low  ']) {
    assert.equal(inheritWithEffort(setting), true, setting)
    assert.equal(parseModelSetting(setting), undefined, setting)
  }
  for (const setting of ['inherit', 'p/m effort=x', 'p/m effort=', 'effort=x', 'nonsense', '', 'inherit EFFORT=x', 'inherit effort=x effort=y', 'inheritx effort=y']) {
    assert.equal(inheritWithEffort(setting), false, setting)
  }
  for (const value of [undefined, null, 7]) assert.equal(inheritWithEffort(value), false, String(value))
})

test('routeLabel: provider/model, plus effort=<id> when one is stored; every label parses back to its route', () => {
  assert.equal(routeLabel(null), 'Inherit')
  assert.equal(routeLabel(undefined), 'Inherit')
  assert.equal(routeLabel(selected), 'openrouter/~deepseek/deepseek-flash-latest')
  assert.equal(routeLabel({ ...selected, effort: 'high' }), 'openrouter/~deepseek/deepseek-flash-latest effort=high')
  for (const [, route] of PARSE_TABLE) {
    if (route === undefined) continue
    assert.deepEqual(parseModelSetting(routeLabel(route)), route, routeLabel(route))
  }
})

test('spawnArgs: Inherit omits everything; a route needs its exact provider and model, plus reasoning_effort only with a stored effort', () => {
  assert.equal(spawnArgs(null), undefined)
  assert.equal(spawnArgs(undefined), undefined)
  assert.deepEqual(spawnArgs(selected), { provider: selected.provider, model: selected.model })
  assert.deepEqual(spawnArgs({ ...selected, effort: 'HiGh' }), { provider: selected.provider, model: selected.model, reasoning_effort: 'HiGh' })
  assert.equal(effortReset('model', { ...selected, effort: 'high' }), '/advisor model openrouter/~deepseek/deepseek-flash-latest')
  assert.equal(effortReset('verifier-model', { provider: 'p', model: 'my model', effort: 'low' }), '/advisor verifier-model p/my model')
})

test('spawnPolicy: the no-effort sentences are unchanged; with an effort it says pass reasoning_effort "<id>" and names the reset', () => {
  const children = 'advisor-planner and advisor-consult children'
  assert.equal(spawnPolicy(null, { children, command: 'model' }),
    'For advisor-planner and advisor-consult children, omit provider, model, reasoning_effort, and agent_preset so configured child defaults and compatible parent values apply.')
  assert.equal(spawnPolicy(null, { command: 'verifier-model' }),
    'Omit provider, model, reasoning_effort, and agent_preset so configured child defaults and compatible parent values apply.')
  assert.equal(spawnPolicy(selected, { children, command: 'model' }),
    "Pass exactly this provider and model to subagent for advisor-planner and advisor-consult children, omit reasoning_effort and agent_preset so the selected model's default effort applies, and do not fall back to another route if spawning fails.")
  assert.equal(spawnPolicy(selected, { command: 'verifier-model' }),
    "Pass exactly this provider and model to subagent, omit reasoning_effort and agent_preset so the selected model's default effort applies, and do not fall back to another route if spawning fails.")
  for (const [options, reset] of [[{ children, command: 'model' }, '/advisor model p/m'], [{ command: 'verifier-model' }, '/advisor verifier-model p/m']]) {
    const text = spawnPolicy({ provider: 'p', model: 'm', effort: 'HiGh' }, options)
    assert.ok(text.includes('Pass exactly this provider and model to subagent'), text)
    assert.ok(text.includes('pass reasoning_effort "HiGh"'), text)
    assert.ok(text.includes('omit agent_preset'), text)
    assert.doesNotMatch(text, /omit reasoning_effort/)
    assert.ok(text.includes('If the spawn is rejected for the effort, report it and do not retry without it'), text)
    assert.ok(text.includes(`the user can reset the effort with ${reset}.`), text)
  }
})

test('fold: model and verifier-model store the parsed route with its effort; a later set without effort= has no effort key', () => {
  const routed = { ...selected, effort: 'high' }
  let state = foldAdvisor(INITIAL_ADVISOR_STATE, run(`model ${selected.provider}/${selected.model} effort=high`, 'a'))
  assert.deepEqual(state.pending.route, routed)
  state = foldAdvisor(state, done('success', 'a'))
  assert.deepEqual(state.advisorModel, routed)
  assert.deepEqual(viewAdvisor(state).advisorModel, routed)
  state = foldAdvisor(state, run('verifier-model anthropic/claude-haiku-5-5 effort=low', 'b'))
  state = foldAdvisor(state, done('success', 'b'))
  assert.deepEqual(state.verifierModel, { provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'low' })
  assert.deepEqual(viewAdvisor(state).verifierModel, { provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'low' })

  // A refused set (unsupported, unchecked, or timed out) changes nothing.
  state = foldAdvisor(state, run(`model ${selected.provider}/${selected.model} effort=max`, 'c'))
  state = foldAdvisor(state, done('error', 'c', 'could not be checked: timed out'))
  assert.deepEqual(state.advisorModel, routed)
  assert.equal(state.pending, null)
  assert.deepEqual(state.failure, { count: 1, text: 'could not be checked: timed out', target: 'advisorModel' })

  // Without effort= the model runs at its own default effort: no effort key.
  state = foldAdvisor(state, run(`model ${selected.provider}/${selected.model}`, 'd'))
  state = foldAdvisor(state, done('success', 'd'))
  assert.deepEqual(state.advisorModel, selected)
  assert.equal(Object.hasOwn(state.advisorModel, 'effort'), false)

  // Invalid settings are not folded: no pending marker, no failure, no change.
  for (const args of ['model inherit effort=high', 'model Inherit effort=x', `model ${selected.provider}/${selected.model} effort=`, 'verifier-model inherit effort=low', 'model effort=high']) {
    assert.equal(foldAdvisor(state, run(args, 'e')), state, args)
  }
  state = foldAdvisor(foldAdvisor(state, run('verifier-model inherit', 'f')), done('success', 'f'))
  assert.equal(state.verifierModel, null, 'Inherit clears the route and its effort')
})

test('fold: replaying the log from the initial state equals the state kept across JSON snapshots (the stateVersion 7 rebuild)', () => {
  const log = [
    run('on', 'a', 100), done('success', 'a'),
    run('model p/m effort=high', 'b', 200), done('success', 'b'),
    run('verifier-model q/my model effort=low', 'c', 300), done('error', 'c', 'not offered'),
    run('verifier-model q/my model', 'd', 400), done('success', 'd'),
    run('model p/m effort=max', 'e', 500), done('error', 'e', 'could not be checked: timed out'),
    run('model inherit effort=x', 'f', 600), done('error', 'f', 'Usage'),
  ]
  // Each step is persisted as JSON, so no step may rely on an undefined key.
  let snapshot = INITIAL_ADVISOR_STATE
  for (const event of log) snapshot = JSON.parse(JSON.stringify(foldAdvisor(snapshot, event)))
  const replayed = log.reduce(foldAdvisor, INITIAL_ADVISOR_STATE)
  assert.deepEqual(replayed, snapshot)
  assert.deepEqual(replayed.advisorModel, { provider: 'p', model: 'm', effort: 'high' })
  assert.deepEqual(replayed.verifierModel, { provider: 'q', model: 'my model' })
  assert.equal(replayed.pending, null)
  assert.deepEqual(replayed.failure, { count: 2, text: 'could not be checked: timed out', target: 'advisorModel' })
})
