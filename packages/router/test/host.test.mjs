import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import * as host from '../src/index.host.js'
import { apply, POLICY, routerPolicy } from '../src/index.host.js'
import { foldRouter, INITIAL_ROUTER_STATE } from '../src/state.js'
import { z } from 'zod'
import { foldAudit } from '../src/audit.js'
import { viewRouter } from '../src/state.js'

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

// Observe-only audit: a third, host-only projection and one /router status line.
const sha256 = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const HAIKU_XHIGH = manualState({ hard: [{ ...haiku, effort: 'xhigh' }] })
const MANUAL_STATUS = [
  'Manual router is on for this session. The lead selects authorized routes or inheritance for ordinary subagents.',
  'mechanical: Inherit',
  'ordinary: Inherit',
  'hard: anthropic/claude-haiku-5-5 effort=xhigh',
].join('\n')
const OFF_STATUS = [
  'Router is off for this session. Ordinary subagent model selection is unchanged. Preferences are retained:',
  'mechanical: Inherit',
  'ordinary: Inherit',
  'hard: anthropic/claude-haiku-5-5 effort=xhigh',
].join('\n')
const OBSERVED_LINE = 'Observed subagent requests while Router was on: 4 (inherit 1, match 2, unlisted_open 1). Observe only; nothing is blocked.'
const toolCall = (args, turn = 2) => ({ type: 'tool/call', time: 10 + turn, data: { turn, step: 1, callId: `call_${turn}`, name: 'subagent', arguments: JSON.stringify(args) } })
const AUDIT_LOG = [
  { type: 'subagent/model-selection-policy', time: 1, data: { allowedModels: [selected, haiku] } },
  { type: 'command/run', time: 2, data: { name: 'router', args: 'manual', commandId: 'a' } },
  { type: 'command/done', time: 3, data: { commandId: 'a', kind: 'success' } },
  { type: 'command/run', time: 4, data: { name: 'router', args: 'level hard anthropic/claude-haiku-5-5 effort=xhigh', commandId: 'b' } },
  { type: 'command/done', time: 5, data: { commandId: 'b', kind: 'success' } },
  toolCall({ description: 'review', prompt: 'Review it.', ...haiku, reasoning_effort: 'xhigh' }), // match
  toolCall({ description: 'search', prompt: 'Search it.' }), // inherit
  toolCall({ description: 'other', prompt: 'Do it.', provider: 'gone', model: 'retired' }), // unlisted_open
  toolCall({ description: 'again', prompt: 'Review again.', ...haiku, reasoning_effort: 'xhigh' }, 3), // match
]

/** `logger`: true records warnings, false leaves ctx.logger out, an object is a property descriptor for it. */
function auditHarness({ registerAudit, logger = true } = {}) {
  const units = new Map()
  const warnings = []
  const agent = { session: {} }
  let section
  let command
  let routerState = HAIKU_XHIGH
  let readAudit = () => undefined
  const ctx = {
    sessionProjections: {
      async register(unit) {
        if (unit.key === 'routerAudit' && registerAudit !== undefined) return registerAudit(unit)
        units.set(unit.key, unit)
        return { stateOf: () => unit.key === 'router' ? routerState : unit.key === 'routerAudit' ? readAudit() : [selected, haiku] }
      },
    },
    systemPrompt: { getSectionOrder: () => 500, section(value) { section = value } },
    inject(names, callback) {
      if (names.includes('commands')) callback({ commands: { register(value) { command = value } } })
    },
  }
  if (logger === true) ctx.logger = { warn: (message) => warnings.push(message) }
  else if (logger !== false) Object.defineProperty(ctx, 'logger', logger)
  return {
    ctx,
    units,
    warnings,
    agent,
    section: () => section.text({ agent }),
    run: (rawInput) => command.handler({ agent, rawInput, commandId: 'now' }),
    status: async () => (await command.handler({ agent, rawInput: 'status' })).text,
    setRouter: (next) => { routerState = next },
    setAudit: (read) => { readAudit = read },
    observed: () => AUDIT_LOG.reduce(units.get('routerAudit').apply, units.get('routerAudit').init()),
  }
}

