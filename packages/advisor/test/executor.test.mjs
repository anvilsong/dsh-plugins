// Unit tests for src/executor.js: loading the native executor plugin, mounting
// it on one child's Agent scope with a fake cordis fiber, and the fail-fast
// rule for run_code. Nothing here touches the profile, the DSH home or a Host.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  loadNativeExecutor,
  mountConfirmed,
  mountNativeExecutor,
  NATIVE_EXECUTOR_PACKAGE,
  RUN_CODE,
  runCodeFailure,
} from '../src/executor.js'
import { fakeFiber, NATIVE as LOADED } from './helpers/native.mjs'

const settle = () => new Promise((resolve) => setImmediate(resolve))
const apply = () => {}
const REMEDY = 'run the Advisor from a session on the standard or cordis agent preset'

/** A fake child Agent whose ctx.plugin returns `make()`; `runCode` is what tools.get('run_code') gives. */
function fakeAgent(make = () => fakeFiber(), { runCode } = {}) {
  const agent = {
    id: 'child',
    plugins: [],
    fibers: [],
    ctx: {
      tools: { get: (name) => (name === RUN_CODE ? runCode : undefined) },
      plugin(value) {
        agent.plugins.push(value)
        const fiber = make()
        agent.fibers.push(fiber)
        return fiber
      },
    },
  }
  return agent
}

function recorder() {
  const lines = []
  return { lines, report: (level, line) => lines.push([level, line]) }
}

// ---------------------------------------------------------------------------
// loadNativeExecutor

test('load: the plugin is { name, inject, apply } of the imported module; a missing apply or a failed import is a reason', async () => {
  const module = { name: 'native-tool-executor', inject: ['tools'], apply, NativeToolExecutor: class {} }
  const loaded = await loadNativeExecutor(async () => module)
  assert.equal(loaded.plugin.apply, apply)
  assert.equal(loaded.plugin.name, 'native-tool-executor')
  assert.deepEqual(loaded.plugin.inject, ['tools'])
  assert.ok(Object.isFrozen(loaded.plugin))
  assert.equal(loaded.reason, undefined)

  assert.deepEqual(await loadNativeExecutor(async () => ({ name: 'x' })), { reason: `${NATIVE_EXECUTOR_PACKAGE} has no apply function` })
  assert.deepEqual(await loadNativeExecutor(async () => { throw new Error('Cannot find package') }), { reason: `${NATIVE_EXECUTOR_PACKAGE} did not load: Cannot find package` })
  assert.deepEqual(await loadNativeExecutor(() => { throw new Error('sync') }), { reason: `${NATIVE_EXECUTOR_PACKAGE} did not load: sync` })
  const long = await loadNativeExecutor(async () => { throw new Error('x'.repeat(1000)) })
  assert.ok(long.reason.length < 400, 'a reason is cut to a bounded length')
})

test('load: the default import of the bare package resolves nothing in this repository and yields a reason, never a throw', async () => {
  // The repository has no host packages; inside DSH the peer declaration resolves the installation copy.
  const loaded = await loadNativeExecutor()
  assert.equal(loaded.plugin, undefined)
  assert.match(loaded.reason, new RegExp(`^${NATIVE_EXECUTOR_PACKAGE.replace(/[/.-]/g, '\\$&')} did not load: `))
})

// ---------------------------------------------------------------------------
// mountNativeExecutor

test('mount: a fiber that starts is confirmed only after it settles active; one info line names outcome, state and run_code', async () => {
  const agent = fakeAgent()
  const { lines, report } = recorder()
  const mount = mountNativeExecutor(agent, LOADED, report)
  assert.deepEqual(agent.plugins, [LOADED.plugin], 'ctx.plugin is called once with the loaded plugin')
  assert.equal(mount.status, 'pending', 'state 1 (loading) right after the call is not yet confirmed')
  assert.equal(mountConfirmed(mount), false)
  assert.deepEqual(lines, [])
  await settle()
  assert.equal(mount.status, 'active')
  assert.equal(mountConfirmed(mount), true)
  assert.deepEqual(lines, [['info', "native executor mounted on the child's Agent scope (presentation only; the guards and the run_code denial are unchanged); fiber state 2 active; run_code in tools: no"]])
  assert.equal(agent.fibers[0].disposeCalls, 0)
  mount.dispose()
  mount.dispose()
  assert.equal(agent.fibers[0].disposeCalls, 1, 'dispose is idempotent')
  assert.equal(mountConfirmed(mount), false, 'a released mount is not confirmed')
  assert.equal(lines.length, 1, 'still one line')
})

