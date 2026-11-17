import assert from 'node:assert/strict'
import test from 'node:test'
import * as stateModule from '../src/state.js'
import { EFFORT_ID, foldRouter, INITIAL_ROUTER_STATE, parseLevelSetting, viewRouter } from '../src/state.js'

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

// Per-entry efforts: `/router level <level> inherit|<provider>/<model>[ effort=<id>][,...]`.
const HAIKU = { provider: 'anthropic', model: 'claude-haiku-5-5' }
const FLASH = selected[0]
const apply = (state, args, commandId, kind = 'success', time = 100) =>
  foldRouter(foldRouter(state, run(args, commandId, time)), done(kind, commandId))

test('the ordinal preference is gone: no effort list, no efforts record, no effortsOf', () => {
  for (const name of ['ROUTER_EFFORTS', 'effortsOf']) assert.equal(name in stateModule, false, name)
  assert.equal('efforts' in INITIAL_ROUTER_STATE, false)
  assert.equal('efforts' in viewRouter(INITIAL_ROUTER_STATE), false)
  assert.equal(EFFORT_ID.source, '^[A-Za-z0-9._-]{1,32}$')
})

test('the level parser reads each entry with an optional trailing effort token of its own', () => {
  const table = [
    // [input, routes] — routes null is Inherit
    ['hard anthropic/claude-haiku-5-5', [HAIKU]],
    ['  hard   anthropic/claude-haiku-5-5   effort=xhigh  ', [{ ...HAIKU, effort: 'xhigh' }]],
    ['ordinary a/b effort=low, c/d', [{ provider: 'a', model: 'b', effort: 'low' }, { provider: 'c', model: 'd' }]],
    ['ordinary a/b,c/d effort=high', [{ provider: 'a', model: 'b' }, { provider: 'c', model: 'd', effort: 'high' }]],
    ['ordinary a/b effort=low,c/d effort=max', [{ provider: 'a', model: 'b', effort: 'low' }, { provider: 'c', model: 'd', effort: 'max' }]],
    // Spaces inside model ids: the token is the last whitespace-separated one.
    ['hard q/my model effort=max', [{ provider: 'q', model: 'my model', effort: 'max' }]],
    ['hard q/my  model', [{ provider: 'q', model: 'my  model' }]],
    ['hard q/my  model effort=x', [{ provider: 'q', model: 'my  model', effort: 'x' }], 'a run of inner spaces stays in the model id'],
    ['hard q/my model , r/two words effort=low', [{ provider: 'q', model: 'my model' }, { provider: 'r', model: 'two words', effort: 'low' }]],
    // Tabs and runs of whitespace separate tokens too; slashes stay in the model id.
    ['hard\topenrouter/~deepseek/deepseek-flash-latest\teffort=off', [{ ...FLASH, effort: 'off' }]],
    // Any JavaScript whitespace separates the token, a no-break or ideographic space too;
    // a zero-width space is no whitespace, so the text stays in the model id.
    ['hard a/b\u00a0effort=high', [{ provider: 'a', model: 'b', effort: 'high' }], 'NBSP'],
    ['hard a/b\u3000effort=high', [{ provider: 'a', model: 'b', effort: 'high' }], 'U+3000'],
    ['hard a/b\u200beffort=high', [{ provider: 'a', model: 'b\u200beffort=high' }], 'ZWSP'],
    // The id is kept verbatim within [A-Za-z0-9._-]{1,32}.
    ['hard a/b effort=Low_1.2-x', [{ provider: 'a', model: 'b', effort: 'Low_1.2-x' }]],
    [`hard a/b effort=${'x'.repeat(32)}`, [{ provider: 'a', model: 'b', effort: 'x'.repeat(32) }]],
    // The same model twice parses; the handler rejects it as a duplicate.
    ['hard a/b effort=low,a/b effort=high', [{ provider: 'a', model: 'b', effort: 'low' }, { provider: 'a', model: 'b', effort: 'high' }]],
    ['mechanical inherit', null],
    ['mechanical INHERIT', null],
    [' mechanical   Inherit ', null],
  ]
  for (const [input, routes, why] of table) {
    const parsed = parseLevelSetting(input)
    assert.deepEqual(parsed, { level: input.trim().split(/\s+/)[0], routes }, `${JSON.stringify(input)}${why === undefined ? '' : `: ${why}`}`)
    if (routes !== null) {
      for (const [index, route] of parsed.routes.entries()) assert.equal('effort' in route, 'effort' in routes[index], `${input}: no effort key without a token`)
    }
  }
  for (const bad of [
    '', 'hard', 'hard   ', // empty value
    'hard inherit effort=low', 'hard INHERIT effort=low', 'hard inherit,a/b', // inherit takes no token and stands alone
    'hard effort=low', 'hard  effort=low ', // no effort-only form, no level-wide token
    'hard a/b effort=low effort=high', 'hard a/b effort=low effort=low', // one token per entry
    'hard a/b effort=low extra', 'hard a/b effort=two words', 'hard effort=low a/b', // the token comes last
    'hard a/b EFFORT=low', 'hard a/b Effort=low', 'hard a/b eFFort=low', // lowercase keyword only
    'hard a/b effort=', 'hard a/b effort=x!y', 'hard a/b effort=é', 'hard a/b effort="low"', `hard a/b effort=${'x'.repeat(33)}`, // the id charset
    'hard a/b effort=low,', 'hard ,a/b', 'hard a/b,,c/d', 'hard a/b, ,c/d', // empty entries
    'hard a/b,c/d effort=low effort=high',
    'Hard a/b', 'hard broken', 'hard /b', 'hard a/', 'hard a/b effort=low,broken',
    'hard a /b', 'hard a/ b', 'hard a /b effort=low', 'hard a/ b effort=low', 'hard a/b effort=low,c /d', // no space around the slash
  ]) assert.equal(parseLevelSetting(bad), undefined, JSON.stringify(bad))
  assert.equal(parseLevelSetting(undefined), undefined)
  assert.equal(parseLevelSetting(7), undefined)
})

