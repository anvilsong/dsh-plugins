import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, mkdtemp, mkdir, readdir, writeFile, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, POLICY, UNCONFIGURED_POLICY, unavailablePolicy } from '../src/index.host.js'
import { ADVISOR_WORKFLOW, DATA_DIR_NOT_CONFIGURED, dataDirUnusable } from '../src/planner.js'
import {
  installVerifierBoundary,
  VERIFIER_TOOLS,
  VERIFIER_WORKFLOW,
  verifierDelegationDenial,
  verifierModelPolicy,
} from '../src/verifier.js'

const selected = { provider: 'openrouter', model: '~deepseek/deepseek-flash-latest' }

// `profile`: what ctx.get('profileContext') returns (absent: no ctx.get at all).
function harness({ profile } = {}) {
  const definitions = {}
  const warnings = []
  let section
  let command
  let state = { active: false, verifierModel: null, pending: null }
  let routes = [selected, { provider: 'anthropic', model: 'claude-haiku-5-5' }]
  const ctx = {
    sessionProjections: {
      async register(value) {
        definitions[value.key] = value
        return { stateOf: () => value.key === 'advisor' ? state : routes }
      },
    },
    systemPrompt: { getSectionOrder: () => 500, section(value) { section = value } },
    inject(names, callback) {
      if (names.includes('commands')) callback({ commands: { register(value) { command = value } } })
    },
    logger: { warn: (message) => warnings.push(message), info() {}, debug() {} },
    ...(profile === undefined ? {} : { get: (name) => (name === 'profileContext' ? profile : undefined) }),
  }
  return {
    ctx,
    agent: { session: {} },
    warnings,
    get: () => ({
      definition: definitions.advisor,
      modelRoutesDefinition: definitions.advisorModelRoutes,
      section,
      command,
      state,
      routes,
    }),
    setState: (next) => { state = next },
    setRoutes: (next) => { routes = next },
  }
}

async function tempDir(t, prefix) {
  const dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), prefix)))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function boundaryHarness({ dataDirProblem } = {}) {
  const listeners = {}
  const globalGuards = []
  const agents = new Map()
  const definitions = Object.fromEntries(
    [...VERIFIER_TOOLS, 'bash', 'write', 'run_code', 'team_task_update'].map((name) => [name, { name }]),
  )
  const globalNames = new Set(['team_task_get', 'bash', 'write', 'run_code', 'team_task_update'])
  const tools = {
    get(name, agent) {
      if (agent?.shadows?.has(name)) return agent.shadows.get(name)
      if (agent === undefined && !globalNames.has(name)) return undefined
      return definitions[name]
    },
    guard(guard) { globalGuards.push(guard); return () => {} },
  }
  const ctx = {
    agents: { get: (id) => agents.get(id) },
    subagents: { namesOf: (agent) => agent.names },
    tools,
    on(name, listener) { listeners[name] = listener; return () => {} },
    logger: { warn() {} },
  }
  const dispose = installVerifierBoundary(ctx, undefined, undefined, dataDirProblem)
  const sequence = []
  function agent(id, self, parent = 'lead') {
    const guards = []
    const restrictions = []
    const sections = []
    const value = {
      id,
      names: { self, parent },
      shadows: new Map(),
      cancelled: false,
      cancel() { this.cancelled = true },
      ctx: {
        tools: {
          get: tools.get,
          guard(guard) { guards.push(guard); sequence.push('guard'); return () => {} },
          restrict(filter) { restrictions.push(filter); sequence.push('restrict') },
        },
        systemPrompt: {
          getSectionOrder: () => 500,
          section(section) { sections.push(section); sequence.push('section') },
        },
      },
    }
    agents.set(id, value)
    return { value, guards, restrictions, sections }
  }
  return { ctx, listeners, globalGuards, definitions, sequence, agent, dispose }
}