test('the observe-only audit is a third, host-only projection; the router projections, inject list and POLICY are unchanged', async () => {
  const h = auditHarness()
  await apply(h.ctx)
  assert.deepEqual([...h.units.keys()], ['router', 'routerModelRoutes', 'routerAudit'])
  const router = h.units.get('router')
  const modelRoutes = h.units.get('routerModelRoutes')
  const audit = h.units.get('routerAudit')
  assert.equal(audit.key, 'routerAudit')
  assert.equal(audit.stateVersion, 1, 'bump routerAudit stateVersion together with the router stateVersion')
  assert.equal('wire' in audit, false, 'host-only: no Client view')
  assert.equal(audit.apply, foldAudit)
  assert.equal(audit.stateSchema.shape.router, router.stateSchema)
  // The router projection: state version, fold, state and view schemas, initial state.
  assert.equal(router.stateVersion, 5, 'bump routerAudit stateVersion together with the router stateVersion')
  assert.equal(router.apply, foldRouter)
  assert.equal(router.wire.view, viewRouter)
  assert.deepEqual(router.init(), INITIAL_ROUTER_STATE)
  assert.equal(sha256(z.toJSONSchema(router.stateSchema)), 'fb530a31526f90a6fc69cc7507495c2a2cbd7d9d20729d6eae2eacf4c257de24')
  assert.equal(sha256(z.toJSONSchema(router.wire.viewSchema)), '2860b642560431af620cb684450d9f49bbfa2016e9bb804310f8f91f4a19ced4')
  assert.equal(modelRoutes.stateVersion, 1)
  assert.equal(sha256(z.toJSONSchema(modelRoutes.stateSchema)), 'c352ac16993a9cd5383cbc882f5dbcce803a842326068254728998787007ded2')
  assert.deepEqual(Array.from(host.inject), ['systemPrompt', 'sessionProjections'], 'no tools service, so no guard')
  assert.equal('tools' in h.ctx, false, 'apply runs without ctx.tools')
  assert.equal(createHash('sha256').update(POLICY).digest('hex'), 'cd72decfd9303d828fca43bfd4bf4aa2726ecbd06612e3601d3d84b453c3d490')
  assert.deepEqual(h.warnings, [])
})

test('/router status appends one observed line only after requests were observed while Router was on', async () => {
  const h = auditHarness()
  await apply(h.ctx)
  const audit = h.units.get('routerAudit')
  h.setAudit(() => audit.init())
  assert.equal(await h.status(), MANUAL_STATUS, 'nothing observed: the text is unchanged')
  const observed = h.observed()
  assert.equal(observed.total, 4)
  h.setAudit(() => observed)
  assert.equal(await h.status(), `${MANUAL_STATUS}\n${OBSERVED_LINE}`)
  h.setRouter({ ...HAIKU_XHIGH, mode: 'off' })
  assert.equal(await h.status(), `${OFF_STATUS}\n${OBSERVED_LINE}`, 'counts from while Router was on stay after it is off')
  // While an update is pending, status reports only the update, as before.
  h.setRouter({ ...HAIKU_XHIGH, pending: { target: 'level', level: 'hard', routes: null, commandId: 'p', startedAt: Date.now() } })
  assert.equal(await h.status(), 'Router is updating (level hard) for this session.')
  // Every other command answers as before.
  h.setRouter(HAIKU_XHIGH)
  assert.deepEqual(await h.run('off'), { kind: 'success', text: 'Router off. Ordinary subagent model selection is unchanged. Level preferences are retained.' })
  assert.deepEqual(await h.run('level hard inherit'), { kind: 'success', text: 'hard models reset to Inherit for this session. This applies when Model router is on.' })
  assert.deepEqual(await h.run('auto'), { kind: 'error', text: 'Jev auto mode is not included in this version. Use /router manual.' })
})

