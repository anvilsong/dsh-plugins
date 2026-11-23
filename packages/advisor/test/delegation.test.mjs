import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CONTROL_PACKAGE,
  installDelegationSupport,
  loadHostPlugin,
  startDelegationLoad,
  SUBAGENT_PACKAGE,
} from '../src/delegation.js'

const TOOL = Symbol('tool')
const CONTROL = Symbol('control')

function plugin(name, tools) {
  return Object.freeze({
    name,
    inject: ['tools'],
    apply(ctx, config) {
      for (const tool of tools(config)) ctx.tools.register({ name: tool })
    },
  })
}

const SUBAGENT_PLUGIN = plugin('tool-subagent', (config) => [
  config.toolName,
  ...(config.modelDiscovery ? ['list_subagent_models'] : []),
])
const CONTROL_PLUGIN = plugin('tool-subagent-control', () => ['wait_agent', 'list_agents', 'send_message'])

function world({ active = true, loaded, failMount } = {}) {
  const agents = new Map()
  const calls = []
  const listeners = { created: [], changed: [], disposed: [] }
  const logs = []
  const disposers = { created: 0, changed: 0, disposed: 0 }
  const ctx = {
    agents: { list: () => [...agents.values()] },
    subagents: { rootOf: (agent) => agent.root },
    sessionProjections: {
      onChanged(listener) {
        listeners.changed.push(listener)
        return () => { disposers.changed += 1 }
      },
    },
    on(type, listener) {
      if (type === 'agent/created') {
        listeners.created.push(listener)
        return () => { disposers.created += 1 }
      }
      assert.equal(type, 'agent/disposed')
      listeners.disposed.push(listener)
      return () => { disposers.disposed += 1 }
    },
    logger: { info: (line) => logs.push(line), warn: (line) => logs.push(line) },
  }
  const projection = { stateOf: (session) => ({ active: typeof active === 'function' ? active(session) : active }) }
  const delegation = loaded ?? (async () => ({ subagent: { plugin: SUBAGENT_PLUGIN }, control: { plugin: CONTROL_PLUGIN } }))

  function addAgent(id, { rootId = id, tools = [], child = false } = {}) {
    const registered = new Map(tools.map((name) => [name, { name }]))
    const agent = {
      id,
      root: { id: rootId, session: { id: rootId } },
      registered,
      ctx: {
        tools: {
          get: (name) => registered.get(name),
          register: (definition) => {
            registered.set(definition.name, definition)
            return () => registered.delete(definition.name)
          },
        },
        plugin(plugin, config) {
          const call = { agent: id, plugin, config, disposed: 0 }
          calls.push(call)
          if (failMount?.(plugin)) {
            call.dispose = () => { call.disposed += 1 }
            return { then: (_resolve, reject) => { reject(new Error('mount failed')); return Promise.resolve() }, dispose: call.dispose }
          }
          plugin.apply(agent.ctx, config)
          call.dispose = () => {
            call.disposed += 1
            for (const name of plugin.name === 'tool-subagent'
              ? [config.toolName, 'list_subagent_models']
              : ['wait_agent', 'list_agents', 'send_message']) registered.delete(name)
          }
          return { then: (resolve) => { resolve(); return Promise.resolve() }, dispose: call.dispose }
        },
      },
    }
    if (child) agent.root = { id: 'lead', session: { id: 'lead' } }
    agents.set(id, agent)
    for (const listener of listeners.created) listener({ agent })
    return agent
  }

  const dispose = installDelegationSupport(ctx, { projection, delegation, logger: ctx.logger })
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  return {
    agents, calls, listeners, logs, disposers, dispose, flush, addAgent,
    turn(session, active) {
      for (const listener of listeners.changed) listener({ id: session }, 'advisor', { active }, 1)
      return flush()
    },
  }
}

test('an active root gets subagent and control tools only when they are missing', async () => {
  const w = world()
  const agent = w.addAgent('lead')
  await w.flush()
  const names = [...agent.registered.keys()]
  for (const name of ['subagent', 'list_subagent_models', 'wait_agent', 'list_agents', 'send_message']) {
    assert.ok(names.includes(name), name)
  }
  const subagentCall = w.calls.find((call) => call.plugin === SUBAGENT_PLUGIN)
  assert.deepEqual(subagentCall.config, {
    provider: 'spawn', toolName: 'subagent', modelSelection: true, modelDiscovery: true,
  })
  assert.deepEqual(w.calls.find((call) => call.plugin === CONTROL_PLUGIN).config, { interrupt: false })
})

test('Advisor off mounts nothing and creates no host plugin calls', async () => {
  const w = world({ active: false })
  w.addAgent('lead')
  await w.flush()
  assert.equal(w.calls.length, 0)
})