test('an entry effort lands with its routes when the command succeeds', () => {
  let state = foldRouter(INITIAL_ROUTER_STATE, run('level hard anthropic/claude-haiku-5-5 effort=xhigh,openrouter/~deepseek/deepseek-flash-latest', 'a'))
  assert.deepEqual(state.pending.routes, [{ ...HAIKU, effort: 'xhigh' }, FLASH])
  assert.equal('effort' in state.pending, false, 'no level-wide effort on the marker')
  assert.equal(state.selections.hard, null, 'nothing changes before the command succeeds')
  state = foldRouter(state, done('success', 'a'))
  assert.deepEqual(state.selections.hard, [{ ...HAIKU, effort: 'xhigh' }, FLASH])
  assert.deepEqual(viewRouter(state).selections.hard, [{ ...HAIKU, effort: 'xhigh' }, FLASH])
  assert.equal(state.pending, null)
  assert.equal('efforts' in state, false)
})

test('every level command states the whole level: an entry without a token is the model default', () => {
  let state = apply(INITIAL_ROUTER_STATE, 'level ordinary anthropic/claude-haiku-5-5 effort=low,openrouter/~deepseek/deepseek-flash-latest effort=high', 'a')
  assert.deepEqual(state.selections.ordinary, [{ ...HAIKU, effort: 'low' }, { ...FLASH, effort: 'high' }])
  state = apply(state, 'level ordinary anthropic/claude-haiku-5-5', 'b')
  assert.deepEqual(state.selections.ordinary, [HAIKU], 'no keep: the efforts are not carried over')
  state = apply(state, 'level ordinary anthropic/claude-haiku-5-5 effort=max', 'c')
  state = apply(state, 'level ordinary inherit', 'd')
  assert.equal(state.selections.ordinary, null)
  state = apply(state, 'level ordinary anthropic/claude-haiku-5-5', 'e')
  assert.deepEqual(state.selections.ordinary, [HAIKU], 'Inherit kept nothing for later routes')
  const before = state.selections
  state = apply(state, 'manual', 'f')
  assert.equal(state.selections, before, 'mode commands keep every level')
})

test('an invalid effort token is not admitted, changes nothing, and its usage error is not recorded', () => {
  const start = apply(INITIAL_ROUTER_STATE, 'level hard anthropic/claude-haiku-5-5 effort=low', 'a')
  for (const args of [
    'level hard inherit effort=low', 'level hard effort=high', 'level hard anthropic/claude-haiku-5-5 EFFORT=high',
    'level hard anthropic/claude-haiku-5-5 effort=high effort=low', 'level hard anthropic/claude-haiku-5-5 effort=x!',
  ]) {
    const after = foldRouter(start, run(args, 'x'))
    assert.equal(after, start, args)
    assert.equal(foldRouter(after, done('error', 'x', 'Usage: /router level ...')), start, `${args}: not recorded`)
  }
})

test('a failed command keeps the entries and their efforts and records the failure', () => {
  const start = apply(INITIAL_ROUTER_STATE, 'level hard anthropic/claude-haiku-5-5 effort=low', 'a')
  let state = foldRouter(start, run('level hard openrouter/~deepseek/deepseek-flash-latest effort=high', 'b'))
  state = foldRouter(state, done('error', 'b', 'Route x is not authorized'))
  assert.deepEqual(state.selections, start.selections)
  assert.equal(state.pending, null)
  assert.deepEqual(state.failure, { count: 1, text: 'Route x is not authorized', target: 'level', level: 'hard' })
  // The same model twice is admitted by the fold; the handler's rejection keeps the level.
  state = foldRouter(state, run('level hard anthropic/claude-haiku-5-5 effort=low,anthropic/claude-haiku-5-5 effort=high', 'c'))
  assert.equal(state.pending.commandId, 'c')
  state = foldRouter(state, done('error', 'c', 'Duplicate routes are not allowed in one level.'))
  assert.deepEqual(state.selections, start.selections)
  assert.equal(state.failure.count, 2)
})

