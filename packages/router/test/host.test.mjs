import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import * as host from '../src/index.host.js'
import { apply, POLICY, routerPolicy } from '../src/index.host.js'
import { foldRouter, INITIAL_ROUTER_STATE } from '../src/state.js'

const selected = { provider: 'openrouter', model: '~deepseek/deepseek-flash-latest' }

function harness() {
  const definitions = {}
  let section
  let command
  let state = {
    mode: 'off',
    selections: { mechanical: null, ordinary: null, hard: null },
    pending: null,
  }
  let routes = [selected, { provider: 'anthropic', model: 'claude-haiku-5-5' }]
  const ctx = {
    sessionProjections: {
      async register(value) {
        definitions[value.key] = value
        return { stateOf: () => value.key === 'router' ? state : routes }
      },
    },
    systemPrompt: { getSectionOrder: () => 500, section(value) { section = value } },
    inject(names, callback) {
      if (names.includes('commands')) callback({ commands: { register(value) { command = value } } })
    },
  }
  return {
    ctx,
    agent: { session: {} },
    get: () => ({ definition: definitions.router, modelRoutesDefinition: definitions.routerModelRoutes, section, command, state, routes }),
    setState: (next) => { state = next },
    setRoutes: (next) => { routes = next },
  }
}

test('registers router and authorized-route projections, policy, and commands', async () => {
  const { ctx, get, agent } = harness()
  await apply(ctx)
  const { definition, modelRoutesDefinition, section, command } = get()
  assert.equal(definition.key, 'router')
  assert.equal(definition.stateVersion, 5, 'entries gained efforts: cached state (3, or the earlier 4) is rebuilt from the session log')
  assert.equal(modelRoutesDefinition.stateVersion, 1)
  assert.deepEqual(Array.from(host.inject), ['systemPrompt', 'sessionProjections'], 'no llm or other service is injected')
  assert.equal(section.name, 'router:policy')
  assert.equal(command.name, 'router')
  assert.equal(section.text({ agent }), '')
  get().state.mode = 'manual'
  assert.match(section.text({ agent }), /Manual intelligent routing/)
  assert.match(section.text({ agent }), /Session shortlists/)
  assert.equal(section.text({}), '')
  const event = {
    type: 'subagent/model-selection-policy',
    data: { allowedModels: [{ provider: 'openrouter', model: 'one', display: 'not projected' }] },
  }
  assert.deepEqual(modelRoutesDefinition.apply(null, event), [{ provider: 'openrouter', model: 'one' }])
  assert.deepEqual(modelRoutesDefinition.apply([{ provider: 'openrouter', model: 'one' }], event), [{ provider: 'openrouter', model: 'one' }])
})

