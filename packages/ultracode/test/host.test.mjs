import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, POLICY } from '../src/index.host.js'

function harness() {
  let definition
  let section
  let command
  const calls = []
  let state = { active: false, pending: null }
  const ctx = {
    get(name) {
      if (name === 'agentTeams') return { isEnabled: () => false }
      return undefined
    },
    sessionProjections: {
      async register(value) {
        definition = value
        return { stateOf: () => state }
      },
    },
    systemPrompt: {
      getSectionOrder: () => 500,
      section(value) { section = value },
    },
    inject(names, callback) {
      calls.push(names)
      if (names.includes('commands')) {
        callback({ commands: { register(value) { command = value } } })
      }
    },
  }
  const agent = { session: {} }
  return {
    ctx,
    agent,
    get: () => ({ definition, section, command, calls, state }),
    setState: (next) => { state = next },
  }
}

test('apply registers the projection, section, and command', async () => {
  const { ctx, get } = harness()
  await apply(ctx)
  const { definition, section, command, calls } = get()
  assert.equal(definition.key, 'ultracode')
  assert.equal(definition.stateVersion, 3)
  assert.equal(typeof definition.apply, 'function')
  assert.equal(section.name, 'ultracode:policy')
  assert.equal(section.order, 500)
  assert.equal(command.name, 'ultracode')
  assert.equal(command.definitionId, 'dsh-plugin-ultracode')
  assert.deepEqual(calls, [['commands']])
})

test('the prompt section is empty when inactive and full when active', async () => {
  const { ctx, get } = harness()
  await apply(ctx)
  const { section } = get()
  assert.equal(section.text({}), '')
  assert.equal(section.text({ agent: { session: {} } }), '')
  assert.match(POLICY, /workflow|subagent orchestration/)
  assert.match(POLICY, /team collaboration/)
  assert.match(POLICY, /refute/)
  assert.doesNotMatch(POLICY, /spawn_teammate/)
})

test('the command validates input and reports state without changing Team', async () => {
  const { ctx, get, agent } = harness()
  await apply(ctx)
  const { command } = get()
  assert.equal((await command.handler({ agent, rawInput: 'status' })).kind, 'success')
  assert.equal((await command.handler({ agent, rawInput: 'status' })).text, 'Ultracode is off for this session. AgentTeam is off.')
  assert.equal((await command.handler({ agent, rawInput: 'on' })).kind, 'success')
  assert.equal((await command.handler({ agent, rawInput: 'off' })).kind, 'success')
  assert.equal((await command.handler({ agent, rawInput: 'bogus' })).kind, 'error')
})

test('a pending command rejects a different command id', async () => {
  const { ctx, get, agent, setState } = harness()
  setState({ active: false, pending: { arg: true, commandId: 'old', startedAt: Date.now() } })
  await apply(ctx)
  const { command } = get()
  const result = await command.handler({ agent, rawInput: 'off', commandId: 'new' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /already updating/)
})

test('the current pending command is allowed to complete', async () => {
  const { ctx, get, agent } = harness()
  get().state.pending = { arg: true, commandId: 'current', startedAt: Date.now() }
  await apply(ctx)
  const { command } = get()
  const result = await command.handler({ agent, rawInput: 'on', commandId: 'current' })
  assert.equal(result.kind, 'success')
})