test('an effort command that arrives while another update is pending is not applied', () => {
  let state = foldRouter(INITIAL_ROUTER_STATE, run('manual', 'a', 100))
  state = foldRouter(state, run('level hard anthropic/claude-haiku-5-5 effort=xhigh', 'b', 150))
  assert.equal(state.pending.commandId, 'a')
  state = foldRouter(state, done('success', 'b'))
  assert.equal(state.selections.hard, null, 'the overlapping command was not admitted')
  state = foldRouter(state, done('success', 'a'))
  assert.equal(state.mode, 'manual')
  // A pending marker older than five minutes is taken over, as before.
  state = foldRouter(state, run('off', 'c', 1_000))
  state = foldRouter(state, run('level hard anthropic/claude-haiku-5-5 effort=xhigh', 'd', 1_000 + 5 * 60_000))
  state = foldRouter(state, done('success', 'd'))
  assert.deepEqual(state.selections.hard, [{ ...HAIKU, effort: 'xhigh' }])
})

// Each step is persisted as JSON, so no step may rely on an undefined key.
function replay(log) {
  let snapshot = INITIAL_ROUTER_STATE
  for (const event of log) snapshot = JSON.parse(JSON.stringify(foldRouter(snapshot, event)))
  const replayed = log.reduce(foldRouter, INITIAL_ROUTER_STATE)
  assert.deepEqual(replayed, snapshot)
  return replayed
}

test('replaying a stateVersion 3 log folds to the old selections, every entry on its model default', () => {
  // Commands from before efforts existed carry no token.
  const replayed = replay([
    run('manual', 'a', 100), done('success', 'a'),
    run('level mechanical openrouter/~deepseek/deepseek-flash-latest', 'b', 200), done('success', 'b'),
    run('level hard anthropic/claude-haiku-5-5', 'c', 300), done('success', 'c'),
    run('level ordinary anthropic/claude-haiku-5-5', 'd', 400), done('error', 'd', 'Route x is not authorized'),
    run('level hard inherit', 'e', 500), done('success', 'e'),
    run('level ordinary broken', 'f', 600), done('error', 'f', 'Usage'),
    run('level ordinary openrouter/~deepseek/deepseek-flash-latest,anthropic/claude-haiku-5-5', 'g', 700), done('success', 'g'),
    { type: 'command/done', data: { kind: 'success' } },
  ])
  assert.equal(replayed.mode, 'manual')
  assert.deepEqual(replayed.selections, { mechanical: selected, ordinary: [FLASH, HAIKU], hard: null })
  assert.equal(JSON.stringify(replayed.selections).includes('effort'), false)
  assert.deepEqual(replayed.failure, { count: 1, text: 'Route x is not authorized', target: 'level', level: 'ordinary' })
  assert.equal('efforts' in replayed, false)
})

test('replaying a log with the earlier ordinal tokens reads them as entry efforts or rejects them', () => {
  // Acceptable, and the README asks to reset such levels: no shim, no migration.
  const replayed = replay([
    run('level hard anthropic/claude-haiku-5-5', 'a', 100), done('success', 'a'),
    run('level hard anthropic/claude-haiku-5-5,openrouter/~deepseek/deepseek-flash-latest effort=highest', 'b', 200), done('success', 'b'),
    run('level ordinary anthropic/claude-haiku-5-5 effort=auto', 'c', 300), done('success', 'c'),
    run('level mechanical anthropic/claude-haiku-5-5', 'd', 400), done('success', 'd'),
    // `inherit` takes no token any more: this reset is not admitted on replay.
    run('level mechanical inherit effort=lowest', 'e', 500), done('success', 'e'),
  ])
  assert.deepEqual(replayed.selections.hard, [HAIKU, { ...FLASH, effort: 'highest' }], 'the token belongs to the last entry')
  assert.deepEqual(replayed.selections.ordinary, [{ ...HAIKU, effort: 'auto' }])
  assert.deepEqual(replayed.selections.mechanical, [HAIKU], 'the earlier value stays')
  assert.equal(replayed.failure, null, 'a done event of a command that was not admitted records nothing')
})

test('effort=default is an ordinary id: it is stored as typed, not read as the model default', () => {
  const state = apply(INITIAL_ROUTER_STATE, 'level ordinary anthropic/claude-haiku-5-5 effort=default', 'a')
  assert.deepEqual(state.selections.ordinary, [{ ...HAIKU, effort: 'default' }])
  assert.deepEqual(apply(state, 'level ordinary anthropic/claude-haiku-5-5', 'b').selections.ordinary, [HAIKU], 'only the absent token is the default')
})