test('an existing definition is never replaced or duplicated', async () => {
  const w = world()
  const agent = w.addAgent('lead', { tools: ['subagent', 'list_subagent_models', 'wait_agent', 'list_agents', 'send_message'] })
  const before = agent.registered.get('subagent')
  await w.flush()
  assert.equal(w.calls.length, 0)
  assert.equal(agent.registered.get('subagent'), before)
  await w.turn('lead', true)
  assert.equal(w.calls.length, 0)
})

test('only the missing package mounts: subagent exists but control is absent', async () => {
  const w = world()
  w.addAgent('lead', { tools: ['subagent', 'list_subagent_models'] })
  await w.flush()
  assert.deepEqual(w.calls.map((call) => call.plugin), [CONTROL_PLUGIN])
})

test('only the missing package mounts: control exists but subagent is absent', async () => {
  const w = world()
  w.addAgent('lead', { tools: ['wait_agent', 'list_agents', 'send_message'] })
  await w.flush()
  assert.deepEqual(w.calls.map((call) => call.plugin), [SUBAGENT_PLUGIN])
})

test('a missing discovery tool alone does not mount a second subagent', async () => {
  const w = world()
  w.addAgent('lead', { tools: ['subagent', 'wait_agent', 'list_agents', 'send_message'] })
  await w.flush()
  assert.equal(w.calls.length, 0)
})

test('a child Agent is never given delegation tools', async () => {
  const w = world()
  w.addAgent('child', { child: true })
  await w.flush()
  assert.equal(w.calls.length, 0)
})

test('a root Agent created later is mounted once', async () => {
  const w = world()
  const agent = w.addAgent('later')
  for (const listener of w.listeners.created) listener({ agent })
  await w.flush()
  assert.equal(w.calls.length, 2)
  for (const listener of w.listeners.created) listener({ agent })
  await w.flush()
  assert.equal(w.calls.length, 2)
})

test('turning Advisor off disposes only the mounts it made', async () => {
  const w = world()
  const agent = w.addAgent('lead', { tools: ['subagent'] })
  await w.flush()
  assert.ok(agent.registered.has('wait_agent'))
  await w.turn('lead', false)
  assert.equal(agent.registered.has('wait_agent'), false)
  assert.equal(agent.registered.has('subagent'), true, 'a pre-existing tool is not disposed')
  assert.equal(w.disposers.created, 0)
  assert.equal(w.disposers.changed, 0)
})

test('off then on mounts again with no duplicates', async () => {
  const w = world()
  w.addAgent('lead')
  await w.flush()
  await w.turn('lead', false)
  await w.turn('lead', true)
  assert.equal(w.calls.length, 4)
  await w.turn('lead', true)
  assert.equal(w.calls.length, 4)
})

test('agent disposal releases the mount', async () => {
  const w = world()
  const agent = w.addAgent('lead')
  await w.flush()
  for (const listener of w.listeners.disposed) listener({ agent })
  assert.equal(agent.registered.size, 0)
  w.dispose()
  assert.equal(w.disposers.created, 1)
  assert.equal(w.disposers.changed, 1)
  assert.equal(w.disposers.disposed, 1)
})

test('a failed load reports a reason and never throws or mounts', async () => {
  const w = world({
    loaded: async () => ({ subagent: { reason: 'not installed' }, control: { reason: 'not installed' } }),
  })
  w.addAgent('lead')
  await w.flush()
  assert.equal(w.calls.length, 0)
  assert.equal(w.logs.filter((line) => line.includes('not installed')).length, 2)
})

test('one package failing to mount does not stop the other package', async () => {
  const w = world({ failMount: (plugin) => plugin === SUBAGENT_PLUGIN })
  const agent = w.addAgent('lead')
  await w.flush()
  assert.equal(agent.registered.has('subagent'), false)
  assert.equal(agent.registered.has('wait_agent'), true)
  const failed = w.calls.find((call) => call.plugin === SUBAGENT_PLUGIN)
  assert.equal(failed.disposed, 1, 'the failed fiber is disposed')
})

test('a non-function apply is a load reason, never a throw', async () => {
  const result = await loadHostPlugin('example', async () => ({}))
  assert.match(result.reason, /no apply function/)
  const failed = await loadHostPlugin('example', async () => { throw new Error('missing') })
  assert.match(failed.reason, /did not load: missing/)
})

test('both host packages load once at apply and use their exported names', async () => {
  const seen = []
  const ready = startDelegationLoad(async (name) => {
    seen.push(name)
    return name === SUBAGENT_PACKAGE ? SUBAGENT_PLUGIN : CONTROL_PLUGIN
  })
  const loaded = await ready()
  assert.deepEqual(seen, [SUBAGENT_PACKAGE, CONTROL_PACKAGE])
  assert.deepEqual(loaded.subagent.plugin, SUBAGENT_PLUGIN)
  assert.deepEqual(loaded.control.plugin, CONTROL_PLUGIN)
})
