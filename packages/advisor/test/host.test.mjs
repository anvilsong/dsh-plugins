import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { chmod, mkdtemp, mkdir, readdir, writeFile, rm } from 'node:fs/promises'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, POLICY, UNCONFIGURED_POLICY, unavailablePolicy } from '../src/index.host.js'
import { createLedger } from '../src/ledger.js'
import {
  ADVISOR_WORKFLOW,
  advisorModelPolicy,
  advisorNamespaceDenial,
  advisorWorkflow,
  CONSULT_POLICY,
  DATA_DIR_NOT_CONFIGURED,
  dataDirUnusable,
  PLANNER_POLICY,
} from '../src/planner.js'
import { parseModelSetting, routeLabel } from '../src/state.js'
import {
  EVIDENCE_TOOL,
  installVerifierBoundary,
  REPORT_TOOL,
  VERIFIER_TOOLS,
  VERIFIER_WORKFLOW,
  verifierDelegationDenial,
  VERIFIER_POLICY,
  verifierModelPolicy,
} from '../src/verifier.js'

const selected = { provider: 'openrouter', model: '~deepseek/deepseek-flash-latest' }

// `profile`: what ctx.get('profileContext') returns; `llm`: what
// ctx.get('llm') returns, or a function called on each read (so a read can
// throw). Without either there is no ctx.get at all. `gets` lists every read.
function harness({ profile, llm } = {}) {
  const definitions = {}
  const warnings = []
  const gets = []
  let section
  let command
  let state = { active: false, verifierModel: null, pending: null }
  let routes = [selected, { provider: 'anthropic', model: 'claude-haiku-5-5' }]
  const get = (name) => {
    gets.push(name)
    if (name === 'llm') return typeof llm === 'function' ? llm() : llm
    return name === 'profileContext' ? profile : undefined
  }
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
    ...(profile === undefined && llm === undefined ? {} : { get }),
  }
  return {
    ctx,
    agent: { session: {} },
    warnings,
    gets,
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

// The verifier's workspace root for boundary harnesses: read, glob and grep
// stay inside it. The ledger is never written by these tests.
const BOUNDARY_TMP = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'advisor-host-boundary-')))
after(() => rmSync(BOUNDARY_TMP, { recursive: true, force: true }))
const BOUNDARY_WS = path.join(BOUNDARY_TMP, 'ws')
mkdirSync(path.join(BOUNDARY_WS, 'src'), { recursive: true })
// Arguments each allowed verifier tool accepts in that workspace.
const VERIFIER_ARGS = {
  glob: { pattern: '**/*.js' },
  grep: { pattern: 'x' },
  read: { file_path: 'src/a.js' },
  team_task_get: { id: 'task-1' },
  [EVIDENCE_TOOL]: {},
  [REPORT_TOOL]: { entries: [{ ref: '1', status: 'confirmed', reply_line: 1, evidence: ['src/a.js:1'] }] },
}