test('policy requires anti-downshift, entry efforts, and verifier exemption', () => {
  assert.match(POLICY, /list_subagent_models/)
  assert.match(POLICY, /Never choose a cheaper route for substantive work/)
  assert.match(POLICY, /Mechanical requires all three criteria/)
  assert.match(POLICY, /shortlist is an unordered set, not a ranking, price list, or benchmark claim/)
  assert.match(POLICY, /- Effort belongs to the shortlist entry\. /)
  assert.match(POLICY, /Pass exactly the chosen entry's effort as reasoning_effort together with its provider and model/)
  assert.match(POLICY, /an entry listed as "<provider>\/<model> \(effort <id>\)" passes reasoning_effort "<id>"/)
  assert.match(POLICY, /an entry without an effort omits reasoning_effort so the model's own default effort applies/)
  assert.match(POLICY, /Never choose another effort\./)
  assert.match(POLICY, /If the spawn is rejected for the effort, say so and retry once on the same route without reasoning_effort\./)
  assert.match(POLICY, /"router: <level> → <provider>\/<model> because <criterion>; effort: <id\|default>"/)
  // The lead's old per-level rule is replaced, not kept as a fallback.
  assert.doesNotMatch(POLICY, /Mechanical uses low|Ordinary omits effort|highest advertised|highest-advertised|decided separately/)
  // The binding is stated, not explained: nothing about checks or enforcement.
  assert.doesNotMatch(POLICY, /enforc|advisory|guard|Host check|level setting/i)
  assert.match(POLICY, /route discovery unavailable or unauthorized/)
  assert.match(POLICY, /Advisor-reserved children \(advisor-verifier-\*, advisor-planner-\*, and advisor-consult-\*\) are exempt/)
  assert.match(POLICY, /never route them or apply any shortlist, including Hard/)
  assert.match(POLICY, /do not spawn a classifier/i)
  assert.doesNotMatch(POLICY, /cheapest adequate/)
})

test('commands configure levels, reject invalid routes, and gate overlaps', async () => {
  const { ctx, get, setState, setRoutes, agent } = harness()
  await apply(ctx)
  const command = get().command
  assert.match((await command.handler({ agent, rawInput: 'status' })).text, /Router is off/)
  assert.equal((await command.handler({ agent, rawInput: 'manual' })).kind, 'success')
  setState({ ...get().state, mode: 'manual' })
  assert.match((await command.handler({ agent, rawInput: 'status' })).text, /Manual router is on/)
  assert.equal((await command.handler({ agent, rawInput: 'level mechanical openrouter/~deepseek/deepseek-flash-latest' })).kind, 'success')
  setState({ ...get().state, selections: { ...get().state.selections, mechanical: [selected] } })
  assert.match((await command.handler({ agent, rawInput: 'status' })).text, /mechanical: openrouter\/~deepseek\/deepseek-flash-latest/)
  assert.equal((await command.handler({ agent, rawInput: 'level mechanical openrouter/typesafe/jev-1.13' })).kind, 'error')
  assert.equal((await command.handler({ agent, rawInput: 'level mechanical openrouter/~deepseek/deepseek-flash-latest,openrouter/~deepseek/deepseek-flash-latest' })).kind, 'error')
  assert.equal((await command.handler({ agent, rawInput: 'level hard a/b,c/d,e/f,g/h,i/j' })).kind, 'error')
  setRoutes(null)
  assert.equal((await command.handler({ agent, rawInput: 'level ordinary anthropic/claude-haiku-5-5' })).kind, 'error')
  assert.equal((await command.handler({ agent, rawInput: 'level ordinary inherit' })).kind, 'success')
  assert.equal((await command.handler({ agent, rawInput: 'auto' })).kind, 'error')
  assert.equal((await command.handler({ agent, rawInput: 'off' })).kind, 'success')
  get().state.pending = { target: 'level', level: 'ordinary', routes: null, commandId: 'old', startedAt: Date.now() }
  assert.match((await command.handler({ agent, rawInput: 'status' })).text, /updating \(level ordinary\)/)
  const result = await command.handler({ agent, rawInput: 'off', commandId: 'new' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /already updating/)
})

// Per-entry efforts.
const haiku = { provider: 'anthropic', model: 'claude-haiku-5-5' }
const USAGE = 'Usage: /router level <mechanical|ordinary|hard> inherit|<provider>/<model>[ effort=<id>][,<provider>/<model>[ effort=<id>]...]'
const SHORTLISTS = 'Session shortlists (empty means Inherit):'
const manualState = (selections) => ({
  mode: 'manual',
  selections: { mechanical: null, ordinary: null, hard: null, ...selections },
  pending: null,
  lastRun: null,
  failure: null,
})

test('the POLICY constant is pinned to the per-entry effort text, and the level-wide policy is gone', () => {
  assert.equal(POLICY.length, 3252)
  assert.equal(createHash('sha256').update(POLICY).digest('hex'), 'cd72decfd9303d828fca43bfd4bf4aa2726ecbd06612e3601d3d84b453c3d490')
  for (const name of ['EFFORT_POLICY', 'ROUTER_EFFORTS', 'effortsOf']) assert.equal(name in host, false, name)
})

test('shortlist lines list each authorized entry with its effort', () => {
  const authorized = [selected, haiku]
  const state = manualState({
    mechanical: [{ ...selected, effort: 'low' }],
    ordinary: [selected, haiku],
    hard: [{ ...haiku, effort: 'xhigh' }, selected],
  })
  assert.equal(routerPolicy(state, authorized), [
    POLICY,
    SHORTLISTS,
    '- mechanical: openrouter/~deepseek/deepseek-flash-latest (effort low)',
    '- ordinary: openrouter/~deepseek/deepseek-flash-latest, anthropic/claude-haiku-5-5',
    '- hard: anthropic/claude-haiku-5-5 (effort xhigh), openrouter/~deepseek/deepseek-flash-latest',
  ].join('\n'))
  // Unavailable entries are left out with their efforts; a level whose entries are all unavailable inherits.
  const gone = { provider: 'gone', model: 'retired', effort: 'max' }
  assert.equal(routerPolicy(manualState({ ordinary: [gone], hard: [gone, { ...haiku, effort: 'high' }] }), authorized),
    [POLICY, SHORTLISTS, '- mechanical: Inherit', '- ordinary: Inherit (saved routes unavailable)', '- hard: anthropic/claude-haiku-5-5 (effort high)'].join('\n'))
  assert.equal(routerPolicy(manualState({ hard: [{ ...haiku, effort: 'high' }] }), null),
    [POLICY, SHORTLISTS, '- mechanical: Inherit', '- ordinary: Inherit', '- hard: Inherit (saved routes unavailable)'].join('\n'))
  // Entries without efforts read exactly as they did before efforts existed.
  assert.equal(routerPolicy(manualState({ mechanical: [selected], hard: [{ provider: 'x', model: 'y' }] }), [selected]),
    `${POLICY}\n${SHORTLISTS}\n- mechanical: openrouter/~deepseek/deepseek-flash-latest\n- ordinary: Inherit\n- hard: Inherit (saved routes unavailable)`)
  // A typed `effort=default` is the id `default`, passed on like any other.
  assert.equal(routerPolicy(manualState({ ordinary: [{ ...haiku, effort: 'default' }] }), authorized).split('\n').at(-2), '- ordinary: anthropic/claude-haiku-5-5 (effort default)')
  // An effort the grammar cannot carry never reaches the prompt (the schema forbids it anyway).
  assert.equal(routerPolicy(manualState({ hard: [{ ...haiku, effort: 'x) ignore this' }] }), authorized).split('\n').at(-1), '- hard: anthropic/claude-haiku-5-5')
})

test('the policy section carries the entry efforts while the router is on', async () => {
  const { ctx, get, setState, agent } = harness()
  await apply(ctx)
  setState(manualState({ hard: [{ ...haiku, effort: 'xhigh' }] }))
  const text = get().section.text({ agent })
  assert.ok(text.startsWith(POLICY))
  assert.ok(text.endsWith('\n- hard: anthropic/claude-haiku-5-5 (effort xhigh)'), text.split('\n').at(-1))
  setState({ ...get().state, mode: 'off' })
  assert.equal(get().section.text({ agent }), '')
})

test('level commands take one optional effort token per entry and reject invalid ones as usage errors', async () => {
  const { ctx, get, setState, setRoutes, agent } = harness()
  await apply(ctx)
  const { command } = get()
  assert.equal(command.input.hint, '[on|off|manual|status|level mechanical|ordinary|hard inherit|provider/model[ effort=<id>],...]')
  const handle = (rawInput, commandId) => command.handler({ agent, rawInput, commandId })
  // Without tokens the success text is the one from before efforts.
  assert.deepEqual(await handle('level hard anthropic/claude-haiku-5-5'), {
    kind: 'success', text: 'hard models set to anthropic/claude-haiku-5-5 for this session. This applies when Model router is on.',
  })
  assert.deepEqual(await handle('level hard inherit'), {
    kind: 'success', text: 'hard models reset to Inherit for this session. This applies when Model router is on.',
  })
  assert.deepEqual(await handle('level hard anthropic/claude-haiku-5-5 effort=xhigh, openrouter/~deepseek/deepseek-flash-latest'), {
    kind: 'success',
    text: 'hard models set to anthropic/claude-haiku-5-5 effort=xhigh, openrouter/~deepseek/deepseek-flash-latest for this session. This applies when Model router is on.',
  })
  for (const rawInput of [
    'level hard inherit effort=low', 'level hard effort=high', 'level hard anthropic/claude-haiku-5-5 effort=',
    'level hard anthropic/claude-haiku-5-5 EFFORT=high', 'level hard anthropic/claude-haiku-5-5 effort=low effort=high',
    'level hard anthropic/claude-haiku-5-5 effort=low extra', 'level hard anthropic/claude-haiku-5-5 effort=x!',
    'level hard anthropic/claude-haiku-5-5 effort=low,', 'level hard',
  ]) assert.deepEqual(await handle(rawInput), { kind: 'error', text: USAGE }, rawInput)
  // The same model twice is a duplicate whatever its efforts.
  for (const rawInput of [
    'level hard anthropic/claude-haiku-5-5 effort=low,anthropic/claude-haiku-5-5 effort=high',
    'level hard anthropic/claude-haiku-5-5,anthropic/claude-haiku-5-5 effort=high',
  ]) assert.deepEqual(await handle(rawInput), { kind: 'error', text: 'Duplicate routes are not allowed in one level.' }, rawInput)
  // The route checks name the route without its effort.
  assert.deepEqual(await handle('level hard openrouter/typesafe/jev-1.13 effort=high'), {
    kind: 'error', text: 'Route openrouter/typesafe/jev-1.13 is not authorized for this session. Choose available subagent models or inherit.',
  })
  assert.match((await handle('level hard a/b effort=low,c/d,e/f,g/h,i/j')).text, /at most four/)
  // Nothing checks an id against the model: any id within the charset is accepted as typed.
  assert.equal((await handle('level hard anthropic/claude-haiku-5-5 effort=turbo')).kind, 'success')
  setRoutes(null)
  assert.match((await handle('level hard anthropic/claude-haiku-5-5 effort=low')).text, /No explicit subagent routes/)
  assert.equal((await handle('level hard inherit')).kind, 'success')
  setState({ ...get().state, pending: { target: 'level', level: 'hard', routes: null, commandId: 'old', startedAt: Date.now() } })
  assert.match((await handle('level hard inherit', 'new')).text, /already updating/)
})

test('the handler rejects exactly the level lines the fold does not admit', async () => {
  const { ctx, get, agent } = harness()
  await apply(ctx)
  const { command } = get()
  // success / error (admitted, then refused by a route check) / usage: the
  // level usage text, or the general one for a line that is no level command.
  const GENERAL_USAGE = 'Usage: /router [on|off|manual|status|level ...]'
  const outcomes = { success: 0, error: 0, usage: 0 }
  for (const [args, expected] of [
    ['level hard anthropic/claude-haiku-5-5', 'success'],
    ['level hard anthropic/claude-haiku-5-5 effort=xhigh', 'success'],
    ['level hard INHERIT', 'success'],
    ['level hard  anthropic/claude-haiku-5-5  effort=low ', 'success'],
    ['level hard anthropic/claude-haiku-5-5 effort=low,openrouter/~deepseek/deepseek-flash-latest', 'success'],
    // The `level` keyword is read case-insensitively by both, the level name is not.
    ['LEVEL hard anthropic/claude-haiku-5-5', 'success'],
    ['Level hard anthropic/claude-haiku-5-5 effort=low', 'success'],
    ['level hard q/my model effort=max', 'error'],
    ['level hard anthropic/claude-haiku-5-5 effort=low,anthropic/claude-haiku-5-5', 'error'],
    ['level hard inherit effort=low', USAGE], ['LEVEL hard inherit effort=low', USAGE], ['level hard effort=high', USAGE],
    ['level hard anthropic/claude-haiku-5-5 EFFORT=high', USAGE], ['level hard anthropic/claude-haiku-5-5 Effort=low', USAGE],
    ['level hard anthropic/claude-haiku-5-5 effort=', USAGE], ['level hard a/b effort=low effort=low', USAGE],
    ['level hard a/b effort=low extra', USAGE], ['level hard a/b effort=x!', USAGE], ['level hard a/b,', USAGE],
    ['level hard', USAGE], ['level Hard a/b', USAGE], [`level hard a/b effort=${'x'.repeat(33)}`, USAGE],
    // A tab after `level` makes no level command for either.
    ['level\thard anthropic/claude-haiku-5-5', GENERAL_USAGE],
    ['level\thard anthropic/claude-haiku-5-5 effort=low', GENERAL_USAGE],
  ]) {
    const result = await command.handler({ agent, rawInput: args })
    const usage = result.kind === 'error' && result.text.startsWith('Usage: /router ')
    if (expected === 'success' || expected === 'error') assert.equal(result.kind, expected, `${JSON.stringify(args)}: ${result.text}`)
    else assert.deepEqual(result, { kind: 'error', text: expected }, JSON.stringify(args))
    outcomes[usage ? 'usage' : result.kind]++
    const admitted = foldRouter(INITIAL_ROUTER_STATE, { type: 'command/run', time: 1, data: { name: 'router', args, commandId: 'c' } }) !== INITIAL_ROUTER_STATE
    assert.equal(usage, !admitted, `${JSON.stringify(args)}: a usage error exactly when the fold does not admit the line`)
  }
  assert.deepEqual(outcomes, { success: 7, error: 2, usage: 15 }, 'every outcome is covered')
})

test('status shows each entry with its effort and marks entries whose route is unavailable', async () => {
  const { ctx, get, setState, setRoutes, agent } = harness()
  await apply(ctx)
  const { command } = get()
  const status = async () => (await command.handler({ agent, rawInput: 'status' })).text
  setState(manualState({
    mechanical: [{ ...selected, effort: 'low' }],
    hard: [{ ...haiku, effort: 'xhigh' }, { provider: 'gone', model: 'retired', effort: 'max' }, { provider: 'gone', model: 'plain' }],
  }))
  assert.equal(await status(), [
    'Manual router is on for this session. The lead selects authorized routes or inheritance for ordinary subagents.',
    'mechanical: openrouter/~deepseek/deepseek-flash-latest effort=low',
    'ordinary: Inherit',
    'hard: anthropic/claude-haiku-5-5 effort=xhigh, gone/retired effort=max (unavailable), gone/plain (unavailable)',
  ].join('\n'))
  setState({ ...manualState({ hard: [haiku] }), mode: 'off' })
  assert.equal(await status(), [
    'Router is off for this session. Ordinary subagent model selection is unchanged. Preferences are retained:',
    'mechanical: Inherit',
    'ordinary: Inherit',
    'hard: anthropic/claude-haiku-5-5',
  ].join('\n'), 'entries without efforts read as before')
  setRoutes(null)
  assert.match(await status(), /\nhard: anthropic\/claude-haiku-5-5 \(unavailable\)$/, 'without authorized routes every entry is unavailable')
})

test('state and view schemas carry per-entry efforts; routerModelRoutes stays a plain route list', async () => {
  const { ctx, get } = harness()
  await apply(ctx)
  const { definition, modelRoutesDefinition } = get()
  const initial = definition.init()
  assert.deepEqual(initial, { mode: 'off', selections: { mechanical: null, ordinary: null, hard: null }, pending: null, lastRun: null, failure: null })
  assert.notEqual(initial.selections, INITIAL_ROUTER_STATE.selections, 'init returns a fresh copy')
  assert.deepEqual(definition.stateSchema.parse(initial), initial)
  const state = {
    ...manualState({ hard: [{ ...haiku, effort: 'xhigh' }, selected] }),
    pending: { target: 'level', level: 'ordinary', routes: [{ ...selected, effort: 'Low_1.2-x' }], commandId: 'c', startedAt: 1 },
    lastRun: { commandId: 'c', target: 'level', level: 'ordinary' },
  }
  const parsed = definition.stateSchema.parse(state)
  assert.deepEqual(parsed, state)
  assert.equal('effort' in parsed.selections.hard[1], false, 'an entry without an effort stays without the key')
  const withEntry = (entry) => ({ ...state, selections: { ...state.selections, hard: [entry] } })
  for (const [name, bad] of [
    ['empty effort', withEntry({ ...haiku, effort: '' })],
    ['null effort', withEntry({ ...haiku, effort: null })],
    ['effort with a space', withEntry({ ...haiku, effort: 'two words' })],
    ['effort with a comma', withEntry({ ...haiku, effort: 'a,b' })],
    ['effort too long', withEntry({ ...haiku, effort: 'x'.repeat(33) })],
    ['effort not a string', withEntry({ ...haiku, effort: 3 })],
    ['missing model', withEntry({ provider: 'anthropic', effort: 'low' })],
    ['missing provider', withEntry({ model: 'claude-haiku-5-5', effort: 'low' })],
    ['invalid pending entry effort', { ...state, pending: { ...state.pending, routes: [{ ...selected, effort: 'x y' }] } }],
    ['missing selections', { ...state, selections: undefined }],
    ['missing level', { ...state, selections: { mechanical: null, ordinary: null } }],
  ]) assert.equal(definition.stateSchema.safeParse(bad).success, false, name)
  const view = definition.wire.view(state)
  assert.equal('efforts' in view, false)
  assert.deepEqual(definition.wire.viewSchema.parse(view), view)
  assert.equal(definition.wire.viewSchema.safeParse({ ...view, selections: { ...view.selections, hard: [{ ...haiku, effort: '' }] } }).success, false)
  // A folded command reaches the view through the registered fold.
  const folded = definition.apply(
    definition.apply(initial, { type: 'command/run', time: 1, data: { name: 'router', args: 'level ordinary anthropic/claude-haiku-5-5 effort=low,openrouter/~deepseek/deepseek-flash-latest', commandId: 'd' } }),
    { type: 'command/done', data: { kind: 'success', commandId: 'd' } })
  assert.deepEqual(definition.wire.view(folded).selections.ordinary, [{ ...haiku, effort: 'low' }, selected])
  assert.deepEqual(definition.stateSchema.parse(folded), folded)
  // The authorized-route projection is unchanged: plain { provider, model } entries.
  assert.deepEqual(modelRoutesDefinition.stateSchema.parse([haiku]), [haiku])
  assert.deepEqual(modelRoutesDefinition.stateSchema.parse([{ ...haiku, effort: 'low' }]), [haiku], 'no effort field')
  assert.equal(modelRoutesDefinition.wire.viewSchema, modelRoutesDefinition.stateSchema)
})