test('registers advisor and authorized-route projections, prompt, and command', async () => {
  const { ctx, get } = harness()
  await apply(ctx)
  const { definition, modelRoutesDefinition, section, command } = get()
  assert.equal(definition.key, 'advisor')
  assert.equal(definition.stateVersion, 6)
  assert.equal(modelRoutesDefinition.stateVersion, 1)
  assert.equal(section.name, 'advisor:policy')
  assert.equal(command.name, 'advisor')
  const event = {
    type: 'subagent/model-selection-policy',
    data: { allowedModels: [{ provider: 'openrouter', model: 'one', display: 'not projected' }] },
  }
  assert.deepEqual(modelRoutesDefinition.apply(null, event), [{ provider: 'openrouter', model: 'one' }])
  assert.deepEqual(modelRoutesDefinition.apply([{ provider: 'openrouter', model: 'one' }], event), [{ provider: 'openrouter', model: 'one' }])
})

test('policy and host boundary keep verification read-only and route-exact', () => {
  assert.match(POLICY, /in-process, read-only child agent on the Advisor model/)
  assert.match(POLICY, /Never run consult\.py or load the advisor skill for Advisor mode/)
  assert.match(POLICY, /ledger consult_id/)
  assert.match(POLICY, /Never use subagent_fork, subagent_claude_code, or subagent_codex/)
  assert.match(POLICY, /never include credentials, secrets/)
  assert.match(POLICY, /at most three advisor runs per task/)
  assert.match(POLICY, /advisor-planner-<id>/)
  assert.match(POLICY, /advisor-consult-<id>/)
  assert.doesNotMatch(VERIFIER_WORKFLOW, /never a teammate, runs consult\.py/)
  assert.match(VERIFIER_WORKFLOW, /active whenever Advisor is enabled/)
  assert.match(VERIFIER_WORKFLOW, /team_task_create/)
  assert.match(VERIFIER_WORKFLOW, /Claim it as the lead/)
  assert.match(VERIFIER_WORKFLOW, /confirmed, refuted, or unverifiable with file:line evidence/)
  assert.match(verifierModelPolicy(null), /Omit provider, model, reasoning_effort, and agent_preset/)
  assert.match(verifierModelPolicy(selected), /Pass exactly this provider and model/)

  const boundary = boundaryHarness()
  const child = boundary.agent('child', 'advisor-verifier-abcdef012345')
  boundary.listeners['subagent/start']({ id: 'child', local: true, provider: 'spawn' })
  boundary.sequence.push('initial-prompt')
  assert.deepEqual(boundary.sequence, ['guard', 'section', 'initial-prompt'])
  assert.deepEqual(child.restrictions, [])
  assert.equal(child.guards.length, 1)
  assert.equal(child.value.cancelled, false)

  for (const name of VERIFIER_TOOLS) {
    const exec = { name, agent: child.value, arguments: {} }
    assert.equal(boundary.globalGuards[0](exec), undefined)
    assert.equal(child.guards[0](exec), undefined)
  }
  boundary.definitions['late-scoped'] = { name: 'late-scoped' }
  for (const name of ['bash', 'write', 'run_code', 'team_task_update', 'late-scoped']) {
    const exec = { name, agent: child.value, arguments: {} }
    assert.equal(boundary.globalGuards[0](exec), undefined)
    assert.match(child.guards[0](exec), /read-only/)
  }
  child.value.shadows.set('read', { name: 'read' })
  assert.match(child.guards[0]({ name: 'read', agent: child.value, arguments: {} }), /shadowed/)
  boundary.listeners['subagent/end']({ id: 'child' })
  assert.match(
    boundary.globalGuards[0]({ name: 'bash', agent: child.value, arguments: {} }),
    /failed closed/,
    'host guard re-derives identity after its lifecycle cache entry is removed',
  )

  const invalid = boundary.agent('invalid', 'advisor-verifier-abcdef01234')
  boundary.listeners['subagent/start']({ id: 'invalid', local: true, provider: 'spawn' })
  assert.equal(invalid.value.cancelled, true)
  assert.match(invalid.guards[0]({ name: 'read', agent: invalid.value, arguments: {} }), /failed closed/)
  const grandchild = boundary.agent('grandchild', 'advisor-verifier-abcdef012345', 'advisor-verifier-abcdef012345')
  boundary.listeners['subagent/start']({ id: 'grandchild', local: true, provider: 'spawn' })
  assert.equal(grandchild.value.cancelled, true)

  const validArgs = { name: 'advisor-verifier-abcdef012345' }
  assert.equal(verifierDelegationDenial({ name: 'subagent', arguments: validArgs }), undefined)
  assert.match(verifierDelegationDenial({ name: 'subagent_fork', arguments: validArgs }), /fresh in-process/)
  assert.match(verifierDelegationDenial({ name: 'subagent', arguments: { ...validArgs, model: 'other' } }), /set to Inherit/)
  assert.match(verifierDelegationDenial({ name: 'subagent', arguments: validArgs }, () => false), /off for this session/)
  assert.match(verifierDelegationDenial({ name: 'subagent', arguments: { name: 'advisor-verifier-uppercase' } }), /12-character/)
  assert.equal(verifierDelegationDenial({ name: 'subagent', arguments: { name: 'reviewer' } }), undefined)

  const exact = { ...validArgs, provider: selected.provider, model: selected.model }
  const useSelected = () => selected
  assert.equal(verifierDelegationDenial({ name: 'subagent', arguments: exact }, () => true, useSelected), undefined)
  assert.match(
    verifierDelegationDenial({ name: 'subagent', arguments: validArgs }, () => true, useSelected),
    /must use the selected route openrouter\/~deepseek\/deepseek-flash-latest/,
  )
  assert.match(
    verifierDelegationDenial({ name: 'subagent', arguments: { ...exact, model: 'other' } }, () => true, useSelected),
    /must use the selected route/,
  )
  assert.match(
    verifierDelegationDenial({ name: 'subagent', arguments: { ...exact, reasoning_effort: 'high' } }, () => true, useSelected),
    /must omit reasoning_effort and agent_preset/,
  )

  boundary.dispose()
  assert.match(child.guards[0]({ name: 'bash', agent: child.value, arguments: {} }), /read-only/)
})