function boundaryHarness({ dataDirProblem } = {}) {
  const listeners = {}
  const globalGuards = []
  const agents = new Map()
  // The evidence and report tools are registered on each verifier by the boundary itself.
  const definitions = Object.fromEntries(
    [...VERIFIER_TOOLS.filter((name) => name !== EVIDENCE_TOOL && name !== REPORT_TOOL), 'bash', 'write', 'run_code', 'team_task_update'].map((name) => [name, { name }]),
  )
  const globalNames = new Set(['team_task_get', 'bash', 'write', 'run_code', 'team_task_update'])
  const tools = {
    get(name, agent) {
      if (agent?.shadows?.has(name)) return agent.shadows.get(name)
      if (agent?.registered?.has(name)) return agent.registered.get(name)
      if (agent === undefined && !globalNames.has(name)) return undefined
      return definitions[name]
    },
    guard(guard) { globalGuards.push(guard); return () => {} },
  }
  const lead = { id: 'lead', names: { self: 'lead', parent: undefined } }
  const ctx = {
    agents: { get: (id) => agents.get(id) },
    subagents: { namesOf: (agent) => agent.names, rootOf: () => lead },
    tools,
    on(name, listener) { listeners[name] = listener; return () => {} },
    logger: { warn() {} },
  }
  const dispose = installVerifierBoundary(ctx, undefined, undefined, dataDirProblem, {
    workspaceOf: () => BOUNDARY_WS,
    ledger: createLedger(path.join(BOUNDARY_TMP, 'data')),
  })
  const sequence = []
  function agent(id, self, parent = 'lead') {
    const guards = []
    const restrictions = []
    const sections = []
    const value = {
      id,
      names: { self, parent },
      shadows: new Map(),
      registered: new Map(),
      cancelled: false,
      cancel() { this.cancelled = true },
      ctx: {
        tools: {
          get: tools.get,
          guard(guard) { guards.push(guard); sequence.push('guard'); return () => {} },
          register(definition) {
            value.registered.set(definition.name, definition)
            sequence.push(`register:${definition.name}`)
            return () => { value.registered.delete(definition.name) }
          },
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
  assert.equal(definition.stateVersion, 7, 'routes with an effort: cached state is rebuilt from the session log')
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
  assert.match(POLICY, /in-process, read-only child agent on the Advisor model\.\n/)
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
  assert.deepEqual(boundary.sequence, ['guard', `register:${EVIDENCE_TOOL}`, `register:${REPORT_TOOL}`, 'register:grep', 'section', 'initial-prompt'])
  assert.deepEqual(child.restrictions, [])
  assert.equal(child.guards.length, 1)
  assert.equal(child.value.cancelled, false)

  assert.deepEqual(VERIFIER_TOOLS, ['glob', 'grep', 'read', 'team_task_get', EVIDENCE_TOOL, REPORT_TOOL])
  assert.equal(REPORT_TOOL, 'advisor_verifier_report')
  for (const name of VERIFIER_TOOLS) {
    const exec = { name, agent: child.value, arguments: VERIFIER_ARGS[name] }
    assert.equal(boundary.globalGuards[0](exec), undefined)
    assert.equal(child.guards[0](exec), undefined)
  }
  assert.match(child.guards[0]({ name: 'read', agent: child.value, arguments: { file_path: '/etc/hosts' } }), /inside the workspace/)
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

test('status: verification lines are not runs: Recent advisor runs skips them; the projection stays at version 7', async (t) => {
  const dir = await tempDir(t, 'advisor-verification-status-')
  const verification = (verifies, extra) => JSON.stringify({ kind: 'verification', schema: 'advisor-verification/1', verifies, verified_kind: 'advice', ts: 1, ...extra })
  await writeFile(path.join(dir, 'sessions.jsonl'), [
    JSON.stringify({ consult_id: 'abcdef012345', kind: 'advice', advisor: 'dsh', status: 'ok', topic: 'review' }),
    verification('abcdef012345', { status: 'recorded', expected: 3, covered: 3 }),
    verification('abcdef012345', { status: 'unrecorded', reason: 'already_recorded' }),
    '',
  ].join('\n'), { mode: 0o600 })
  await chmod(path.join(dir, 'sessions.jsonl'), 0o600)
  const { ctx, get, agent } = harness()
  await apply(ctx, { dataDir: dir })
  assert.equal(get().definition.stateVersion, 7)
  const result = await get().command.handler({ agent, rawInput: 'status' })
  assert.ok(result.text.endsWith(`\nData directory: ${dir}\nRecent advisor runs:\nabcdef012345 dsh advice ok review`), result.text)
  const runs = result.text.slice(result.text.indexOf('Recent advisor runs:'))
  assert.doesNotMatch(runs, /verification|recorded|unknown/)
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
  assert.ok(text.includes('Runs recorded before this folder existed are not verified from here.'))
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
  assert.match(UNCONFIGURED_POLICY, /Do not start them; continue as yourself\./)
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
  assert.equal(child.guards[0]({ name: 'read', agent: child.value, arguments: VERIFIER_ARGS.read }), undefined)
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

test('a stale pending marker neither reports updating nor blocks a new command', async () => {
  const { ctx, get, agent } = harness()
  await apply(ctx)
  const command = get().command
  get().state.pending = { target: 'advisor', active: true, commandId: 'old', startedAt: Date.now() - 6 * 60_000 }
  const status = await command.handler({ agent, rawInput: 'status' })
  assert.doesNotMatch(status.text, /updating/)
  assert.match(status.text, /Advisor model: Inherit/)
  const result = await command.handler({ agent, rawInput: 'off', commandId: 'new' })
  assert.equal(result.kind, 'success')
  assert.doesNotMatch(result.text, /already updating/)
  get().state.pending = { target: 'advisor', active: true, commandId: 'old', startedAt: Date.now() - 60_000 }
  assert.match((await command.handler({ agent, rawInput: 'status' })).text, /updating/)
  assert.match((await command.handler({ agent, rawInput: 'off', commandId: 'new' })).text, /already updating/)
})

// ---------------------------------------------------------------------------
// Effort: `/advisor model|verifier-model <provider>/<model> [effort=<id>]`

const SELECTED = `${selected.provider}/${selected.model}`
const HAIKU = Object.freeze({ provider: 'anthropic', model: 'claude-haiku-5-5' })
const SPACED = Object.freeze({ provider: 'p', model: 'my model' })
// What each route advertises; the fake llm accepts only these ids, exactly, as the spawn preflight does.
const ADVERTISED = Object.freeze({
  [SELECTED]: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High', description: 'Deeper reasoning' }],
  'anthropic/claude-haiku-5-5': [],
  'p/my model': [{ id: 'HiGh', name: 'Mixed case' }],
})
const unsupportedEffort = (effort) => Object.assign(new Error(`reasoning effort ${effort} is not supported`), { name: 'LlmError', code: 'UNSUPPORTED_REASONING_EFFORT' })
const turn = () => new Promise((resolve) => setImmediate(resolve))

/**
 * A fake llm service. resolveCallConfig accepts only an advertised effort id;
 * `callConfig` and `modelInfo` replace a method's behaviour. `calls` records
 * every call with its arguments and signal.
 */
function fakeLlm({ callConfig, modelInfo } = {}) {
  const calls = []
  return {
    calls,
    async resolveCallConfig(config, signal) {
      calls.push({ method: 'resolveCallConfig', config, signal })
      if (callConfig !== undefined) return callConfig(config, signal)
      const efforts = ADVERTISED[`${config.provider}/${config.model}`] ?? []
      if (!efforts.some((effort) => effort.id === config.reasoningEffort)) throw unsupportedEffort(config.reasoningEffort)
      return { ...config }
    },
    async resolveModelInfo(provider, model, signal) {
      calls.push({ method: 'resolveModelInfo', provider, model, signal })
      if (modelInfo !== undefined) return modelInfo(provider, model, signal)
      const efforts = ADVERTISED[`${provider}/${model}`] ?? []
      return efforts.length === 0 ? {} : { reasoning: { efforts, defaultEffort: efforts[0].id } }
    },
  }
}

/**
 * Run /advisor commands the way the Host does, with the registered
 * projection's own fold: command/run is folded before the handler starts, and
 * command/done with its result after it returns. A slow handler therefore
 * keeps its pending marker until it returns.
 */
async function commandDriver(options, config) {
  const h = harness(options)
  await apply(h.ctx, config)
  const { definition, command } = h.get()
  h.setState(definition.init())
  h.setRoutes([selected, HAIKU, SPACED])
  let counter = 0
  const fold = (event) => h.setState(definition.apply(h.get().state, event))
  const send = async (rawInput) => {
    const commandId = `command-${++counter}`
    fold({ type: 'command/run', time: Date.now(), data: { name: 'advisor', args: rawInput, commandId } })
    const result = await command.handler({ agent: h.agent, rawInput, commandId })
    fold({ type: 'command/done', time: Date.now(), data: { commandId, kind: result.kind, text: result.text } })
    return result
  }
  return { ...h, definition, command, send, state: () => h.get().state }
}

test('schemas: saved routes keep their effort through the state, pending and view schemas; the routes list keeps provider and model only', async () => {
  const { ctx, get } = harness()
  await apply(ctx)
  const { definition, modelRoutesDefinition } = get()
  const advisorModel = { ...selected, effort: 'high' }
  const verifierModel = { ...HAIKU, effort: 'low' }
  const state = {
    active: true,
    verifierModel,
    advisorModel,
    pending: { target: 'verifierModel', route: verifierModel, commandId: 'c', startedAt: 1 },
    lastRun: { commandId: 'c', target: 'verifierModel' },
    failure: null,
  }
  assert.deepEqual(definition.stateSchema.parse(state), state)
  assert.deepEqual(definition.wire.viewSchema.parse(definition.wire.view(state)), {
    active: true, verifierModel, advisorModel, pending: true, pendingTarget: 'verifierModel', pendingSince: 1, failure: null,
  })
  const withoutEffort = { ...state, advisorModel: selected, verifierModel: null, pending: { target: 'advisorModel', route: selected, commandId: 'c', startedAt: 1 } }
  assert.deepEqual(definition.stateSchema.parse(withoutEffort), withoutEffort, 'a route without an effort (the version 6 shape) still parses')
  assert.equal(Object.hasOwn(definition.stateSchema.parse(withoutEffort).advisorModel, 'effort'), false, 'and gains no effort key')
  for (const bad of [{ ...selected, effort: '' }, { ...selected, effort: 7 }, { ...selected, effort: null }]) {
    assert.equal(definition.stateSchema.safeParse({ ...state, advisorModel: bad }).success, false, JSON.stringify(bad))
    assert.equal(definition.stateSchema.safeParse({ ...state, pending: { ...state.pending, route: bad } }).success, false, JSON.stringify(bad))
    assert.equal(definition.wire.viewSchema.safeParse({ ...definition.wire.view(state), verifierModel: bad }).success, false, JSON.stringify(bad))
  }
  // The authorized-routes projection is unchanged: provider and model only.
  assert.notEqual(modelRoutesDefinition.stateSchema, definition.stateSchema)
  assert.deepEqual(modelRoutesDefinition.stateSchema.parse([advisorModel, verifierModel]), [selected, HAIKU])
  assert.deepEqual(modelRoutesDefinition.wire.viewSchema.parse([advisorModel]), [selected])
  const policy = { type: 'subagent/model-selection-policy', data: { allowedModels: [{ ...selected, effort: 'high', reasoningEfforts: ['low', 'high'] }] } }
  assert.deepEqual(modelRoutesDefinition.apply(null, policy), [selected])
})

test('effort: a supported effort is checked once against the exact route with an AbortSignal and stored as typed; reads and status show it', async () => {
  const llm = fakeLlm()
  const pendingDuringCheck = []
  const check = llm.resolveCallConfig
  llm.resolveCallConfig = (config, signal) => {
    pendingDuringCheck.push(d.definition.stateSchema.parse(d.state()).pending)
    return check(config, signal)
  }
  const d = await commandDriver({ llm })
  const result = await d.send(`model ${SELECTED} effort=high`)
  assert.deepEqual(result, { kind: 'success', text: `Advisor model set to ${SELECTED} effort=high for this session. It is used when Advisor is on.` })
  assert.deepEqual(d.state().advisorModel, { ...selected, effort: 'high' })
  assert.equal(llm.calls.length, 1, 'one check, no list read for an accepted effort')
  const [{ config, signal }] = llm.calls
  assert.deepEqual(config, { provider: selected.provider, model: selected.model, reasoningEffort: 'high' })
  assert.ok(signal instanceof AbortSignal)
  assert.equal(signal.aborted, false, 'the timer was cleared, not fired')
  assert.equal(pendingDuringCheck.length, 1)
  assert.deepEqual(pendingDuringCheck[0].route, { ...selected, effort: 'high' }, 'the pending marker keeps the effort through the state schema')

  assert.equal((await d.send(`verifier-model ${SELECTED} effort=low`)).kind, 'success')
  assert.deepEqual(d.state().verifierModel, { ...selected, effort: 'low' })
  assert.equal((await d.send('model')).text, `Advisor model: ${SELECTED} effort=high for this session.`)
  assert.equal((await d.send('verifier-model')).text, `Verifier model: ${SELECTED} effort=low for this session.`)
  const status = await d.send('status')
  assert.ok(status.text.includes(`Advisor model: ${SELECTED} effort=high. Verifier model: ${SELECTED} effort=low. Both apply when Advisor is on.\n`), status.text)
  assert.doesNotMatch(status.text, /no longer offered/)

  // Back to the model's own default effort: no check, and no effort key.
  llm.calls.length = 0
  assert.equal((await d.send(`model ${SELECTED}`)).text, `Advisor model set to ${SELECTED} for this session. It is used when Advisor is on.`)
  assert.deepEqual(d.state().advisorModel, selected)
  assert.equal(Object.hasOwn(d.state().advisorModel, 'effort'), false)
  assert.equal(llm.calls.length, 0)
})

test('effort: for every accepted setting the fold stores exactly the route the handler validated, also after the schemas', async () => {
  const llm = fakeLlm()
  const d = await commandDriver({ llm })
  const cases = [
    [`model ${SELECTED}`, 'advisorModel'],
    [`model ${SELECTED} effort=high`, 'advisorModel'],
    [`  MODEL   ${SELECTED}\teffort=low  `, 'advisorModel'],
    ['model p/my model', 'advisorModel'],
    ['model p/my model effort=HiGh', 'advisorModel'],
    ['model INHERIT', 'advisorModel'],
    [`verifier-model ${SELECTED} effort=high`, 'verifierModel'],
    ['verifier-model p/my model effort=HiGh', 'verifierModel'],
    ['verifier-model anthropic/claude-haiku-5-5', 'verifierModel'],
    ['verifier-model inherit', 'verifierModel'],
  ]
  for (const [input, field] of cases) {
    llm.calls.length = 0
    const result = await d.send(input)
    assert.equal(result.kind, 'success', `${input}: ${result.text}`)
    const label = /set to (.*) for this session\./.exec(result.text)[1]
    const validated = label === 'Inherit' ? null : parseModelSetting(label)
    assert.deepEqual(d.state()[field], validated, input)
    const checked = llm.calls.filter((call) => call.method === 'resolveCallConfig')
    if (validated?.effort === undefined) {
      assert.deepEqual(checked, [], `${input}: no check without an effort`)
    } else {
      assert.equal(checked.length, 1, input)
      const { provider, model, reasoningEffort } = checked[0].config
      assert.deepEqual({ provider, model, effort: reasoningEffort }, d.state()[field], `${input}: the fold stored the checked route`)
    }
    assert.deepEqual(d.definition.stateSchema.parse(d.state())[field], validated, `${input}: state schema`)
    assert.deepEqual(d.definition.wire.viewSchema.parse(d.definition.wire.view(d.state()))[field], validated, `${input}: view schema`)
    assert.equal(routeLabel(validated), label)
  }
})

test('effort: an effort the model does not advertise is refused with the advertised ids; nothing is stored and the next command works', async () => {
  const llm = fakeLlm()
  const d = await commandDriver({ llm })
  for (const effort of ['HIGH', 'High', 'medium', 'xhigh']) {
    llm.calls.length = 0
    const result = await d.send(`model ${SELECTED} effort=${effort}`)
    assert.deepEqual(result, {
      kind: 'error',
      text: `Advisor model effort ${effort} is not offered by ${SELECTED}; nothing was changed. Advertised efforts: low (Low), high (High).`,
    }, effort)
    assert.equal(d.state().advisorModel, null, `${effort}: nothing stored`)
    assert.equal(d.state().pending, null, `${effort}: no pending marker left`)
    assert.deepEqual(d.state().failure, { count: d.state().failure.count, text: result.text, target: 'advisorModel' })
    assert.deepEqual(llm.calls.map((call) => call.method), ['resolveCallConfig', 'resolveModelInfo'])
    assert.equal(llm.calls[1].signal, llm.calls[0].signal, 'the list is read under the same deadline')
  }
  const none = await d.send('verifier-model anthropic/claude-haiku-5-5 effort=low')
  assert.equal(none.text, 'Verifier model effort low is not offered by anthropic/claude-haiku-5-5; nothing was changed. anthropic/claude-haiku-5-5 advertises no reasoning efforts.')
  assert.equal(d.state().verifierModel, null)
  assert.equal((await d.send(`model ${SELECTED} effort=high`)).kind, 'success', 'the next command works at once')
  assert.deepEqual(d.state().advisorModel, { ...selected, effort: 'high' })

  for (const modelInfo of [() => { throw new Error('catalog offline') }, () => ({ reasoning: { efforts: 'low' } })]) {
    const unlisted = await commandDriver({ llm: fakeLlm({ modelInfo }) })
    const refused = await unlisted.send(`model ${SELECTED} effort=max`)
    assert.deepEqual(refused, {
      kind: 'error',
      text: `Advisor model effort max is not offered by ${SELECTED}; nothing was changed. The list of advertised efforts is unavailable.`,
    })
    assert.equal(unlisted.state().advisorModel, null)
    assert.equal((await unlisted.send('on')).kind, 'success')
    assert.equal(unlisted.state().active, true)
  }
})

test('effort: without the llm service, when reading it throws, or when the check fails otherwise, it could not be checked and nothing is stored', async () => {
  const offline = fakeLlm({ callConfig: () => { throw Object.assign(new Error('no credentials for openrouter'), { code: 'AUTH_REQUIRED' }) } })
  const cases = [
    ['no ctx.get', {}, 'the llm service is unavailable'],
    ['no llm service', { profile: {} }, 'the llm service is unavailable'],
    ['ctx.get throws', { llm: () => { throw new Error('service llm is not registered') } }, 'the llm service is unavailable'],
    ['no resolveCallConfig', { llm: {} }, 'the llm service is unavailable'],
    ['another failure', { llm: offline }, 'no credentials for openrouter'],
    ['a synchronous throw', { llm: { resolveCallConfig() { throw new Error('boom') } } }, 'boom'],
    ['a non-Error rejection', { llm: { resolveCallConfig: () => Promise.reject('down') } }, 'down'],
  ]
  for (const [label, options, reason] of cases) {
    const d = await commandDriver(options)
    for (const [input, noun, field] of [[`model ${SELECTED} effort=high`, 'Advisor model', 'advisorModel'], [`verifier-model ${SELECTED} effort=low`, 'Verifier model', 'verifierModel']]) {
      const effort = input.slice(input.indexOf('effort=') + 'effort='.length)
      const result = await d.send(input)
      assert.deepEqual(result, { kind: 'error', text: `${noun} effort ${effort} for ${SELECTED} could not be checked: ${reason}; nothing was changed.` }, label)
      assert.equal(d.state()[field], null, `${label}: nothing stored`)
      assert.equal(d.state().pending, null, `${label}: no pending marker left`)
    }
    assert.equal((await d.send(`model ${SELECTED}`)).kind, 'success', `${label}: later commands work`)
    assert.deepEqual(d.state().advisorModel, selected, label)
    assert.equal((await d.send('on')).kind, 'success', label)
  }
  assert.equal(offline.calls.some((call) => call.method === 'resolveModelInfo'), false, 'another failure is not reported as an unsupported effort')
})

test('effort: a check that does not settle is cut off after 10 s; meanwhile other commands are refused, afterwards they work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const llm = fakeLlm({ callConfig: () => new Promise(() => {}) })
  const d = await commandDriver({ llm })
  const slow = d.send(`model ${SELECTED} effort=high`)
  let settled = false
  slow.then(() => { settled = true })
  await turn()
  assert.equal(d.state().pending.target, 'advisorModel', 'the marker is pending while the check runs')
  assert.deepEqual(await d.send('off'), { kind: 'error', text: 'Advisor is already updating. Try again after it finishes.' })
  assert.match((await d.send('model inherit')).text, /already updating/)
  assert.equal((await d.send('status')).text, 'Advisor is updating (advisorModel) for this session.')
  t.mock.timers.tick(9_999)
  await turn()
  assert.equal(settled, false, 'still checking before 10 s')
  assert.equal(llm.calls[0].signal.aborted, false)
  t.mock.timers.tick(1)
  assert.deepEqual(await slow, {
    kind: 'error',
    text: `Advisor model effort high for ${SELECTED} could not be checked: the check timed out after 10 s; nothing was changed.`,
  })
  assert.equal(llm.calls[0].signal.aborted, true, 'the check is asked to stop')
  assert.equal(d.state().pending, null, 'the pending marker no longer blocks')
  assert.equal(d.state().advisorModel, null, 'nothing stored')
  assert.equal((await d.send('on')).kind, 'success', 'the next command works at once')
  assert.equal(d.state().active, true)
  assert.equal((await d.send(`model ${SELECTED}`)).kind, 'success')
  assert.deepEqual(d.state().advisorModel, selected)
})

test('effort: when the advertised list does not arrive within the same 10 s, the refusal says the list is unavailable', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const llm = fakeLlm({ modelInfo: () => new Promise(() => {}) })
  const d = await commandDriver({ llm })
  const refused = d.send(`model ${SELECTED} effort=max`)
  await turn()
  assert.deepEqual(llm.calls.map((call) => call.method), ['resolveCallConfig', 'resolveModelInfo'])
  t.mock.timers.tick(10_000)
  assert.deepEqual(await refused, {
    kind: 'error',
    text: `Advisor model effort max is not offered by ${SELECTED}; nothing was changed. The list of advertised efforts is unavailable.`,
  })
  assert.equal(llm.calls[1].signal, llm.calls[0].signal, 'one deadline for both calls')
  assert.equal(llm.calls[1].signal.aborted, true)
  assert.equal(d.state().pending, null)
  assert.equal((await d.send('off')).kind, 'success')
})

test('effort: the llm service is never read without effort=, for Inherit, a usage error, or an unauthorized route; usage names the grammar', async () => {
  const llm = fakeLlm()
  const d = await commandDriver({ llm })
  const inputs = [
    'on', `model ${SELECTED}`, 'model inherit', 'verifier-model anthropic/claude-haiku-5-5', 'verifier-model inherit', 'model',
    'verifier-model', 'status', 'model inherit effort=high', 'verifier-model Inherit effort=low', `model ${SELECTED} effort=`,
    'model effort=high', 'model anthropic/claude-fable-5-2 effort=high', 'verifier-model anthropic/claude-fable-5-2 effort=low', 'off',
  ]
  for (const input of inputs) await d.send(input)
  assert.deepEqual(llm.calls, [])
  assert.deepEqual(d.gets.filter((name) => name === 'llm'), [], 'not even read')

  // The Inherit note only when an effort token came with Inherit.
  for (const input of ['model inherit effort=high', 'model INHERIT  effort=', 'verifier-model Inherit effort=low']) {
    const prefix = input.startsWith('model') ? 'model' : 'verifier-model'
    assert.deepEqual(await d.send(input), { kind: 'error', text: `Usage: /advisor ${prefix} inherit|<provider>/<model> [effort=<id>]; Inherit takes no effort.` }, input)
  }
  for (const input of [`verifier-model ${SELECTED} effort=`, 'model effort=high', 'model broken', 'model /x effort=high', 'verifier-model inherit effort=x effort=y']) {
    const prefix = input.startsWith('model') ? 'model' : 'verifier-model'
    assert.deepEqual(await d.send(input), { kind: 'error', text: `Usage: /advisor ${prefix} inherit|<provider>/<model> [effort=<id>]` }, input)
  }
  assert.deepEqual(await d.send('model anthropic/claude-fable-5-2 effort=high'), {
    kind: 'error',
    text: 'Advisor model route anthropic/claude-fable-5-2 is not authorized for this session. Choose an available subagent model or Inherit.',
  })
  assert.deepEqual(await d.send('frobnicate'), {
    kind: 'error',
    text: 'Usage: /advisor [on|off|status|model inherit|model <provider>/<model> [effort=<id>]|verifier-model inherit|verifier-model <provider>/<model> [effort=<id>]]',
  })
  assert.equal(d.command.input.hint, '[on|off|status|model inherit|provider/model [effort=id]|verifier-model inherit|provider/model [effort=id]]')
  assert.equal(d.state().advisorModel, null)
  assert.equal(d.state().verifierModel, null)
})

test('status: a stored effort the model no longer advertises gets a best-effort note with the reset; it is never cleared', async () => {
  const llm = fakeLlm()
  const d = await commandDriver({ llm })
  d.setState({ ...d.state(), advisorModel: { ...selected, effort: 'high' }, verifierModel: { ...HAIKU, effort: 'max' } })
  let status = await d.send('status')
  assert.equal(status.kind, 'success')
  assert.ok(status.text.includes(`Advisor model: ${SELECTED} effort=high. Verifier model: anthropic/claude-haiku-5-5 effort=max. Both apply when Advisor is on.\n`
    + 'Verifier model effort max is no longer offered by anthropic/claude-haiku-5-5; spawns on it fail until you reset it with /advisor verifier-model anthropic/claude-haiku-5-5. anthropic/claude-haiku-5-5 advertises no reasoning efforts.\n'), status.text)
  assert.doesNotMatch(status.text, /Advisor model effort high/, 'an offered effort gets no note')
  assert.deepEqual(d.state().verifierModel, { ...HAIKU, effort: 'max' }, 'the stale effort is kept')

  d.setState({ ...d.state(), advisorModel: { ...selected, effort: 'xhigh' }, verifierModel: null })
  status = await d.send('status')
  assert.ok(status.text.includes(`\nAdvisor model effort xhigh is no longer offered by ${SELECTED}; spawns on it fail until you reset it with /advisor model ${SELECTED}. Advertised efforts: low (Low), high (High).\n`), status.text)

  // Skipped silently when the llm is unavailable or the check fails for another reason.
  const quiet = [{}, { profile: {} }, { llm: () => { throw new Error('gone') } }, { llm: fakeLlm({ callConfig: () => { throw new Error('offline') } }) }]
  for (const options of quiet) {
    const q = await commandDriver(options)
    q.setState({ ...q.state(), verifierModel: { ...HAIKU, effort: 'max' } })
    const text = (await q.send('status')).text
    assert.match(text, /Verifier model: anthropic\/claude-haiku-5-5 effort=max\. Both apply when Advisor is on\.\n/)
    assert.doesNotMatch(text, /no longer offered/)
  }
})

test('status: the drift check of both models shares one 10 s timer and then reports without a note', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const llm = fakeLlm({ callConfig: () => new Promise(() => {}) })
  const d = await commandDriver({ llm })
  d.setState({ ...d.state(), advisorModel: { ...selected, effort: 'high' }, verifierModel: { ...HAIKU, effort: 'max' } })
  const status = d.send('status')
  await turn()
  assert.equal(llm.calls.length, 2)
  assert.equal(llm.calls[0].signal, llm.calls[1].signal, 'one timer for both checks')
  t.mock.timers.tick(10_000)
  const { kind, text } = await status
  assert.equal(kind, 'success')
  assert.match(text, /Advisor model: openrouter\/~deepseek\/deepseek-flash-latest effort=high\. Verifier model: anthropic\/claude-haiku-5-5 effort=max\./)
  assert.doesNotMatch(text, /no longer offered/)
  assert.equal(llm.calls[0].signal.aborted, true)
})

/** A revoked Proxy: every property read on it throws. */
function revoked() {
  const { proxy, revoke } = Proxy.revocable({}, {})
  revoke()
  return proxy
}
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test('effort: unreadable failures and hostile llm objects still give "could not be checked", store nothing, and leave status answering', async () => {
  const unreadableMessage = Object.defineProperty(new Error('x'), 'message', { get() { throw new Error('no message') } })
  const unreadableCode = Object.defineProperty(new Error('code unreadable'), 'code', { get() { throw new Error('no code') } })
  const cases = [
    ['an Object.create(null) rejection', { resolveCallConfig: () => Promise.reject(Object.create(null)) }, 'an unreadable error'],
    ['an Error whose message getter throws', { resolveCallConfig: () => Promise.reject(unreadableMessage) }, 'an unreadable error'],
    ['an Error whose code getter throws', { resolveCallConfig: () => Promise.reject(unreadableCode) }, 'code unreadable'],
    ['a revoked proxy as the rejection', { resolveCallConfig: () => Promise.reject(revoked()) }, 'an unreadable error'],
    ['a throwing resolveCallConfig getter', { get resolveCallConfig() { throw new Error('getter exploded') } }, 'getter exploded'],
    ['a revoked proxy as the llm', revoked(), /revoked/],
  ]
  for (const [label, llm, reason] of cases) {
    const d = await commandDriver({ llm })
    const result = await d.send(`model ${SELECTED} effort=high`)
    assert.equal(result.kind, 'error', label)
    const prefix = `Advisor model effort high for ${SELECTED} could not be checked: `
    if (typeof reason === 'string') {
      assert.equal(result.text, `${prefix}${reason}; nothing was changed.`, label)
    } else {
      assert.match(result.text, new RegExp(`^${escapeRegExp(prefix)}.+; nothing was changed\\.$`), label)
      assert.match(result.text, reason, label)
    }
    assert.equal(d.state().advisorModel, null, `${label}: nothing stored`)
    assert.equal(d.state().pending, null, `${label}: no pending marker left`)
    assert.equal((await d.send(`model ${SELECTED}`)).kind, 'success', `${label}: later commands work`)
    d.setState({ ...d.state(), verifierModel: { ...HAIKU, effort: 'max' } })
    const status = await d.send('status')
    assert.equal(status.kind, 'success', `${label}: status answers`)
    assert.doesNotMatch(status.text, /no longer offered/, label)
  }
  // A refused effort whose advertised list holds unreadable entries is still refused as not offered.
  for (const modelInfo of [() => ({ reasoning: { efforts: [revoked()] } }), () => revoked(), () => ({ reasoning: revoked() })]) {
    const odd = await commandDriver({ llm: fakeLlm({ modelInfo }) })
    assert.deepEqual(await odd.send(`model ${SELECTED} effort=max`), {
      kind: 'error',
      text: `Advisor model effort max is not offered by ${SELECTED}; nothing was changed. The list of advertised efforts is unavailable.`,
    })
    odd.setState({ ...odd.state(), verifierModel: { ...selected, effort: 'max' } })
    const status = await odd.send('status')
    assert.ok(status.text.includes(`Verifier model effort max is no longer offered by ${SELECTED}; spawns on it fail until you reset it with /advisor verifier-model ${SELECTED}. The list of advertised efforts is unavailable.\n`), status.text)
  }
})

test('effort: a timeout is reported as the timeout even when the llm rejects inside its abort listener', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const signals = []
  // Not async: the promise the race sees is the one rejected inside the listener.
  const llm = {
    resolveCallConfig: (_config, signal) => {
      signals.push(signal)
      return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted by the llm'))) })
    },
  }
  const d = await commandDriver({ llm })
  const slow = d.send(`model ${SELECTED} effort=high`)
  await turn()
  t.mock.timers.tick(10_000)
  assert.deepEqual(await slow, {
    kind: 'error',
    text: `Advisor model effort high for ${SELECTED} could not be checked: the check timed out after 10 s; nothing was changed.`,
  })
  assert.equal(signals.length, 1)
  assert.equal(signals[0].aborted, true)
  assert.equal(d.state().advisorModel, null)
})

test('effort: the deadline timer is cleared once a set check ends, whatever its outcome', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const cases = [
    ['accepted', {}, `model ${SELECTED} effort=high`, 'success'],
    ['not advertised', {}, `model ${SELECTED} effort=max`, 'error'],
    ['another failure', { callConfig: () => { throw new Error('offline') } }, `verifier-model ${SELECTED} effort=low`, 'error'],
  ]
  for (const [label, options, input, kind] of cases) {
    const llm = fakeLlm(options)
    const d = await commandDriver({ llm })
    assert.equal((await d.send(input)).kind, kind, label)
    assert.ok(llm.calls.length > 0, label)
    // A timer still pending would fire now and abort the check's signal.
    t.mock.timers.tick(10_000)
    t.mock.timers.runAll()
    for (const call of llm.calls) assert.equal(call.signal.aborted, false, `${label}: ${call.method} signal`)
  }
})

test('status: the drift check clears its timer once both checks end', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const llm = fakeLlm()
  const d = await commandDriver({ llm })
  d.setState({ ...d.state(), advisorModel: { ...selected, effort: 'high' }, verifierModel: { ...HAIKU, effort: 'max' } })
  const { kind, text } = await d.send('status')
  assert.equal(kind, 'success')
  assert.ok(text.includes('Verifier model effort max is no longer offered by anthropic/claude-haiku-5-5'), text)
  assert.deepEqual(llm.calls.map((call) => call.method), ['resolveCallConfig', 'resolveCallConfig', 'resolveModelInfo'])
  t.mock.timers.tick(10_000)
  t.mock.timers.runAll()
  for (const call of llm.calls) assert.equal(call.signal.aborted, false, call.method)
})

test('status: with a stored effort and no usable llm the text is exactly the plain status (a silent skip)', async (t) => {
  const dataDir = path.join(await tempDir(t, 'advisor-effort-status-'), 'data')
  const quiet = [
    ['no ctx.get', {}],
    ['no llm service', { profile: {} }],
    ['ctx.get throws', { llm: () => { throw new Error('gone') } }],
    ['a revoked proxy as the llm', { llm: revoked() }],
    ['a throwing resolveCallConfig getter', { llm: { get resolveCallConfig() { throw new Error('getter exploded') } } }],
    ['another failure', { llm: fakeLlm({ callConfig: () => { throw new Error('offline') } }) }],
    ['an unreadable rejection', { llm: { resolveCallConfig: () => Promise.reject(Object.create(null)) } }],
  ]
  for (const [label, options] of quiet) {
    const d = await commandDriver(options, { dataDir })
    d.setState({ ...d.state(), advisorModel: { ...selected, effort: 'xhigh' }, verifierModel: { ...HAIKU, effort: 'max' } })
    assert.deepEqual(await d.send('status'), {
      kind: 'success',
      text: 'Advisor is off; verification is disabled for this session.\n'
        + `Advisor model: ${SELECTED} effort=xhigh. Verifier model: anthropic/claude-haiku-5-5 effort=max. Both apply when Advisor is on.\n`
        + `Data directory: ${dataDir}\nRecent advisor runs:\nNo consults recorded.`,
    }, label)
    assert.deepEqual(d.state().verifierModel, { ...HAIKU, effort: 'max' }, `${label}: nothing is cleared`)
  }
})

// Built from fragments so that this file does not itself contain the names it bans.
const BANNED_NAMES = [new RegExp(['advisor', 'cli'].join('-'), 'i'), new RegExp(['advisor', 'skill'].join(' '), 'i'), new RegExp(['consult', 'py'].join('\\.'), 'i'), new RegExp(['\\b', 'legacy', '\\b'].join(''), 'i')]

test('no plugin prompt, guard text, README or source names an external CLI, its script or an older ledger', () => {
  const routes = [null, { mode: 'route', provider: 'anthropic', model: 'claude-haiku-5-5' }, { mode: 'route', provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'high' }]
  const subagent = (args) => ({ name: 'subagent', arguments: args })
  const texts = [
    POLICY,
    UNCONFIGURED_POLICY,
    ADVISOR_WORKFLOW,
    advisorWorkflow({ ledgerPath: '/data/sessions.jsonl', repliesDir: '/data/replies' }),
    unavailablePolicy('Advisor data directory is not usable.'),
    DATA_DIR_NOT_CONFIGURED,
    dataDirUnusable('not writable'),
    PLANNER_POLICY,
    CONSULT_POLICY,
    VERIFIER_WORKFLOW,
    VERIFIER_POLICY,
    ...routes.flatMap((route) => [advisorModelPolicy(route), verifierModelPolicy(route)]),
    advisorNamespaceDenial(subagent({ name: 'advisor-other' })),
    verifierDelegationDenial(subagent({ name: 'advisor-verifier-uppercase' })),
    verifierDelegationDenial({ name: 'subagent_fork', arguments: { name: 'advisor-verifier-0123456789ab' } }),
    verifierDelegationDenial(subagent({ name: 'advisor-verifier-0123456789ab', model: 'x' })),
    verifierDelegationDenial(subagent({ name: 'advisor-verifier-0123456789ab' }), () => false),
    verifierDelegationDenial(subagent({ name: 'advisor-verifier-0123456789ab' }), () => true, () => null, () => 'data directory problem'),
  ]
  const srcDir = new URL('../src/', import.meta.url)
  const files = readdirSync(srcDir).filter((name) => name.endsWith('.js')).map((name) => [`src/${name}`, readFileSync(new URL(name, srcDir), 'utf8')])
  assert.ok(files.length >= 5, 'the source files are found')
  const sources = [...files, ['README.md', readFileSync(new URL('../README.md', import.meta.url), 'utf8')], ...texts.map((text) => [String(text).slice(0, 60), text])]
  for (const [label, text] of sources) {
    assert.equal(typeof text, 'string', label)
    for (const banned of BANNED_NAMES) assert.doesNotMatch(text, banned, `${label}: ${banned}`)
  }
})