test('status keeps its existing text when the audit state is missing, no audit state, or unreadable', async () => {
  const h = auditHarness()
  await apply(h.ctx)
  for (const [name, read] of [
    ['undefined', () => undefined],
    ['null', () => null],
    ['a route list, as the stand-in harness returns', () => [selected, haiku]],
    ['a total without counts', () => ({ total: 3 })],
    ['a total that is no integer', () => ({ ...h.observed(), total: '4' })],
    ['a read that throws', () => { throw new Error('projection unavailable') }],
    ['a counts getter that throws', () => ({ total: 4, get counts() { throw new Error('counts') } })],
    ['a state proxy whose traps throw', () => new Proxy({}, {
      get() { throw new Error('get trap') },
      getOwnPropertyDescriptor() { throw new Error('descriptor trap') },
    })],
  ]) {
    h.setAudit(read)
    assert.equal(await h.status(), MANUAL_STATUS, name)
  }
})

test('Router keeps working when the audit cannot register', async () => {
  for (const logger of [true, false]) {
    const h = auditHarness({ logger, registerAudit: async () => { throw new Error('key routerAudit is already registered') } })
    await apply(h.ctx)
    assert.deepEqual([...h.units.keys()], ['router', 'routerModelRoutes'])
    assert.deepEqual(h.warnings, logger ? ['router: the observe-only audit is unavailable: key routerAudit is already registered'] : [])
    assert.equal(await h.status(), MANUAL_STATUS)
    assert.equal(h.section(), routerPolicy(HAIKU_XHIGH, [selected, haiku]))
    assert.equal((await h.run('off')).kind, 'success')
  }
})

test('neither an odd rejection value nor a throwing logger lets the audit registration stop Router', async () => {
  for (const [name, reason, shown] of [
    ['a null-prototype value', Object.create(null), 'unknown error'],
    ['a message getter that throws', { get message() { throw new Error('message getter') } }, 'unknown error'],
    ['a symbol', Symbol('gone'), 'Symbol(gone)'],
    ['a plain string', 'conflict', 'conflict'],
  ]) {
    const h = auditHarness({ registerAudit: () => Promise.reject(reason) })
    await apply(h.ctx)
    assert.deepEqual(h.warnings, [`router: the observe-only audit is unavailable: ${shown}`], name)
    assert.equal(await h.status(), MANUAL_STATUS, name)
  }
  for (const [name, logger] of [
    ['a warn that throws', { value: { warn() { throw new Error('logger down') } } }],
    ['a logger getter that throws', { get() { throw new Error('no logger') } }],
    ['a warn that is no function', { value: { warn: 'loud' } }],
  ]) {
    for (const reason of [new Error('key conflict'), Object.create(null)]) {
      const h = auditHarness({ logger, registerAudit: () => Promise.reject(reason) })
      await apply(h.ctx)
      assert.deepEqual([...h.units.keys()], ['router', 'routerModelRoutes'], name)
      assert.equal(await h.status(), MANUAL_STATUS, name)
      assert.equal(h.section(), routerPolicy(HAIKU_XHIGH, [selected, haiku]), name)
      assert.equal((await h.run('off')).kind, 'success', name)
    }
  }
})

test('the audit embeds the router state, so its state version moves with the router state version', async () => {
  const h = auditHarness()
  await apply(h.ctx)
  // On failure: bump routerAudit's stateVersion in the same change, then update both numbers here.
  assert.equal(h.units.get('router').stateVersion, 5, 'bump routerAudit stateVersion together with the router stateVersion')
  assert.equal(h.units.get('routerAudit').stateVersion, 1, 'bump routerAudit stateVersion together with the router stateVersion')
})

test('the policy section is byte-identical whatever the audit counts', async () => {
  const h = auditHarness()
  await apply(h.ctx)
  const expected = routerPolicy(HAIKU_XHIGH, [selected, haiku])
  assert.ok(expected.endsWith('\n- hard: anthropic/claude-haiku-5-5 (effort xhigh)'))
  for (const read of [() => undefined, () => h.units.get('routerAudit').init(), () => h.observed(), () => { throw new Error('unavailable') }]) {
    h.setAudit(read)
    assert.equal(h.section(), expected)
    assert.doesNotMatch(h.section(), /observ|nothing is blocked/i) // ("auditable line" is POLICY's own wording)
  }
})
