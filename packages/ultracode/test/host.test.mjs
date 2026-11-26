import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { apply, POLICY } from '../src/index.host.js'
import { isDelegationTool, MAX_SPAWN_ATTEMPTS } from '../src/state.js'

const readme = () => readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\s+/g, ' ')

function harness() {
  let definition
  let section
  let command
  let guard
  const calls = []
  let state = { active: false, pending: null, run: null }
  const ctx = {
    tools: { guard(fn) { guard = fn } },
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
    get: () => ({ definition, section, command, calls, state, guard }),
    setState: (next) => { state = next },
  }
}

test('apply registers the projection, section, and command', async () => {
  const { ctx, get } = harness()
  await apply(ctx)
  const { definition, section, command, calls } = get()
  assert.equal(definition.key, 'ultracode')
  assert.equal(definition.stateVersion, 5)
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

test('policy is exhaustive within budget and declares gaps', () => {
  assert.match(POLICY, /exhaustive within budget, with declared gaps/)
  assert.doesNotMatch(POLICY, /exhaustive correctness/)
})

test('policy reserves delegation 24 for the final completeness critic', () => {
  assert.match(POLICY, /at most 23 work delegations/)
  assert.match(POLICY, /24th delegation is reserved for a final completeness critic if any delegation occurred/)
  assert.match(POLICY, /original request and final result/)
  assert.match(POLICY, /not worker transcripts/)
  assert.match(POLICY, /critic's output must appear in the final answer/)
  assert.match(POLICY, /may fix gaps inline, but may not delegate again or drop them/)
})

test('policy requires a final section for all examination gaps', () => {
  assert.match(POLICY, /## Not examined \/ not verified/)
  assert.match(POLICY, /Write `none` if it is empty/)
  assert.match(POLICY, /budgets, file or time limits, or truncation/)
  assert.match(POLICY, /every gap in the critic's output/)
})

test('policy carries the three verification-discipline rules', () => {
  assert.match(POLICY, /Before spawning review or critic agents, run the project's own cheap deterministic checks \(tests, build, linter\) where they exist, and show their output instead of saying the work is done/)
  assert.match(POLICY, /still failing after three fix rounds, stop, report what remains, and ask the user instead of looping/)
  assert.match(POLICY, /Do not stack extra reviewers on top of the primary one/)
  assert.match(POLICY, /Point each later round at the findings and failures of earlier rounds instead of re-checking everything from scratch/)
  const bullets = POLICY.split('\n').filter((line) => line.startsWith('- '))
  assert.equal(bullets.length, 11)
})

test('the new rules leave the budget, critic, and gaps text unchanged', () => {
  assert.ok(POLICY.includes('- Budget: A turn allows at most 23 work delegations; the 24th delegation is reserved for a final completeness critic if any delegation occurred. Host delegation limits are hard limits. On exhaustion, report what is unverified rather than quietly reducing rigor.'))
  assert.ok(POLICY.includes("- Final completeness critic: Give the critic the original request and final result (the draft you intend to send), not worker transcripts. Ask it to identify missing or unverified work. Every gap in the critic's output must appear in the final answer. The orchestrator may fix gaps inline, but may not delegate again or drop them."))
  assert.ok(POLICY.endsWith("- Final gaps section: End every final answer with a section headed `## Not examined / not verified`. Write `none` if it is empty. Otherwise include all gaps from budgets, file or time limits, or truncation, and every gap in the critic's output."))
  assert.doesNotMatch(POLICY, /\b2[5-9] work delegations|\b(?:25|26)th delegation/)
})

test('the prompt section adds the new rules only while active', async () => {
  const { ctx, get, agent, setState } = harness()
  await apply(ctx)
  const { section } = get()
  assert.equal(section.text({ agent }), '')
  setState({ active: true, pending: null, run: null })
  assert.equal(section.text({ agent }), POLICY)
})

test('the command validates input and reports state without changing Team', async () => {
  const { ctx, get, agent } = harness()
  await apply(ctx)
  const { command } = get()
  assert.equal((await command.handler({ agent, rawInput: 'status' })).kind, 'success')
  assert.equal((await command.handler({ agent, rawInput: 'status' })).text, 'Ultracode is off for this session.')
  assert.equal((await command.handler({ agent, rawInput: 'on' })).kind, 'success')
  assert.equal((await command.handler({ agent, rawInput: 'off' })).kind, 'success')
  assert.equal((await command.handler({ agent, rawInput: 'bogus' })).kind, 'error')
})

// Runs a command the way the host does: command/run is folded before the
// handler, and command/done after it with the handler's outcome.
async function dispatch(h, rawInput, commandId, time = 1000) {
  const { definition, command } = h.get()
  const feed = (event) => h.setState(definition.apply(h.get().state, event))
  feed({ type: 'command/run', time, data: { name: 'ultracode', args: rawInput, commandId } })
  const result = await command.handler({ agent: h.agent, rawInput, commandId })
  feed({ type: 'command/done', data: { commandId, kind: result.kind, text: result.text } })
  return result
}

test('a bare /ultracode toggles the mode and its reply names the new mode', async () => {
  const h = harness()
  await apply(h.ctx)
  const { section } = h.get()
  assert.deepEqual(await dispatch(h, '', 'bare-1'), { kind: 'success', text: 'Ultracode on. The next model request will use exhaustive orchestration.' })
  assert.equal(h.get().state.active, true)
  assert.equal(section.text({ agent: h.agent }), POLICY)
  assert.equal((await h.get().command.handler({ agent: h.agent, rawInput: 'status' })).text, 'Ultracode is on for this session.')
  assert.deepEqual(await dispatch(h, '  ', 'bare-2', 2000), { kind: 'success', text: 'Ultracode off. The next model request will use the normal workflow.' })
  assert.equal(h.get().state.active, false)
  assert.equal(section.text({ agent: h.agent }), '')
})

test('explicit on and off through the host path still set the mode, and a repeat changes nothing', async () => {
  const h = harness()
  await apply(h.ctx)
  assert.equal((await dispatch(h, 'ON', 'c1')).kind, 'success')
  assert.equal(h.get().state.active, true)
  assert.equal((await dispatch(h, 'on', 'c2', 2000)).text, 'Ultracode on. The next model request will use exhaustive orchestration.')
  assert.equal(h.get().state.active, true)
  assert.equal((await dispatch(h, 'off', 'c3', 3000)).kind, 'success')
  assert.equal(h.get().state.active, false)
})

test('a bare /ultracode while another update is pending is rejected and changes nothing', async () => {
  const h = harness()
  await apply(h.ctx)
  const { definition } = h.get()
  h.setState(definition.apply(h.get().state, { type: 'command/run', time: Date.now(), data: { name: 'ultracode', args: 'on', commandId: 'first' } }))
  const result = await dispatch(h, '', 'second', Date.now())
  assert.equal(result.kind, 'error')
  assert.match(result.text, /already updating/)
  assert.equal(h.get().state.active, false)
  assert.equal(h.get().state.pending.commandId, 'first')
})

test('an unknown argument returns the usage text and changes nothing', async () => {
  const h = harness()
  await apply(h.ctx)
  assert.deepEqual(await dispatch(h, 'toggle', 'u1'), { kind: 'error', text: 'Usage: /ultracode [on|off|status]' })
  assert.equal(h.get().state.active, false)
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

test('guard allows attempt 24 and denies attempt 25 while a run is open', async () => {
  const { ctx, get, agent, setState } = harness()
  await apply(ctx)
  setState({
    active: true,
    pending: null,
    run: { turn: 1, startedAt: 0, endedAt: null, spawnAttempts: 24, stop: null },
  })
  assert.equal(get().guard({ agent, name: 'subagent' }), undefined)
  get().state.run.spawnAttempts = 25
  const denial = get().guard({ agent, name: 'subagent' })
  assert.equal(denial.reason, 'ultracode_budget_exhausted:spawns')
  get().state.run.spawnAttempts = 23
  assert.equal(get().guard({ agent, name: 'subagent' }), undefined)
  assert.equal(get().guard({ agent, name: 'read' }), undefined)
})

test('off mid-run still enforces the open run budget', async () => {
  const { ctx, get, agent, setState } = harness()
  await apply(ctx)
  setState({
    active: false,
    pending: null,
    run: { turn: 1, startedAt: 0, endedAt: null, spawnAttempts: 25, stop: null },
  })
  const denial = get().guard({ agent, name: 'subagent' })
  assert.equal(denial.reason, 'ultracode_budget_exhausted:spawns')
})

test('guard ignores closed runs and non-delegation calls', async () => {
  const { ctx, get, agent } = harness()
  await apply(ctx)
  get().state = {
    active: true,
    pending: null,
    run: { turn: 1, startedAt: 0, endedAt: 100, spawnAttempts: 24, stop: null },
  }
  assert.equal(get().guard({ agent, name: 'subagent' }), undefined)
  assert.equal(get().guard({ agent, name: 'workflow' }), undefined)
})

test('status reports the current run from projection only', async () => {
  const { ctx, get, agent, setState } = harness()
  await apply(ctx)
  setState({
    active: true,
    pending: null,
    run: { turn: 1, startedAt: 0, endedAt: null, spawnAttempts: 7, stop: null },
  })
  const { command } = get()
  const result = await command.handler({ agent, rawInput: 'status' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Current run: 7\/24 attempts · stop: none/)
})

test('the README states the bare toggle, the argument rules and the status texts', () => {
  const text = readme()
  for (const sentence of [
    'With no argument, `/ultracode` toggles the mode, and its reply names the new mode',
    'Any other argument returns `Usage: /ultracode [on|off|status]`.',
    '`Ultracode is already updating. Try again after it finishes.`',
    '`/ultracode status` should then answer `Ultracode is off for this session.`',
  ]) assert.ok(text.includes(sentence), sentence)
})

test('the README names the delegation tools the guard counts, and the ones it does not', () => {
  const text = readme()
  const counted = ['subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code', 'spawn_teammate']
  assert.ok(text.includes('It counts calls to `subagent`, `subagent_fork`, `subagent_codex`, `subagent_claude_code` and `spawn_teammate`'))
  for (const name of counted) assert.equal(isDelegationTool(name), true, name)
  for (const name of ['workflow', 'send_message']) {
    assert.equal(isDelegationTool(name), false, name)
    assert.ok(text.includes(`\`${name}\``), name)
  }
  assert.equal(MAX_SPAWN_ATTEMPTS, 24)
  assert.ok(text.includes('**24 direct delegation attempts**'))
  assert.ok(text.includes('The 25th attempt is denied with `ultracode_budget_exhausted:spawns`.'))
  assert.ok(text.includes('Only the host guard (24 delegation attempts per turn) is enforced.'))
})
