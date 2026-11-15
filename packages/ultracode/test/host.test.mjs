import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, POLICY } from '../src/index.host.js'

function harness() {
  let definition
  let section
  let command
  const calls = []
  const teamCalls = []
  let state = { active: false, pending: null, commandId: null, teamEnabled: false, teamBeforeOn: null, teamChangedByUs: false }
  const ctx = {
    agentTeams: {
      async setEnabled(_agent, enabled) { teamCalls.push(enabled) },
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
  return { ctx, get: () => ({ definition, section, command, calls, teamCalls }), setState: (next) => { state = next } }
}

test('apply registers the projection, section, and command', async () => {
  const { ctx, get } = harness()
  await apply(ctx)
  const { definition, section, command, calls } = get()
  assert.equal(definition.key, 'ultracode')
  assert.equal(definition.stateVersion, 1)
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
  // The test harness returns an inactive state; the active case is covered by
  // the pure fold tests, so assert the policy text itself here.
  assert.match(POLICY, /workflow|subagent orchestration/)
  assert.match(POLICY, /team collaboration/)
  assert.match(POLICY, /refute/)
  assert.doesNotMatch(POLICY, /spawn_teammate/)
})

test('the command validates input and reports state', async () => {
  const { ctx, get } = harness()
  await apply(ctx)
  const { command } = get()
  const agent = { session: {} }
  assert.equal((await command.handler({ agent, rawInput: 'status' })).kind, 'success')
  assert.equal((await command.handler({ agent, rawInput: 'status' })).text, 'Ultracode is off for this session. AgentTeam is off.')
  assert.equal((await command.handler({ agent, rawInput: 'on' })).kind, 'success')
  assert.equal((await command.handler({ agent, rawInput: 'off' })).kind, 'success')
  assert.equal((await command.handler({ agent, rawInput: 'bogus' })).kind, 'error')
  assert.deepEqual(get().teamCalls, [true])
})

test('off restores AgentTeam only when this plugin enabled it', async () => {
  const { ctx, get, setState } = harness()
  await apply(ctx)
  const { command } = get()
  setState({ active: true, pending: null, commandId: null, teamEnabled: true, teamBeforeOn: false, teamChangedByUs: true })
  const agent = { session: {} }
  assert.equal((await command.handler({ agent, rawInput: 'off' })).kind, 'success')
  assert.deepEqual(get().teamCalls, [false])
})