test('mount: run_code registered as a tool shows in the line (a later Host might register it)', async () => {
  const agent = fakeAgent(undefined, { runCode: { name: RUN_CODE } })
  const { lines, report } = recorder()
  mountNativeExecutor(agent, LOADED, report)
  await settle()
  assert.match(lines[0][1], /run_code in tools: yes$/)
})

test('mount: an inactive fiber, an async rejection, a synchronous throw or no plugin method each fail the mount, with one warn line', async () => {
  const cases = [
    ['inactive right after the call', fakeAgent(() => fakeFiber({ initial: 0, outcome: 'never' })), /the executor fiber is 0 inactive \(an injection is unavailable\) right after mounting/, true],
    ['inactive after settling', fakeAgent(() => fakeFiber({ outcome: 'inactive' })), /the executor fiber settled as 0 inactive/, true],
    ['async rejection', fakeAgent(() => fakeFiber({ outcome: 'reject' })), /the executor failed to start: Only one tool executor may be registered in each scope/, true],
    ['already failed', fakeAgent(() => fakeFiber({ initial: 3, outcome: 'never' })), /the executor fiber is 3 failed right after mounting/, true],
    ['synchronous throw', fakeAgent(() => { throw new Error('service "tools" has been registered at <x>') }), /mounting threw: service "tools" has been registered at <x>/, false],
    ['no fiber', fakeAgent(() => undefined), /the mount returned no fiber/, false],
  ]
  for (const [label, agent, reason, disposes] of cases) {
    const { lines, report } = recorder()
    const mount = mountNativeExecutor(agent, LOADED, report)
    await settle()
    assert.equal(mount.status, 'failed', label)
    assert.match(mount.reason, reason, label)
    assert.equal(mountConfirmed(mount), false, label)
    assert.equal(lines.length, 1, label)
    assert.equal(lines[0][0], 'warn', label)
    assert.match(lines[0][1], /^native executor not mounted: .*; fiber state .*; run_code in tools: no$/, label)
    if (disposes) assert.equal(agent.fibers[0].disposeCalls, 1, `${label}: the failed fiber is disposed`)
    mount.dispose()
    if (disposes) assert.equal(agent.fibers[0].disposeCalls, 1, `${label}: not twice`)
  }

  const bare = { ctx: { tools: { get: () => undefined } } }
  const { lines, report } = recorder()
  const mount = mountNativeExecutor(bare, LOADED, report)
  assert.equal(mount.status, 'failed')
  assert.equal(mount.reason, 'the child Agent context has no plugin method')
  assert.equal(lines.length, 1)
})

test('mount: no loaded plugin skips ctx.plugin and names the reason', () => {
  for (const [loaded, reason] of [
    [undefined, 'no native executor plugin was provided'],
    [{ reason: `${NATIVE_EXECUTOR_PACKAGE} did not load: Cannot find package` }, `${NATIVE_EXECUTOR_PACKAGE} did not load: Cannot find package`],
  ]) {
    const agent = fakeAgent()
    const { lines, report } = recorder()
    const mount = mountNativeExecutor(agent, loaded, report)
    assert.equal(agent.plugins.length, 0)
    assert.equal(mount.status, 'skipped')
    assert.equal(mount.reason, reason)
    assert.deepEqual(lines, [['warn', `native executor not mounted: ${reason}; fiber state none; run_code in tools: no`]])
  }
})