test('status reports the data directory, recent ledger entries, and automatic verifier model', async (t) => {
  const dir = await tempDir(t, 'advisor-ledger-')
  await writeFile(path.join(dir, 'sessions.jsonl'),
    JSON.stringify({ consult_id: 'started1', advisor: 'unknown', status: 'started', topic: 'review' }) + '\n' +
    JSON.stringify({ consult_id: 'abc123', advisor: 'fable', status: 'ok', topic: 'review' }) + '\n', { mode: 0o600 })
  await chmod(path.join(dir, 'sessions.jsonl'), 0o600) // explicit, whatever the umask
  const { ctx, get, agent, warnings } = harness()
  await apply(ctx, { dataDir: dir })
  const result = await get().command.handler({ agent, rawInput: 'status' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Advisor is off; verification is disabled/)
  assert.match(result.text, /Verifier model: Inherit/)
  assert.ok(result.text.includes(`\nData directory: ${dir}\nRecent advisor runs:\nabc123 fable ok review`), result.text)
  assert.doesNotMatch(result.text, /started1|not configured/)
  assert.deepEqual(warnings, [])
})

test('prompt: the lead policy names the absolute ledger and replies paths of the configured dataDir', async (t) => {
  const dataDir = path.join(await tempDir(t, 'advisor-prompt-'), 'advisor data')
  const { ctx, get, setState, agent } = harness({ profile: { home: path.join(os.tmpdir(), 'unused-dsh-home') } })
  await apply(ctx, { dataDir })
  const { section } = get()
  assert.equal(section.text({ agent: undefined }), '')
  assert.equal(section.text({ agent }), '', 'Advisor off: no policy')
  setState({ active: true, verifierModel: null, advisorModel: null, pending: null })
  const text = section.text({ agent })
  assert.ok(text.includes(`the ledger \`${path.join(dataDir, 'sessions.jsonl')}\``), text)
  assert.ok(text.includes(`the reply file \`${path.join(dataDir, 'replies', '<id>.md')}\``), text)
  assert.ok(text.includes("Runs recorded before this folder existed stay in the advisor skill's legacy ledger and are not verified from here."))
  assert.doesNotMatch(text, /<state>|<dataDir>|unused-dsh-home/)
  assert.ok(text.includes(VERIFIER_WORKFLOW))
  assert.match(text, /Advisor model: Inherit/)
  assert.match(text, /Verifier model: Inherit/)
  assert.equal(POLICY, ADVISOR_WORKFLOW, 'the exported POLICY keeps placeholder paths')
  assert.match(POLICY, /`<dataDir>\/sessions\.jsonl`/)
  await assert.rejects(readdir(dataDir), { code: 'ENOENT' }, 'apply() creates no folder; the first write does')
})

test('dataDir: without config it defaults to <profileContext.home>/advisor; config overrides the home', async (t) => {
  const home = await tempDir(t, 'advisor-home-')
  const defaulted = harness({ profile: { home, dir: path.join(home, 'profiles', 'x') } })
  await apply(defaulted.ctx)
  let status = await defaulted.get().command.handler({ agent: defaulted.agent, rawInput: 'status' })
  assert.ok(status.text.includes(`\nData directory: ${path.join(home, 'advisor')}\nRecent advisor runs:\nNo consults recorded.`), status.text)
  defaulted.setState({ active: true, verifierModel: null, advisorModel: null, pending: null })
  assert.ok(defaulted.get().section.text({ agent: defaulted.agent }).includes(path.join(home, 'advisor', 'sessions.jsonl')))

  const configured = path.join(home, 'elsewhere')
  const overridden = harness({ profile: { home } })
  await apply(overridden.ctx, { dataDir: configured })
  status = await overridden.get().command.handler({ agent: overridden.agent, rawInput: 'status' })
  assert.ok(status.text.includes(`\nData directory: ${configured}\n`), status.text)

  const throwing = harness()
  throwing.ctx.get = () => { throw new Error('no such service') }
  await apply(throwing.ctx, { dataDir: configured })
  status = await throwing.get().command.handler({ agent: throwing.agent, rawInput: 'status' })
  assert.ok(status.text.includes(`\nData directory: ${configured}\n`), 'a throwing ctx.get is ignored when dataDir is set')
  assert.deepEqual(await readdir(home), [], 'nothing is created before the first advisor run')
})

test('fail closed: without a usable dataDir, apply() warns, status reports it, and the policy offers no workflow', async (t) => {
  const home = await tempDir(t, 'advisor-unconfigured-')
  await mkdir(path.join(home, 'decoy'))
  const cases = [
    ['no config and no profileContext', undefined, undefined, /Advisor dataDir is not configured/],
    ['empty config and a profileContext without home', {}, { dir: home }, /Advisor dataDir is not configured/],
    ['relative dataDir', { dataDir: 'advisor' }, { home }, /must be an absolute path/],
    ['~ dataDir', { dataDir: '~/advisor' }, { home }, /must be an absolute path/],
    ['empty dataDir', { dataDir: '' }, { home }, /non-empty string/],
    ['.. dataDir', { dataDir: `${home}/decoy/../advisor` }, { home }, /"\.\." segments/],
    ['non-string dataDir', { dataDir: 7 }, { home }, /non-empty string/],
    ['filesystem root', { dataDir: '/' }, { home }, /must not be a filesystem root/],
    ['backtick in dataDir', { dataDir: `${home}/a\`b` }, { home }, /backtick characters/],
    ['bidi control in dataDir', { dataDir: `${home}/a\u202eb` }, { home }, /bidirectional control/],
    ['trailing whitespace', { dataDir: `${home}/advisor ` }, { home }, /must not start or end with whitespace/],
  ]
  const enabled = 'Advisor on. The in-process advisor and read-only verification are enabled.'
  // The reply names the reason, as status does.
  const onReply = (text, problem, label) => {
    assert.ok(text.startsWith(`${enabled}\n${DATA_DIR_NOT_CONFIGURED} Reason: `), `${label}: ${text}`)
    assert.ok(text.endsWith('. Until then advisor runs and verification are refused.'), `${label}: ${text}`)
    assert.match(text, problem, label)
  }
  for (const [label, config, profile, problem] of cases) {
    const { ctx, get, setState, agent, warnings } = harness({ profile })
    await apply(ctx, config)
    assert.equal(warnings.length, 1, label)
    assert.match(warnings[0], problem, label)
    assert.match(warnings[0], /Advisor children are refused until dataDir is set in the advisor plugin config\./, label)
    const status = await get().command.handler({ agent, rawInput: 'status' })
    assert.equal(status.kind, 'success', label)
    assert.ok(status.text.includes(`${DATA_DIR_NOT_CONFIGURED}\nReason: `), `${label}: ${status.text}`)
    assert.match(status.text, /Advisor data directory is not configured/, label)
    assert.match(status.text, problem, label)
    assert.doesNotMatch(status.text, /Recent advisor runs|Data directory:/, label)
    onReply((await get().command.handler({ agent, rawInput: 'on' })).text, problem, `${label}: /advisor on`)
    onReply((await get().command.handler({ agent, rawInput: '' })).text, problem, `${label}: toggle on`)
    assert.equal((await get().command.handler({ agent, rawInput: 'off' })).text, 'Advisor off. Advisor runs and verification stop; model preferences are retained.', `${label}: off needs no notice`)
    setState({ active: true, verifierModel: null, advisorModel: null, pending: null })
    assert.equal(get().section.text({ agent }), UNCONFIGURED_POLICY, label)
    assert.equal((await get().command.handler({ agent, rawInput: '' })).text, 'Advisor off. Advisor runs and verification stop; model preferences are retained.', `${label}: toggle off`)
  }
  assert.equal(UNCONFIGURED_POLICY, unavailablePolicy(DATA_DIR_NOT_CONFIGURED))
  assert.match(UNCONFIGURED_POLICY, /data directory is not configured/)
  assert.match(UNCONFIGURED_POLICY, /refuses every advisor-planner, advisor-consult, and advisor-verifier child/)
  assert.match(UNCONFIGURED_POLICY, /never run consult\.py or load the advisor skill/)
  assert.deepEqual(await readdir(home), ['decoy'], 'nothing is written, and an invalid dataDir never falls back to <home>/advisor')
})

test('fail closed: a dataDir that is not writable is reported at apply(), in status, the policy and the on reply, until it is fixed', async (t) => {
  const base = await tempDir(t, 'advisor-unwritable-')
  const dataDir = path.join(base, 'data')
  await writeFile(dataDir, 'a regular file, not a folder', { mode: 0o600 })
  const { ctx, get, setState, agent, warnings } = harness()
  await apply(ctx, { dataDir })
  const refusal = dataDirUnusable(`not writable: ${dataDir} is not a directory`)
  assert.equal(refusal, `Advisor data directory is not writable: ${dataDir} is not a directory. Fix it or set another dataDir in the advisor plugin config.`)
  assert.deepEqual(warnings, [`advisor: ${refusal} Advisor children are refused until then.`])
  let status = await get().command.handler({ agent, rawInput: 'status' })
  assert.ok(status.text.includes(`\nData directory: ${dataDir}\n${refusal} Advisor runs are refused until then.\nRecent advisor runs:\nNo consults recorded.`), status.text)
  assert.match(status.text, /not writable: .+ is not a directory/)
  const enabled = 'Advisor on. The in-process advisor and read-only verification are enabled.'
  assert.equal((await get().command.handler({ agent, rawInput: 'on' })).text, `${enabled}\n${refusal} Until then advisor runs and verification are refused.`)
  setState({ active: true, verifierModel: null, advisorModel: null, pending: null })
  assert.equal(get().section.text({ agent }), unavailablePolicy(refusal))

  // Fixed while the host runs: every check probes again.
  await rm(dataDir)
  await mkdir(dataDir, { mode: 0o700 })
  status = await get().command.handler({ agent, rawInput: 'status' })
  assert.ok(status.text.includes(`\nData directory: ${dataDir}\nRecent advisor runs:\nNo consults recorded.`), status.text)
  assert.ok(get().section.text({ agent }).includes(`the ledger \`${path.join(dataDir, 'sessions.jsonl')}\``))
  setState({ active: false, verifierModel: null, advisorModel: null, pending: null })
  assert.equal((await get().command.handler({ agent, rawInput: 'on' })).text, enabled)

  if (process.getuid?.() !== 0) {
    await chmod(dataDir, 0o500)
    status = await get().command.handler({ agent, rawInput: 'status' })
    assert.ok(status.text.includes(`Advisor data directory is not writable: ${dataDir} denies writes (EACCES).`), status.text)
    await chmod(dataDir, 0o700)
  }
  if (process.getuid) {
    await chmod(dataDir, 0o777)
    status = await get().command.handler({ agent, rawInput: 'status' })
    assert.ok(status.text.includes(`Advisor data directory is unsafe: ${dataDir} is writable by group or others (mode 0777).`), status.text)
    await chmod(dataDir, 0o700)
  }
})

test('fail closed: a dataDir that is unsafe when the plugin loads is reported unsafe, not "not configured", and recovers once fixed', { skip: !process.getuid && 'no POSIX owners on this platform' }, async (t) => {
  const base = await tempDir(t, 'advisor-unsafe-at-load-')
  const dataDir = path.join(base, 'data')
  await mkdir(dataDir, { mode: 0o700 })
  await chmod(dataDir, 0o775) // e.g. made by a umask-002 shell before the Host started
  const { ctx, get, setState, agent, warnings } = harness()
  await apply(ctx, { dataDir })
  const refusal = dataDirUnusable(`unsafe: ${dataDir} is writable by group or others (mode 0775)`)
  assert.deepEqual(warnings, [`advisor: ${refusal} Advisor children are refused until then.`])
  let status = await get().command.handler({ agent, rawInput: 'status' })
  assert.ok(status.text.includes(`\nData directory: ${dataDir}\n${refusal} Advisor runs are refused until then.\n`), status.text)
  assert.doesNotMatch(status.text, /not configured/)
  assert.equal((await get().command.handler({ agent, rawInput: 'on' })).text,
    `Advisor on. The in-process advisor and read-only verification are enabled.\n${refusal} Until then advisor runs and verification are refused.`)
  setState({ active: true, verifierModel: null, advisorModel: null, pending: null })
  assert.equal(get().section.text({ agent }), unavailablePolicy(refusal))

  await chmod(dataDir, 0o700) // fixed while the Host runs
  status = await get().command.handler({ agent, rawInput: 'status' })
  assert.ok(status.text.includes(`\nData directory: ${dataDir}\nRecent advisor runs:\nNo consults recorded.`), status.text)
  assert.ok(get().section.text({ agent }).includes(`the ledger \`${path.join(dataDir, 'sessions.jsonl')}\``))
})

test('fail closed: /dev/null as dataDir resolves but is reported not writable', async () => {
  const { ctx, get, agent, warnings } = harness()
  await apply(ctx, { dataDir: '/dev/null' })
  const refusal = dataDirUnusable('not writable: /dev/null is not a directory')
  assert.deepEqual(warnings, [`advisor: ${refusal} Advisor children are refused until then.`])
  const status = await get().command.handler({ agent, rawInput: 'status' })
  assert.ok(status.text.includes(`\nData directory: /dev/null\n${refusal} Advisor runs are refused until then.\n`), status.text)
})

test('verifier: a verifier that starts while the data directory is unusable is cancelled and denied every tool', () => {
  for (const [label, dataDirProblem, message] of [
    ['not configured', () => DATA_DIR_NOT_CONFIGURED, DATA_DIR_NOT_CONFIGURED],
    ['not writable', () => dataDirUnusable('not writable: /x is not a directory'), 'Advisor data directory is not writable'],
    ['throwing check', () => { throw new Error('probe exploded') }, 'Advisor verifier data directory check failed closed: probe exploded'],
  ]) {
    const warnings = []
    const boundary = boundaryHarness({ dataDirProblem })
    boundary.ctx.logger = { warn: (line) => warnings.push(line) }
    const child = boundary.agent('child', 'advisor-verifier-abcdef012345')
    boundary.listeners['subagent/start']({ id: 'child', local: true, provider: 'spawn' })
    assert.equal(child.value.cancelled, true, `${label}: stopped`)
    assert.equal(child.sections.length, 0, `${label}: no verifier policy`)
    for (const name of VERIFIER_TOOLS) {
      const exec = { name, agent: child.value, arguments: {} }
      assert.match(child.guards[0](exec), /failed closed/, `${label}: child guard denies ${name}`)
      assert.match(boundary.globalGuards[0](exec), /failed closed/, `${label}: host guard denies ${name}`)
    }
    assert.ok(warnings.some((line) => line.startsWith('advisor: stopping advisor-verifier-abcdef012345: ') && line.includes(message)), `${label}: ${warnings.join('|')}`)
  }
  const ready = boundaryHarness({ dataDirProblem: () => undefined })
  const child = ready.agent('child', 'advisor-verifier-abcdef012345')
  ready.listeners['subagent/start']({ id: 'child', local: true, provider: 'spawn' })
  assert.equal(child.value.cancelled, false, 'a usable folder leaves the verifier running')
  assert.equal(child.guards[0]({ name: 'read', agent: child.value, arguments: {} }), undefined)
})

test('verifier: reserved advisor-verifier delegations are refused while the ledger is not ready and allowed once it is', () => {
  let problem = DATA_DIR_NOT_CONFIGURED
  const boundary = boundaryHarness({ dataDirProblem: () => problem })
  const guard = boundary.globalGuards[0]
  const exec = (name, args) => ({ name, arguments: args, agent: undefined })
  const valid = { name: 'advisor-verifier-abcdef012345' }
  for (const args of [valid, { name: 'advisor-verifier' }, { name: 'advisor-verifier-typo' }, { ...valid, model: 'other' }, { ...valid, reasoning_effort: 'high' }]) {
    for (const tool of ['subagent', 'subagent_fork', 'subagent_codex']) {
      assert.equal(guard(exec(tool, args)), DATA_DIR_NOT_CONFIGURED, `${tool} ${JSON.stringify(args)}`)
    }
  }
  for (const [tool, args] of [['subagent', { name: 'reviewer' }], ['read', { file_path: 'x' }], ['subagent', { name: 'advisor-planner-abcdef012345' }]]) {
    assert.equal(guard(exec(tool, args)), undefined, `${tool} ${JSON.stringify(args)} is not a reserved verifier delegation`)
  }
  problem = dataDirUnusable('not writable: /x is not a directory')
  assert.equal(guard(exec('subagent', valid)), problem)
  problem = undefined
  assert.equal(guard(exec('subagent', valid)), undefined, 'allowed once the ledger is ready')
  assert.match(guard(exec('subagent_fork', valid)), /fresh in-process subagent/, 'the other reserved-verifier checks still apply')
  assert.match(guard(exec('subagent', { name: 'advisor-verifier-typo' })), /12-character/)

  const denial = (dataDirProblem) => verifierDelegationDenial({ name: 'subagent', arguments: valid }, () => true, () => null, dataDirProblem)
  assert.equal(denial(() => DATA_DIR_NOT_CONFIGURED), DATA_DIR_NOT_CONFIGURED)
  assert.equal(denial(() => undefined), undefined)
  assert.equal(verifierDelegationDenial({ name: 'subagent', arguments: valid }), undefined, 'the fourth parameter is optional')

  const throwing = boundaryHarness({ dataDirProblem: () => { throw new Error('probe failed') } })
  assert.equal(throwing.globalGuards[0](exec('subagent', valid)), 'Advisor verifier guard failed closed: probe failed')
  assert.equal(throwing.globalGuards[0](exec('subagent', { name: 'reviewer' })), undefined, 'the probe runs for reserved names only')
})

test('commands validate verifier models, reject legacy toggles, and gate overlaps', async () => {
  const { ctx, get, setState, setRoutes, agent } = harness()
  await apply(ctx)
  const command = get().command
  assert.match((await command.handler({ agent, rawInput: 'verifier on' })).text, /separate verifier switch was removed/)
  assert.equal((await command.handler({ agent, rawInput: 'on' })).kind, 'success')
  setState({ ...get().state, active: true })
  assert.equal((await command.handler({ agent, rawInput: 'verifier-model openrouter/~deepseek/deepseek-flash-latest' })).kind, 'success')
  setState({ ...get().state, verifierModel: selected })
  assert.match((await command.handler({ agent, rawInput: 'status' })).text, /openrouter\/~deepseek\/deepseek-flash-latest/)
  assert.equal((await command.handler({ agent, rawInput: 'verifier-model openrouter/typesafe/jev-1.13' })).kind, 'error')
  setRoutes(null)
  assert.equal((await command.handler({ agent, rawInput: 'verifier-model anthropic/claude-haiku-5-5' })).kind, 'error')
  assert.equal((await command.handler({ agent, rawInput: 'verifier-model inherit' })).kind, 'success')
  assert.match((await command.handler({ agent, rawInput: 'off' })).text, /preferences are retained/)
  get().state.pending = { target: 'advisor', active: true, commandId: 'old', startedAt: Date.now() }
  assert.match((await command.handler({ agent, rawInput: 'status' })).text, /updating/)
  const result = await command.handler({ agent, rawInput: 'off', commandId: 'new' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /already updating/)
})

test('advisor model command validates routes and replaces the planner command', async () => {
  const { ctx, get, setRoutes, agent } = harness()
  await apply(ctx)
  const command = get().command
  assert.match((await command.handler({ agent, rawInput: 'model' })).text, /Advisor model: Inherit/)
  assert.equal((await command.handler({ agent, rawInput: 'model openrouter/~deepseek/deepseek-flash-latest' })).kind, 'success')
  assert.equal((await command.handler({ agent, rawInput: 'model anthropic/claude-fable-5-2' })).kind, 'error')
  assert.equal((await command.handler({ agent, rawInput: 'model inherit' })).kind, 'success')
  assert.equal((await command.handler({ agent, rawInput: 'model broken' })).kind, 'error')
  const legacy = await command.handler({ agent, rawInput: 'planner inherit' })
  assert.equal(legacy.kind, 'error')
  assert.match(legacy.text, /now the Advisor model/)
  setRoutes(null)
  assert.equal((await command.handler({ agent, rawInput: 'model anthropic/claude-haiku-5-5' })).kind, 'error')
  assert.match((await command.handler({ agent, rawInput: 'status' })).text, /Advisor model: Inherit\. Verifier model: Inherit/)
})
