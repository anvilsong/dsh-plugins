import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, POLICY } from '../src/index.host.js'

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
  assert.equal(definition.stateVersion, 3)
  assert.equal(modelRoutesDefinition.stateVersion, 1)
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

test('policy requires anti-downshift, separate effort, and verifier exemption', () => {
  assert.match(POLICY, /list_subagent_models/)
  assert.match(POLICY, /Never choose a cheaper route for substantive work/)
  assert.match(POLICY, /Mechanical requires all three criteria/)
  assert.match(POLICY, /shortlist is an unordered set, not a ranking, price list, or benchmark claim/)
  assert.match(POLICY, /Mechanical uses low only when advertised/)
  assert.match(POLICY, /Ordinary omits effort for the route default/)
  assert.match(POLICY, /Hard judgment uses the highest advertised effort only when useful/)
  assert.match(POLICY, /router: <level> → <provider>\/<model> because <criterion>; effort: <low\|default\|highest-advertised>/)
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