test('mount: a fiber that never settles stays pending; released, it is disposed once and logged once; a late start changes nothing', async () => {
  let late
  const agent = fakeAgent(() => {
    const fiber = fakeFiber({ outcome: 'never' })
    late = () => { fiber.state = 2 }
    return fiber
  })
  const { lines, report } = recorder()
  const mount = mountNativeExecutor(agent, LOADED, report)
  await settle()
  assert.equal(mount.status, 'pending')
  assert.deepEqual(lines, [])
  mount.dispose()
  assert.equal(agent.fibers[0].disposeCalls, 1)
  assert.deepEqual(lines, [['warn', 'native executor not confirmed: the mount was released before its fiber started; fiber state 1 loading; run_code in tools: no']], 'the line shows the state the fiber was released in')
  late()
  await settle()
  assert.equal(mountConfirmed(mount), false)
  assert.equal(lines.length, 1)
})

test('mount: a dispose that throws or rejects is swallowed, and a throwing report breaks nothing', async () => {
  const agent = fakeAgent(() => ({ state: 1, then: () => {}, dispose: () => { throw new Error('gone') } }))
  const mount = mountNativeExecutor(agent, LOADED, () => { throw new Error('logger gone') })
  assert.doesNotThrow(() => mount.dispose())
  const rejecting = fakeAgent(() => ({ state: 1, then: () => {}, dispose: () => Promise.reject(new Error('late')) }))
  const second = mountNativeExecutor(rejecting, LOADED)
  second.dispose()
  await settle()
})

// ---------------------------------------------------------------------------
// runCodeFailure

const exec = (toolSet) => ({ name: RUN_CODE, arguments: { code: 'return 1' }, toolSet })

test('fail fast: without a confirmed mount the first run_code call has the named reason with the remedy', async () => {
  const pending = mountNativeExecutor(fakeAgent(() => fakeFiber({ outcome: 'never' })), LOADED)
  const failed = mountNativeExecutor(fakeAgent(() => fakeFiber({ outcome: 'reject' })), LOADED)
  const skipped = mountNativeExecutor(fakeAgent(), { reason: 'not installed' })
  await settle()
  const released = mountNativeExecutor(fakeAgent(), LOADED)
  await settle()
  released.dispose()
  for (const [mount, problem] of [
    [undefined, 'no native executor was provided to the Advisor boundary'],
    [skipped, 'not installed'],
    [pending, 'the executor fiber has not started yet (state 1 loading)'],
    [failed, 'the executor failed to start: Only one tool executor may be registered in each scope'],
    [released, 'the mount was already released'],
  ]) {
    assert.equal(runCodeFailure(mount, exec({}), 'advisor child'),
      `run_code was requested: this session uses the PTC executor and the native executor could not be mounted for the advisor child (${problem}); ${REMEDY}`)
  }
  assert.match(runCodeFailure(undefined, exec(), 'advisor verifier'), /mounted for the advisor verifier \(/)
})

test('fail fast: with a confirmed mount the run_code calls of one step are tolerated; a later step closes the run', async () => {
  const mount = mountNativeExecutor(fakeAgent(), LOADED)
  await settle()
  const first = {}
  const later = {}
  assert.equal(runCodeFailure(mount, exec(first), 'advisor child'), undefined)
  assert.equal(runCodeFailure(mount, exec(first), 'advisor child'), undefined, 'the same step')
  assert.equal(runCodeFailure(mount, exec(later), 'advisor child'),
    `run_code was requested again after the native executor was mounted for the advisor child: this session uses the PTC executor and the mount did not change the tools it is offered; ${REMEDY}`)

  const noStep = mountNativeExecutor(fakeAgent(), LOADED)
  await settle()
  assert.equal(runCodeFailure(noStep, exec(undefined), 'advisor verifier'), undefined, 'one call without a step is tolerated')
  assert.match(runCodeFailure(noStep, exec(undefined), 'advisor verifier'), /^run_code was requested again after the native executor was mounted for the advisor verifier/)
})
