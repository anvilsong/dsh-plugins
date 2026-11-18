// Adversarial tests for the Advisor child boundary (src/planner.js: planner and
// consult children) and its use of the plugin-owned ledger (src/ledger.js;
// the ledger's own unit and cross-process tests are in ledger.test.mjs).
// Tests marked `todo` assert an intended guarantee that the current code
// violates; each todo text names the bug.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { apply, unavailablePolicy } from '../src/index.host.js'
import {
  ADVICE_PARAMETERS,
  ADVICE_SCHEMA_ID,
  ADVICE_TOOL,
  ADVISOR_WORKFLOW,
  advisorModelPolicy,
  advisorNamespaceDenial,
  advisorWorkflow,
  briefingTopic,
  CHILD_NAME_PATTERN,
  CONSULT_POLICY,
  CONSULT_TOOLS,
  confinedGrep,
  DATA_DIR_NOT_CONFIGURED,
  evidenceReferenceIssues,
  installPlannerBoundary,
  isDelegationTool,
  MAX_SUBMIT_FAILURES,
  PLAN_PARAMETERS,
  PLAN_SCHEMA_ID,
  PLANNER_POLICY,
  PLANNER_TOOLS,
  PLANNER_WORKFLOW,
  plannerPathAllowed,
  plannerPathDenial,
  plannerRoutePolicy,
  protectedSegment,
  renderAdvice,
  renderPlan,
  reservedAdvisorChildName,
  reservedPlannerName,
  sessionUsage,
  SUBMIT_TOOL,
  validateAdvice,
  validatePlan,
} from '../src/planner.js'
import { createLedger, fileSha256Sync, sha256 } from '../src/ledger.js'
import { parseModelSetting, spawnArgs } from '../src/state.js'
import { verifierDelegationDenial } from '../src/verifier.js'

// ---------------------------------------------------------------------------
// Fixtures. Everything this file writes lives under TMP. Every ledger is an
// explicit createLedger(<dir under TMP>); there is no default location.

const TMP = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'advisor-planner-test-')))
after(() => {
  rmSync(TMP, { recursive: true, force: true })
})

/** Point environment variables at decoys for one test; restores them afterwards. */
function decoyEnv(t, values) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  Object.assign(process.env, values)
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

/** Every file and folder under a directory, relative, folders with a trailing slash, sorted. */
function tree(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const relative = path.relative(dir, path.join(entry.parentPath ?? entry.path, entry.name)).split(path.sep).join('/')
      return entry.isDirectory() ? `${relative}/` : relative
    })
    .sort()
}

/** Parsed lines of a ledger file (none when it does not exist). */
function ledgerLines(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

/** Wait until a predicate holds (real file appends complete off the event loop). */
async function until(predicate, label, ms = 5000) {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const omit = (value, key) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))
const hash = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')

// Workspace: ordinary files, protected files with canaries, symlinks that
// leave the workspace, and an outside directory holding a canary. The outside
// canary has an unprotected name so only workspace confinement can deny it.
const WS = path.join(TMP, 'ws')
const OUT = path.join(TMP, 'outside')
function put(file, text = 'x\n') {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}
put(path.join(WS, 'src/a.js'), 'export const a = 1\n')
for (const file of ['src/sub/b.js', 'docs/readme.md', '.env.example', 'config/settings.json']) put(path.join(WS, file))
const PROTECTED_FIXTURES = {
  '.env': 'FAKE_SECRET_ENV=1\n',
  '.env.local': 'FAKE_SECRET_LOCAL=1\n',
  '.env.development': 'FAKE_SECRET_DEV=1\n',
  id_rsa: 'FAKE_SECRET_KEY\n',
  'x.pem': 'FAKE_SECRET_PEM\n',
  '.npmrc': 'FAKE_SECRET_NPM\n',
  '.git/config': '[remote "origin"]\n\turl = https://FAKE_SECRET_GIT@example.invalid/r.git\n',
  'nested/.ssh/known_hosts': 'FAKE_SECRET_SSH\n',
  'config/credentials.json': '{"token":"FAKE_SECRET_CRED"}\n',
  'secret.json': '{"token":"FAKE_SECRET_JSON"}\n',
  'infra.tfstate': '{"token":"FAKE_SECRET_TFSTATE"}\n',
  'key.asc': 'FAKE_SECRET_ASC\n',
}
for (const [file, text] of Object.entries(PROTECTED_FIXTURES)) put(path.join(WS, file), text)
put(path.join(OUT, 'canary.txt'), 'FAKE_OUTSIDE_CANARY\n')
mkdirSync(path.join(OUT, 'inner'), { recursive: true })
mkdirSync(path.join(WS, 'a'), { recursive: true })
symlinkSync(OUT, path.join(WS, 'link-out')) // directory symlink out of the workspace
symlinkSync(path.join(OUT, 'canary.txt'), path.join(WS, 'link-file-out')) // file symlink out
symlinkSync(OUT, path.join(WS, 'src', 'out-link')) // escapes only when resolved relative to src/
symlinkSync(path.join(WS, '.env'), path.join(WS, 'link-env')) // symlink to a protected file inside
symlinkSync(path.join(OUT, 'inner'), path.join(WS, 'a', 'L')) // a/L/.. is OUT physically, a/ lexically

const deny = (name, args, cwd = WS) => plannerPathDenial({ name, arguments: args }, WS, cwd)

// Replays DSH grep (dsh-tool-fs-search buildGrepCommand: rg --no-config --json
// --regexp=<pattern> --glob=<include> [-- <path>] in the agent working
// directory). stdin must not be a pipe: without a path rg would search stdin.
const RG = spawnSync('rg', ['--version'], { encoding: 'utf8' }).status === 0 ? 'rg' : undefined
function rgMatches(args) {
  const run = spawnSync(RG, ['--no-config', '--json', ...args], { cwd: WS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return run.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((record) => record.type === 'match')
    .map((record) => ({ path: record.data.path.text.replace(/^\.\//, ''), lineNumber: record.data.line_number, line: record.data.lines.text }))
}
const pathsOf = (matches) => matches.map((match) => match.path).sort()

// ---------------------------------------------------------------------------
// Plan and advice fixtures and a JSON Schema subset validator.

function task(id, overrides = {}) {
  return {
    id,
    title: `Implement ${id}`,
    level: 'ordinary',
    level_reason: 'Touches shared code.',
    write_scopes: [`src/${id.toLowerCase()}.js`],
    acceptance: [{ criterion: `${id} behaves as specified`, verify: 'node --test packages/advisor/test/planner.test.mjs' }],
    blocked_by: [],
    open_questions: [],
    ...overrides,
  }
}
const plan = (tasks = [task('T1')], overrides = {}) => ({ summary: 'Ship the change.', tasks, open_questions: [], ...overrides })
const chain = (count) => Array.from({ length: count }, (_, index) => task(`T${index + 1}`, { blocked_by: index === 0 ? [] : [`T${index}`] }))

function advice(overrides = {}) {
  return {
    question: 'Should the boundary wrap grep or inspect include globs?',
    recommendation: 'Wrap grep and filter results by path.',
    rationale: 'Include inspection cannot model ripgrep globs; result filtering is exact.',
    options: [
      { name: 'Wrap grep', verdict: 'recommended', tradeoffs: 'Exact; small.' },
      { name: 'Include allowlist', verdict: 'rejected', tradeoffs: 'Bypassable by escapes.' },
      { name: 'No grep', verdict: 'viable', tradeoffs: 'Safe but weak.' },
    ],
    risks: ['The spill hook is skipped for the wrapper.'],
    do_not_build: ['A glob parser.'],
    claims: [
      { claim: 'grep runs ripgrep with --glob', evidence: ['src/a.js:1', 'docs/readme.md'] },
      { claim: 'b.js exists', evidence: ['src/sub/b.js:1-1'] },
    ],
    open_questions: [],
    ...overrides,
  }
}
const withEvidence = (...evidence) => advice({ claims: [{ claim: 'c', evidence }] })

function issues(value, validate = validatePlan) {
  const result = validate(value)
  assert.equal(result.ok, false, 'expected the validator to reject the value')
  return result.issues.join('\n')
}

const SCHEMA_KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'description'])
function schemaErrors(schema, value, at = '$') {
  for (const keyword of Object.keys(schema)) {
    if (!SCHEMA_KEYWORDS.has(keyword)) throw new Error(`schema uses ${keyword} at ${at}, outside the enforced subset`)
  }
  const isType = {
    object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
    array: (v) => Array.isArray(v),
    string: (v) => typeof v === 'string',
    integer: (v) => Number.isInteger(v),
    number: (v) => typeof v === 'number' && Number.isFinite(v),
    boolean: (v) => typeof v === 'boolean',
    null: (v) => v === null,
  }
  if (schema.type !== undefined && !isType[schema.type](value)) return [`${at}: expected ${schema.type}`]
  const errors = []
  if (schema.enum !== undefined && !schema.enum.includes(value)) errors.push(`${at}: not one of ${schema.enum.join(', ')}`)
  if (schema.type === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${at}.${key}: required`)
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties !== undefined && Object.hasOwn(schema.properties, key)) errors.push(...schemaErrors(schema.properties[key], child, `${at}.${key}`))
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: additional property`)
    }
  }
  if (schema.type === 'array' && schema.items !== undefined) {
    value.forEach((item, index) => errors.push(...schemaErrors(schema.items, item, `${at}[${index}]`)))
  }
  return errors
}

// ---------------------------------------------------------------------------
// Boundary harness: fake host ctx plus fake child agents (see host.test.mjs).

const PLAN_ID = 'abcdef012345'
const PLAN_ID_B = '0123456789ab'
const OLD_ID = '00000000aaaa'
const PLANNER = `advisor-planner-${PLAN_ID}`
const PLANNER_B = `advisor-planner-${PLAN_ID_B}`
const CONSULT = `advisor-consult-${PLAN_ID}`
const CONSULT_B = `advisor-consult-${PLAN_ID_B}`
const ROUTE = Object.freeze({ provider: 'openrouter', model: '~deepseek/deepseek-flash-latest' })
const OTHER_ROUTE = Object.freeze({ provider: 'anthropic', model: 'claude-haiku-5-5' })
// A saved Advisor or Verifier model with an effort (the route plus its effort id).
const ROUTE_EFFORT = Object.freeze({ ...ROUTE, effort: 'high' })
// The denials used before efforts existed, byte for byte.
const CHILD_MUST_OMIT = 'Advisor children must omit reasoning_effort and agent_preset so the selected model default applies.'
const VERIFIER_MUST_OMIT = 'Advisor verifier must omit reasoning_effort and agent_preset so the selected model default applies.'
const USAGE_ZERO = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, model_requests: 0 }

// Ledger modes: 'fake' (default) passes deps.ledger = createLedger(dir) plus
// in-memory per-function overrides (lines in state.ledger, replies on disk);
// 'real' passes only deps.ledger, so every line and reply is a file under
// dir; 'overrides' passes only the per-function overrides; 'none' passes
// neither. install: false leaves installation to the caller (the host's
// apply()).
function harness(options = {}) {
  const { noGrep = false, ledgerMode = 'fake', dataDir, install = true, ...depsOverride } = options
  const dir = dataDir ?? mkdtempSync(path.join(TMP, 'boundary-'))
  const ledger = createLedger(dir)
  const listeners = new Map()
  const hostGuards = []
  const agents = new Map()
  const logs = []
  const state = {
    settings: { active: true, advisorModel: null },
    routes: [ROUTE],
    teams: true,
    workspace: WS,
    clock: 1_700_000_000_000,
    used: new Set(),
    ledger: [],
    writeCalls: [],
    grepMatches: [],
    grepCalls: [],
    beforeWrite: undefined,
    beforeAppend: undefined,
    failAppend: undefined,
  }
  // Shaped like a dsh-tools defineTool() result: a plain object.
  const hostGrep = {
    name: 'grep',
    description: 'Search file contents with a ripgrep regular expression.',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, include: { type: 'string' } }, required: ['pattern'] },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.matches.map((match) => `${match.path}:${match.lineNumber}: ${match.line}`).join('\n') }],
      presentationMeta: (_args, value) => ({ shape: 'matches', count: value.matches.length }),
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ title: `grep ${args.pattern}` }),
    presentResult: () => undefined,
    async execute(args, exec) {
      state.grepCalls.push({ args, exec })
      return { matches: state.grepMatches.map((match) => ({ ...match })) }
    },
  }
  const globalDefs = Object.fromEntries(
    ['glob', 'read', 'bash', 'write', 'edit', 'send_message', 'subagent', 'team_task_create', 'web_fetch'].map((name) => [name, { name }]),
  )
  if (!noGrep) globalDefs.grep = hostGrep
  const lead = { id: 'lead-session', names: { self: 'lead', parent: undefined }, cancel() {} }
  lead.root = lead
  const mate = { id: 'mate-session', names: { self: 'mate', parent: 'lead' }, root: lead, cancel() {} }
  agents.set(lead.id, lead)
  agents.set(mate.id, mate)
  const ctx = {
    agents: { get: (id) => agents.get(id) },
    subagents: {
      namesOf(agent) {
        if (agent.namesThrow) throw new Error('names unavailable')
        return agent.names
      },
      rootOf(agent) {
        if (agent.rootThrows) throw new Error('root unavailable')
        return agent.root
      },
    },
    tools: {
      get: (name) => globalDefs[name],
      guard(fn) {
        hostGuards.push(fn)
        return () => {
          const index = hostGuards.indexOf(fn)
          if (index !== -1) hostGuards.splice(index, 1)
        }
      },
    },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
      return () => {
        const list = listeners.get(name)
        const index = list.indexOf(fn)
        if (index !== -1) list.splice(index, 1)
      }
    },
    logger: { warn: (message) => logs.push(message), info() {}, debug() {} },
  }
  const fakes = {
    appendLedger: async (line) => {
      const wait = state.beforeAppend?.(line)
      if (wait !== undefined) await wait
      if (state.failAppend?.(line)) throw new Error('ledger disk full')
      state.ledger.push(JSON.parse(JSON.stringify(line)))
    },
    writeReply: async (id, text) => {
      state.writeCalls.push({ id, text })
      if (state.beforeWrite !== undefined) await state.beforeWrite(id, text)
      return ledger.writeReply(id, text)
    },
    idInUse: (id) => state.used.has(id) || state.ledger.some((entry) => entry.consult_id === id) || existsSync(ledger.replyPath(id)),
    ledgerEntriesFor: (id) => state.ledger.filter((entry) => entry.consult_id === id),
    fileHash: fileSha256Sync,
  }
  const ledgerDeps = { fake: { ledger, ...fakes }, real: { ledger }, overrides: { ...fakes }, none: {} }[ledgerMode]
  assert.ok(ledgerDeps !== undefined, `unknown ledger mode ${ledgerMode}`)
  const deps = {
    settingsFor: () => state.settings,
    routesFor: () => state.routes,
    teamsEnabled: () => state.teams,
    workspaceOf: (agent) => (agent === lead ? state.workspace : (Object.hasOwn(agent, 'cwd') ? agent.cwd : state.workspace)),
    now: () => state.clock,
    ...ledgerDeps,
    ...depsOverride,
  }
  const boundary = install ? installPlannerBoundary(ctx, deps) : undefined
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    boundary?.()
  }

  function child({ id = 'planner-1', self = PLANNER, parent = 'lead', route = ROUTE, guardThrows = false, refuse = [], events = [], ...extra } = {}) {
    const handle = {
      route, guardThrows, events, refuse: new Set(refuse),
      tool: self.startsWith('advisor-consult') ? ADVICE_TOOL : SUBMIT_TOOL,
      registered: new Map(), guards: [], sections: [], inbox: [], sequence: [], shadows: new Map(),
    }
    const agent = {
      id,
      names: { self, parent },
      root: lead,
      cancelled: 0,
      cancel() { this.cancelled++ },
      model: {
        current() {
          if (handle.route instanceof Error) throw handle.route
          return handle.route
        },
      },
      session: {
        ownEvents() {
          return typeof handle.events === 'function' ? handle.events() : handle.events
        },
      },
      ctx: {
        tools: {
          get(name) {
            handle.sequence.push(`get:${name}`)
            return handle.shadows.get(name) ?? handle.registered.get(name) ?? globalDefs[name]
          },
          guard(fn) {
            if (handle.guardThrows) throw new Error('guard registry closed')
            handle.guards.push(fn)
            handle.sequence.push('guard')
            return () => {}
          },
          register(definition) {
            handle.sequence.push(`register:${definition.name}`)
            if (handle.refuse.has(definition.name)) return () => {}
            handle.registered.set(definition.name, definition)
            return () => {
              if (handle.registered.get(definition.name) === definition) handle.registered.delete(definition.name)
              handle.sequence.push(`unregister:${definition.name}`)
            }
          },
        },
        systemPrompt: {
          getSectionOrder: (name) => (name === 'PLAN_POLICY' ? 500 : 0),
          section(value) {
            handle.sections.push(value)
            handle.sequence.push('section')
            return () => {
              const index = handle.sections.indexOf(value)
              if (index !== -1) handle.sections.splice(index, 1)
              handle.sequence.push('unsection')
            }
          },
        },
        on(name, fn) {
          handle.sequence.push(`on:${name}`)
          if (name === 'agent/inbox/inserted') handle.inbox.push(fn)
          return () => {
            const index = handle.inbox.indexOf(fn)
            if (index !== -1) handle.inbox.splice(index, 1)
            handle.sequence.push(`off:${name}`)
          }
        },
      },
      ...extra,
    }
    handle.agent = agent
    agents.set(id, agent)
    return handle
  }

  const emit = (name, payload) => { for (const fn of [...(listeners.get(name) ?? [])]) fn(payload) }
  const pick = (opts, fallback) => (Object.hasOwn(opts, 'agent') ? opts.agent : fallback)
  function hostDenial(exec) {
    for (const guard of [...hostGuards]) {
      const denial = guard(exec)
      if (denial !== undefined) return denial
    }
    return undefined
  }
  const call = (name, args, opts = {}) => hostDenial({ name, arguments: args, agent: pick(opts, lead) })
  const delegate = (args = {}, opts = {}) => call(opts.tool ?? 'subagent', { name: PLANNER, description: 'Plan', prompt: 'Sanitized briefing.', ...args }, opts)
  function run(c, name, args, opts = {}) {
    const exec = { name, arguments: args, agent: pick(opts, c.agent), toolSet: opts.toolSet }
    const denial = hostDenial(exec)
    if (denial !== undefined) return denial
    for (const guard of c.guards) {
      const childDenial = guard(exec)
      if (childDenial !== undefined) return childDenial
    }
    return undefined
  }
  async function submit(c, args, opts = {}) {
    const agent = pick(opts, c.agent)
    const tool = opts.tool ?? c.tool
    const denial = run(c, tool, args, { agent })
    if (denial !== undefined) throw Object.assign(new Error(`denied: ${denial}`), { denied: true })
    return c.registered.get(tool).execute(args, { name: tool, arguments: args, agent })
  }
  const start = (c, info = {}) => emit('subagent/start', { id: c.agent.id, local: true, provider: 'spawn', runId: 'run-1', parentSessionId: lead.id, ...info })
  const end = (c) => emit('subagent/end', { id: c.agent.id, stopReason: 'completed' })
  const agentDisposed = (c) => emit('agent/disposed', { agent: c.agent })
  const brief = (c, text) => { for (const fn of [...c.inbox]) fn({ message: { role: 'user', content: [{ type: 'text', text }] } }) }
  // With the in-memory overrides lines live in state.ledger; otherwise read the ledger file.
  const lines = () => (ledgerMode === 'fake' || ledgerMode === 'overrides' ? state.ledger : ledgerLines(ledger.ledgerPath))
  const terminal = () => lines().filter((line) => line.status !== 'started')
  const statuses = () => lines().map((line) => line.status)
  const reasons = () => lines().map((line) => [line.status, line.failure_reason])
  return {
    state, ctx, lead, mate, dir, ledger, deps, logs, boundary, hostGuards, listeners, hostGrep,
    child, start, end, agentDisposed, brief, call, delegate, run, submit, dispose, lines, terminal, statuses, reasons,
  }
}

/**
 * Install the boundary the way the Host does: through index.host.js apply()
 * with this config and an optional profileContext.home, on top of a harness
 * created with install: false. Only the agent services come from the harness;
 * `dataDir` only tells h.lines() which ledger file to read.
 */
async function hostHarness(config, { home, dataDir, ...options } = {}) {
  const h = harness({ ...options, dataDir, ledgerMode: 'none', install: false })
  h.lead.session = { id: 'lead-session-log' } // index.host.js reads lead state through rootOf(agent).session
  const effects = new Map()
  const sections = []
  let command
  const hostCtx = {
    get: (name) => (name === 'profileContext' && home !== undefined ? { home } : undefined),
    logger: h.ctx.logger,
    sessionProjections: {
      async register(definition) {
        return { stateOf: () => (definition.key === 'advisor' ? h.state.settings : h.state.routes) }
      },
    },
    systemPrompt: { getSectionOrder: () => 500, section(value) { sections.push(value); return () => {} } },
    inject(_names, callback) {
      callback({
        ...h.ctx,
        workingDirectory: { get: () => h.state.workspace },
        agentTeams: { isEnabled: () => h.state.teams },
        commands: { register(value) { command = value } },
        effect(fn, label) { effects.set(label, fn()) },
      })
    },
  }
  await apply(hostCtx, config)
  const boundary = effects.get('advisor: child boundary')
  assert.equal(typeof boundary, 'function', 'apply() installed the child boundary')
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const effect of effects.values()) effect?.()
  }
  return { ...h, boundary, dispose, sections, command: () => command }
}

function startChild(h, options) {
  const c = h.child(options)
  h.start(c)
  h.brief(c, 'Sanitized briefing.')
  return c
}
const startConsult = (h, options = {}) => startChild(h, { self: CONSULT, ...options })

// Holds writeReply open until the returned release function is called.
function holdWrite(h) {
  const held = {}
  h.state.beforeWrite = () => new Promise((resolve) => { held.release = resolve })
  return held
}

const usageChunk = (usage) => ({ type: 'chunk', chunk: { type: 'usage', usage } })
const agentWith = (events) => ({ session: { ownEvents: () => events } })

// ===========================================================================
// 0. Policy texts and names

test('policy: Advisor model policy, workflow and child policies; the 0.5 aliases still work', () => {
  assert.match(advisorModelPolicy(null), /^Advisor model: Inherit\. .*omit provider, model, reasoning_effort, and agent_preset/)
  assert.equal(advisorModelPolicy(undefined), advisorModelPolicy(null))
  assert.match(advisorModelPolicy(ROUTE), new RegExp(`^Advisor model: ${escapeRegExp(`${ROUTE.provider}/${ROUTE.model}`)}\\. Pass exactly this provider and model`))
  assert.match(ADVISOR_WORKFLOW, /in-process, read-only child agent on the Advisor model\.\n/)
  assert.match(ADVISOR_WORKFLOW, /advisor-planner-<id>/)
  assert.match(ADVISOR_WORKFLOW, /advisor-consult-<id>/)
  assert.match(ADVISOR_WORKFLOW, /one advisor child at a time/)
  assert.equal(PLANNER_WORKFLOW, ADVISOR_WORKFLOW)
  assert.equal(plannerRoutePolicy({ mode: 'route', ...ROUTE }), advisorModelPolicy(ROUTE))
  assert.equal(plannerRoutePolicy({ mode: 'inherit' }), advisorModelPolicy(null))
  assert.equal(plannerRoutePolicy(undefined), advisorModelPolicy(null))
  for (const [policy, tool, marker] of [[PLANNER_POLICY, SUBMIT_TOOL, 'PLAN <plan_id>'], [CONSULT_POLICY, ADVICE_TOOL, 'ADVICE <advice_id>']]) {
    assert.ok(policy.includes(tool), tool)
    assert.ok(policy.includes(marker), marker)
    assert.match(policy, /must not use "\.\."/)
    assert.match(policy, /grep withholds matches from them/)
  }
  assert.deepEqual(PLANNER_TOOLS, ['glob', 'grep', 'read', SUBMIT_TOOL])
  assert.deepEqual(CONSULT_TOOLS, ['glob', 'grep', 'read', ADVICE_TOOL])
})

test('policy: the Inherit and no-effort Advisor model texts are unchanged; a stored effort is named literally with its reset', () => {
  // The texts from before efforts existed, byte for byte.
  assert.equal(advisorModelPolicy(null),
    'Advisor model: Inherit. For advisor-planner and advisor-consult children, omit provider, model, reasoning_effort, and agent_preset so configured child defaults and compatible parent values apply.')
  assert.equal(advisorModelPolicy(ROUTE),
    `Advisor model: ${ROUTE.provider}/${ROUTE.model}. Pass exactly this provider and model to subagent for advisor-planner and advisor-consult children, omit reasoning_effort and agent_preset so the selected model's default effort applies, and do not fall back to another route if spawning fails.`)
  assert.equal(advisorModelPolicy({ ...ROUTE, effort: 'high' }),
    `Advisor model: ${ROUTE.provider}/${ROUTE.model} effort=high. Pass exactly this provider and model to subagent for advisor-planner and advisor-consult children, pass reasoning_effort "high", omit agent_preset, and do not fall back to another route if spawning fails. If the spawn is rejected for the effort, report it and do not retry without it; the user can reset the effort with /advisor model ${ROUTE.provider}/${ROUTE.model}.`)
})

test('names: child name pattern and reserved prefixes cover planner and consult only', () => {
  for (const [name, kind] of [[PLANNER, 'planner'], [CONSULT, 'consult']]) {
    assert.deepEqual([...CHILD_NAME_PATTERN.exec(name)].slice(1), [kind, PLAN_ID])
  }
  for (const name of ['advisor-planner', 'advisor-consult-ABCDEF012345', 'advisor-consult-abcdef01234', 'advisor-verifier-abcdef012345', 'advisor-consults-abcdef012345']) {
    assert.equal(CHILD_NAME_PATTERN.test(name), false, name)
  }
  for (const name of ['advisor-planner', 'advisor-planner-x', 'advisor-consult', 'advisor-consult-x']) assert.equal(reservedAdvisorChildName(name), true, name)
  for (const name of ['advisor-plannerx', 'advisor-consultx', 'advisor-verifier-x', 'advisor', 'reviewer', undefined, 7]) {
    assert.equal(reservedAdvisorChildName(name), false, String(name))
  }
  assert.equal(reservedPlannerName(CONSULT), false)
})

// ===========================================================================
// 1. validatePlan, validateAdvice and the model-facing schemas

test('validatePlan: accepts a well-formed plan, trims text and normalizes scopes', () => {
  const input = plan([
    task('T1', { title: '  Add parser  ', write_scopes: ['./a//b/', 'docs\\guide.md'], level: 'mechanical' }),
    task('T2', { write_scopes: ['a/b/c.js'], blocked_by: ['T1'], level: 'hard', open_questions: ['Which format?'] }),
    task('T3', { write_scopes: [] }),
  ], { open_questions: ['Ship behind a flag?'] })
  const result = validatePlan(input)
  assert.equal(result.ok, true, result.issues?.join('\n'))
  assert.deepEqual(result.plan.tasks.map((item) => item.write_scopes), [['a/b', 'docs/guide.md'], ['a/b/c.js'], []])
  assert.equal(result.plan.tasks[0].title, 'Add parser')
  assert.deepEqual(input.tasks[0].write_scopes, ['./a//b/', 'docs\\guide.md'], 'the input is not mutated')
  const rendered = renderPlan(PLAN_ID, result.plan)
  assert.ok(rendered.endsWith('}\n'))
  assert.deepEqual(Object.keys(JSON.parse(rendered)), ['schema', 'plan_id', 'summary', 'tasks', 'open_questions'])
  assert.equal(JSON.parse(rendered).schema, PLAN_SCHEMA_ID)
})

test('validatePlan: rejects duplicate ids and unknown, self or duplicate dependencies', () => {
  assert.match(issues(plan([task('T1'), task('T2'), task('T1', { write_scopes: [] })])), /tasks\.2\.id: duplicate id T1/)
  assert.match(issues(plan([task('T1', { blocked_by: ['T9'] })])), /tasks\.0\.blocked_by: unknown task id T9/)
  assert.match(issues(plan([task('T1', { blocked_by: ['T1'] })])), /T1 cannot depend on itself/)
  assert.match(issues(plan([task('T1'), task('T2', { blocked_by: ['T1', 'T1'] })])), /tasks\.1\.blocked_by: duplicate T1/)
  assert.match(issues(plan([task('T1'), task('T2', { blocked_by: [' T1'] })])), /unknown task id  T1/)
  for (const id of ['T0', 'T100', 't1', 'T01', 'X1', '']) assert.equal(validatePlan(plan([task(id)])).ok, false, id)
})

test('validatePlan: rejects dependency cycles, including long and late ones', () => {
  assert.match(issues(plan([task('T1', { blocked_by: ['T2'] }), task('T2', { blocked_by: ['T1'] })])), /dependency cycle/)
  const ring = Array.from({ length: 25 }, (_, index) => task(`T${index + 1}`, { blocked_by: [`T${index === 0 ? 25 : index}`] }))
  assert.match(issues(plan(ring)), /dependency cycle/)
  assert.match(issues(plan([task('T1'), task('T2', { blocked_by: ['T3'] }), task('T3', { blocked_by: ['T4'] }), task('T4', { blocked_by: ['T2'] })])), /dependency cycle/)
  assert.equal(validatePlan(plan(chain(25))).ok, true, 'a 25-task chain is acyclic')
  const diamond = [task('T1'), task('T2', { blocked_by: ['T1'] }), task('T3', { blocked_by: ['T1'] }), task('T4', { blocked_by: ['T2', 'T3'] })]
  assert.equal(validatePlan(plan(diamond)).ok, true)
})

test('validatePlan: overlapping write scopes, compared case- and normalization-insensitively, need a dependency path', () => {
  const scoped = (id, scopes, blockedBy = []) => task(id, { write_scopes: scopes, blocked_by: blockedBy })
  assert.match(issues(plan([scoped('T1', ['src/a']), scoped('T2', ['src/a/b.js'])])), /tasks T1 and T2 both change src\/a; order them with blocked_by/)
  assert.match(issues(plan([scoped('T1', ['./src//a/']), scoped('T2', ['src\\a\\b.js'])])), /tasks T1 and T2 both change src\/a/)
  assert.match(issues(plan([scoped('T1', ['src']), scoped('T2', ['src']), scoped('T3', [], ['T1', 'T2'])])), /tasks T1 and T2 both change src/)
  assert.match(issues(plan([scoped('T1', ['src/App.js']), scoped('T2', ['src/app.js'])])), /tasks T1 and T2 both change src\/App\.js/)
  assert.match(issues(plan([scoped('T1', ['SRC']), scoped('T2', ['src/x.js'])])), /tasks T1 and T2 both change SRC/)
  assert.match(issues(plan([scoped('T1', ['src/caf\u00e9.js']), scoped('T2', ['src/cafe\u0301.js'])])), /tasks T1 and T2 both change/)
  assert.equal(validatePlan(plan([scoped('T1', ['src/a']), scoped('T2', ['src/a/b.js'], ['T1'])])).ok, true)
  assert.equal(validatePlan(plan([scoped('T2', ['src/a/b.js'], ['T1']), scoped('T1', ['src/a'])])).ok, true, 'order of tasks is irrelevant')
  assert.equal(validatePlan(plan([scoped('T1', ['src']), scoped('T2', [], ['T1']), scoped('T3', ['src/x'], ['T2'])])).ok, true, 'transitive order suffices')
  assert.equal(validatePlan(plan([scoped('T1', ['src']), scoped('T2', ['src2'])])).ok, true)
  assert.equal(validatePlan(plan([scoped('T1', ['src/a.js']), scoped('T2', ['src/a.jsx'])])).ok, true)
})

test('validatePlan: a mechanical task cannot carry open questions', () => {
  assert.match(issues(plan([task('T1', { level: 'mechanical', open_questions: ['Which file?'] })])), /tasks\.0\.level: a mechanical task must have no open questions/)
  assert.equal(validatePlan(plan([task('T1', { level: 'mechanical' })])).ok, true)
  assert.equal(validatePlan(plan([task('T1', { level: 'hard', open_questions: ['Which file?'] })])).ok, true)
})

test('validatePlan: rejects absolute, home, parent, .git (any case), glob, control, empty and root scopes', () => {
  const bad = [
    '/etc/passwd', '//server/share', 'C:\\Windows', 'c:relative', '\\\\server\\share', '\\root',
    '~/x', '~', '../x', 'a/../b', 'a\\..\\b', '..',
    '.git', '.git/hooks/pre-commit', 'pkg/.git/config', '.GIT/hooks/pre-commit', 'pkg/.Git/config', 'a\\.GIT',
    'src/*.js', 'src/**', 'src/{a,b}', 'a?b', 'a[1]',
    'a\u0000b', 'a\u001fb', 'a\u007fb', 'a\tb',
    '', ' a', 'a ', '\na',
    '.', './', './.', '././', '.\\',
  ]
  for (const scope of bad) {
    assert.match(issues(plan([task('T1', { write_scopes: [scope] })])), /tasks\.0\.write_scopes\.0: /, JSON.stringify(scope))
  }
  for (const scope of ['.github/workflows/ci.yml', 'src/.gitignore', 'git/x', 'a.git/b']) {
    assert.equal(validatePlan(plan([task('T1', { write_scopes: [scope] })])).ok, true, scope)
  }
})

test('validatePlan: verify must be a single line under every line terminator', () => {
  for (const verify of ['npm test\nrm -rf /', 'npm test\r\nx', 'npm test\rx', 'npm test\u2028rm -rf ~', 'npm test\u2029x', 'npm test\u0085x', 'npm test\u000bx', 'npm test\u000cx']) {
    assert.match(issues(plan([task('T1', { acceptance: [{ criterion: 'c', verify }] })])), /tasks\.0\.acceptance\.0\.verify: must be a single line/, JSON.stringify(verify))
  }
  const trimmed = validatePlan(plan([task('T1', { acceptance: [{ criterion: 'c', verify: '  npm test\n' }] })]))
  assert.equal(trimmed.plan.tasks[0].acceptance[0].verify, 'npm test', 'surrounding whitespace is trimmed, not rejected')
})

test('validatePlan: rejects extra properties, more than 25 tasks and empty acceptance', () => {
  assert.equal(validatePlan({ ...plan(), verdict: 'ship' }).ok, false)
  assert.equal(validatePlan({ ...plan(), verdict: undefined }).ok, false)
  assert.equal(validatePlan(plan([{ ...task('T1'), model: 'gpt-5' }])).ok, false)
  assert.equal(validatePlan(plan([task('T1', { acceptance: [{ criterion: 'c', verify: 'v', cmd: 'rm -rf /' }] })])).ok, false)
  const many = (count) => Array.from({ length: count }, (_, index) => task(`T${index + 1}`))
  assert.equal(validatePlan(plan(many(25))).ok, true)
  assert.match(issues(plan(many(26))), /^tasks: /m)
  assert.match(issues(plan([])), /^tasks: /m)
  assert.match(issues(plan([task('T1', { acceptance: [] })])), /^tasks\.0\.acceptance: /m)
  assert.equal(validatePlan(plan([task('T1', { acceptance: Array.from({ length: 11 }, () => ({ criterion: 'c', verify: 'v' })) })])).ok, false)
  assert.equal(validatePlan(plan([task('T1', { title: '   ' })])).ok, false)
  for (const value of [null, undefined, [], 'plan', 7]) assert.equal(validatePlan(value).ok, false, String(value))
})

test('PLAN_PARAMETERS: stays in the enforced subset and agrees with validatePlan on structure', () => {
  const accepted = [
    plan(),
    plan([
      task('T1', { write_scopes: ['./src//lib/'], level: 'mechanical' }),
      task('T2', { write_scopes: ['src/lib/x.js'], blocked_by: ['T1'], level: 'hard', open_questions: ['Which API?'] }),
      task('T3', { write_scopes: [] }),
    ], { open_questions: ['Plan-level question?'] }),
    plan(chain(25)),
  ]
  for (const fixture of accepted) {
    const result = validatePlan(fixture)
    assert.equal(result.ok, true, result.issues?.join('\n'))
    assert.deepEqual(schemaErrors(PLAN_PARAMETERS, fixture), [])
    assert.deepEqual(schemaErrors(PLAN_PARAMETERS, result.plan), [], 'the normalized plan still matches')
  }

  const base = plan()
  const t1 = base.tasks[0]
  const withTask = (value) => ({ ...base, tasks: [value] })
  const structural = {
    'root is an array': [base],
    'root is null': null,
    'root is a string': 'plan',
    'missing summary': omit(base, 'summary'),
    'missing tasks': omit(base, 'tasks'),
    'missing open_questions': omit(base, 'open_questions'),
    'extra root property': { ...base, verdict: 'approve' },
    'summary is a number': { ...base, summary: 5 },
    'tasks is an object': { ...base, tasks: { T1: t1 } },
    'task is a string': { ...base, tasks: ['T1'] },
    'task misses id': withTask(omit(t1, 'id')),
    'task misses level_reason': withTask(omit(t1, 'level_reason')),
    'task misses write_scopes': withTask(omit(t1, 'write_scopes')),
    'task misses acceptance': withTask(omit(t1, 'acceptance')),
    'task misses blocked_by': withTask(omit(t1, 'blocked_by')),
    'task misses open_questions': withTask(omit(t1, 'open_questions')),
    'task extra property': withTask({ ...t1, model: 'gpt-5' }),
    'unknown level': withTask({ ...t1, level: 'trivial' }),
    'level is a number': withTask({ ...t1, level: 1 }),
    'write_scopes is a string': withTask({ ...t1, write_scopes: 'src' }),
    'write scope is a number': withTask({ ...t1, write_scopes: [7] }),
    'acceptance item is a string': withTask({ ...t1, acceptance: ['works'] }),
    'acceptance item misses verify': withTask({ ...t1, acceptance: [{ criterion: 'c' }] }),
    'acceptance item extra property': withTask({ ...t1, acceptance: [{ criterion: 'c', verify: 'v', shell: true }] }),
    'blocked_by holds a number': withTask({ ...t1, blocked_by: [1] }),
    'task open_questions is a string': withTask({ ...t1, open_questions: 'q' }),
    'plan open_questions holds an object': { ...base, open_questions: [{ q: 1 }] },
  }
  for (const [label, fixture] of Object.entries(structural)) {
    assert.equal(validatePlan(fixture).ok, false, `validatePlan: ${label}`)
    assert.notDeepEqual(schemaErrors(PLAN_PARAMETERS, fixture), [], `PLAN_PARAMETERS: ${label}`)
  }

  // Semantic rules the subset cannot express are enforced by execute only.
  const semantic = [
    plan([]),
    plan(Array.from({ length: 26 }, (_, index) => task(`T${index + 1}`))),
    plan([task('T1', { acceptance: [] })]),
    plan([task('T1'), task('T1')]),
    plan([task('T1', { blocked_by: ['T1'] })]),
    plan([task('T1', { write_scopes: ['../x'] })]),
    plan([task('T1', { acceptance: [{ criterion: 'c', verify: 'a\nb' }] })]),
    plan([task('X1')]),
  ]
  for (const fixture of semantic) {
    assert.equal(validatePlan(fixture).ok, false)
    assert.deepEqual(schemaErrors(PLAN_PARAMETERS, fixture), [])
  }
})

test('validateAdvice: accepts well-formed advice, trims text and renders it with its id', () => {
  const input = advice({ question: '  Wrap grep?  ', options: [], claims: [], risks: [], do_not_build: [] })
  const result = validateAdvice(input)
  assert.equal(result.ok, true, result.issues?.join('\n'))
  assert.equal(result.advice.question, 'Wrap grep?')
  const full = validateAdvice(advice())
  assert.equal(full.ok, true, full.issues?.join('\n'))
  assert.equal(full.advice.claims.length, 2)
  const rendered = renderAdvice(PLAN_ID, full.advice)
  assert.ok(rendered.endsWith('}\n'))
  assert.deepEqual(Object.keys(JSON.parse(rendered)), [
    'schema', 'advice_id', 'question', 'recommendation', 'rationale', 'options', 'risks', 'do_not_build', 'claims', 'open_questions',
  ])
  assert.equal(JSON.parse(rendered).schema, ADVICE_SCHEMA_ID)
  assert.equal(JSON.parse(rendered).advice_id, PLAN_ID)
})

test('validateAdvice: options, sizes and required text', () => {
  const opt = (name, verdict = 'viable') => ({ name, verdict, tradeoffs: 't' })
  assert.match(issues(advice({ options: [opt('A', 'recommended'), opt('B', 'recommended')] }), validateAdvice), /options: at most one option may be recommended/)
  assert.match(issues(advice({ options: [opt('Wrap grep'), opt('  wrap GREP ')] }), validateAdvice), /options\.1\.name: duplicate option wrap GREP/)
  assert.equal(validateAdvice(advice({ options: [opt('A'), opt('B'), opt('C', 'rejected')] })).ok, true, 'no recommendation is allowed')
  assert.match(issues(advice({ options: [opt('A', 'preferred')] }), validateAdvice), /^options\.0\.verdict: /m)
  const many = (count, make) => Array.from({ length: count }, (_, index) => make(index))
  assert.equal(validateAdvice(advice({ options: many(8, (i) => opt(`O${i}`)) })).ok, true)
  assert.match(issues(advice({ options: many(9, (i) => opt(`O${i}`)) }), validateAdvice), /^options: /m)
  for (const [field, max] of [['risks', 10], ['do_not_build', 10], ['open_questions', 10]]) {
    assert.equal(validateAdvice(advice({ [field]: many(max, (i) => `item ${i}`) })).ok, true, field)
    assert.match(issues(advice({ [field]: many(max + 1, (i) => `item ${i}`) }), validateAdvice), new RegExp(`^${field}: `, 'm'), field)
  }
  assert.equal(validateAdvice(advice({ claims: many(30, (i) => ({ claim: `c${i}`, evidence: ['src/a.js'] })) })).ok, true)
  assert.match(issues(advice({ claims: many(31, (i) => ({ claim: `c${i}`, evidence: ['src/a.js'] })) }), validateAdvice), /^claims: /m)
  assert.match(issues(advice({ claims: [{ claim: 'c', evidence: [] }] }), validateAdvice), /^claims\.0\.evidence: /m)
  assert.match(issues(advice({ claims: [{ claim: 'c', evidence: many(6, () => 'src/a.js') }] }), validateAdvice), /^claims\.0\.evidence: /m)
  for (const field of ['question', 'recommendation', 'rationale']) {
    assert.equal(validateAdvice(advice({ [field]: '   ' })).ok, false, field)
    assert.equal(validateAdvice(omit(advice(), field)).ok, false, field)
  }
  assert.equal(validateAdvice(advice({ question: 'q'.repeat(1001) })).ok, false)
  assert.equal(validateAdvice({ ...advice(), verdict: 'ship' }).ok, false)
  assert.equal(validateAdvice(advice({ options: [{ ...opt('A'), score: 9 }] })).ok, false)
  assert.equal(validateAdvice(advice({ claims: [{ claim: 'c', evidence: ['src/a.js'], confidence: 1 }] })).ok, false)
  for (const value of [null, undefined, [], 'advice', 7, plan()]) assert.equal(validateAdvice(value).ok, false, JSON.stringify(value))
})

test('validateAdvice: evidence is a workspace-relative path with an optional line or range', () => {
  for (const reference of ['src/a.js', 'src/a.js:12', 'src/a.js:12-30', 'src/a.js:3-3', 'docs/readme.md:1', 'src\\sub\\b.js:2', 'a b/c.js:4']) {
    assert.equal(validateAdvice(withEvidence(reference)).ok, true, reference)
  }
  const bad = {
    '/etc/passwd:1': /path must be workspace-relative/,
    'C:\\x.js:1': /path must be workspace-relative/,
    '../x.js:1': /path must not contain \.\./,
    'src/../x.js': /path must not contain \.\./,
    '.git/config:1': /path must not touch \.git/,
    '.GIT/HEAD': /path must not touch \.git/,
    'src/*.js:1': /path must be a path prefix, not a glob/,
    '~/x.js': /path must not start with ~/,
    '.:3': /path must not be the workspace root/,
    'a\u0000b.js:1': /path must not contain control characters/,
    '': /must be a workspace-relative path with optional :line or :start-end/,
    ' src/a.js': /must be a workspace-relative path/,
    'src/a.js ': /must be a workspace-relative path/,
    'src/a.js:0': /lines start at 1/,
    'src/a.js:0-3': /lines start at 1/,
    'src/a.js:5-3': /line range must not run backwards/,
  }
  for (const [reference, pattern] of Object.entries(bad)) {
    assert.match(issues(withEvidence(reference), validateAdvice), new RegExp(`claims\\.0\\.evidence\\.0: ${pattern.source}`), JSON.stringify(reference))
  }
  assert.match(issues(withEvidence('src/a.js', '../b.js'), validateAdvice), /claims\.0\.evidence\.1: path must not contain \.\./)
})

test('validateAdvice: evidence cannot point at protected files', {
  // fixed: 'BUG (minor, defence in depth): evidence paths only go through scopeIssue (planner.js:347), so advice may cite .env, keys or credentials, which the child could never read; the verifier, whose reads are not confined (verifier.js:59-66), is then told to open them'
}, () => {
  for (const reference of ['.env:1', 'config/credentials.json:2', 'nested/.ssh/known_hosts', 'x.pem:1-3', '.npmrc', 'secret.json:1']) {
    assert.equal(validateAdvice(withEvidence(reference)).ok, false, reference)
  }
})

test('evidenceReferenceIssues: the one evidence-reference check that advice claims and the verifier report share', () => {
  for (const reference of [
    'src/a.js', 'src/a.js:12', 'src/a.js:12-30', 'src/a.js:3-3', 'docs/readme.md:1', 'src\\sub\\b.js:2', 'a b/c.js:4', '.env.example:2', 'sessions.jsonl:3',
    'src/\u{1F642}.js:1', 'src/a\u00a0b.js', 'docs/\u00e9t\u00e9/\u6f22\u5b57.md:2',
  ]) {
    assert.deepEqual(evidenceReferenceIssues(reference), [], reference)
  }
  const UNSAFE = 'path must not contain control, format or line separator characters, or unpaired surrogates'
  const GRAMMAR = 'must be a workspace-relative path with optional :line or :start-end'
  const table = [
    // C1 controls, bidi controls, zero-width and other format characters, tags, and unpaired surrogates.
    ['src/a\u0085b.js', [UNSAFE]],
    ['src/a\u009bb.js:1', [UNSAFE]],
    ['src/\u202eb.js', [UNSAFE]],
    ['src/a\u2066b.js:2', [UNSAFE]],
    ['src/a\u061cb.js', [UNSAFE]],
    ['src/a\u200b.js', [UNSAFE]],
    ['src/a\u200db.js', [UNSAFE]],
    ['src/a\u2060b.js', [UNSAFE]],
    ['src/a\ufeffb.js', [UNSAFE]],
    ['src/a\u00adb.js', [UNSAFE]],
    ['src/a\u{E0041}b.js', [UNSAFE]],
    ['src/a\ud800b.js', [UNSAFE]],
    ['src/a\udc00b.js:3', [UNSAFE]],
    ['src/a\u200b.js:0', [UNSAFE, 'lines start at 1']],
    // Rejected before, with their messages unchanged.
    ['src/a\u2028b.js', [GRAMMAR]],
    ['src/a\u2029b.js:1', [GRAMMAR]],
    ['src/a\u200b.js ', [GRAMMAR]],
    ['src/a\u0007b.js', ['path must not contain control characters']],
    ['nested/.ssh/known\u200bhosts', ['path reaches a protected file (.ssh)']],
    ['../a\u202e.js', ['path must not contain ..']],
    ['/etc/passwd:1', ['path must be workspace-relative']],
    ['C:\\x.js:1', ['path must be workspace-relative']],
    ['../x.js:1', ['path must not contain ..']],
    ['.git/config:1', ['path must not touch .git']],
    ['src/*.js:1', ['path must be a path prefix, not a glob']],
    ['~/x.js', ['path must not start with ~']],
    ['.:3', ['path must not be the workspace root']],
    ['a\u0000b.js:1', ['path must not contain control characters']],
    ['', ['must be a workspace-relative path with optional :line or :start-end']],
    [' src/a.js', ['must be a workspace-relative path with optional :line or :start-end']],
    ['src/a.js:0', ['lines start at 1']],
    ['src/a.js:5-3', ['line range must not run backwards']],
    ['.env:1', ['path reaches a protected file (.env)']],
    ['config/credentials.json:2', ['path reaches a protected file (credentials.json)']],
    ['nested/.ssh/known_hosts', ['path reaches a protected file (.ssh)']],
    ['x.pem:1-3', ['path reaches a protected file (x.pem)']],
    [undefined, ['must be a workspace-relative path with optional :line or :start-end']],
    [12, ['must be a workspace-relative path with optional :line or :start-end']],
  ]
  for (const [reference, expected] of table) {
    assert.deepEqual(evidenceReferenceIssues(reference), expected, JSON.stringify(reference))
    if (typeof reference !== 'string') continue
    // validateAdvice reports exactly these issues, each under its claim and reference.
    assert.deepEqual(validateAdvice(withEvidence(reference)).issues, expected.map((issue) => `claims.0.evidence.0: ${issue}`), JSON.stringify(reference))
  }
})

test('ADVICE_PARAMETERS: stays in the enforced subset and agrees with validateAdvice on structure', () => {
  const accepted = [advice(), advice({ options: [], risks: [], do_not_build: [], claims: [], open_questions: ['Which owner?'] })]
  for (const fixture of accepted) {
    const result = validateAdvice(fixture)
    assert.equal(result.ok, true, result.issues?.join('\n'))
    assert.deepEqual(schemaErrors(ADVICE_PARAMETERS, fixture), [])
    assert.deepEqual(schemaErrors(ADVICE_PARAMETERS, result.advice), [])
  }
  const base = advice()
  const option = base.options[0]
  const claim = base.claims[0]
  const structural = {
    'root is an array': [base],
    'root is null': null,
    ...Object.fromEntries(Object.keys(base).map((key) => [`missing ${key}`, omit(base, key)])),
    'extra root property': { ...base, verdict: 'ship' },
    'question is a number': { ...base, question: 1 },
    'options is an object': { ...base, options: { a: option } },
    'option is a string': { ...base, options: ['A'] },
    'option misses tradeoffs': { ...base, options: [omit(option, 'tradeoffs')] },
    'option extra property': { ...base, options: [{ ...option, score: 1 }] },
    'unknown verdict': { ...base, options: [{ ...option, verdict: 'maybe' }] },
    'risks holds a number': { ...base, risks: [1] },
    'do_not_build is a string': { ...base, do_not_build: 'x' },
    'claim is a string': { ...base, claims: ['c'] },
    'claim misses evidence': { ...base, claims: [omit(claim, 'evidence')] },
    'claim extra property': { ...base, claims: [{ ...claim, confidence: 1 }] },
    'evidence is a string': { ...base, claims: [{ ...claim, evidence: 'src/a.js' }] },
    'evidence holds a number': { ...base, claims: [{ ...claim, evidence: [12] }] },
    'open_questions holds an object': { ...base, open_questions: [{}] },
  }
  for (const [label, fixture] of Object.entries(structural)) {
    assert.equal(validateAdvice(fixture).ok, false, `validateAdvice: ${label}`)
    assert.notDeepEqual(schemaErrors(ADVICE_PARAMETERS, fixture), [], `ADVICE_PARAMETERS: ${label}`)
  }
  const opt = (name, verdict) => ({ name, verdict, tradeoffs: 't' })
  const semantic = [
    advice({ options: [opt('A', 'recommended'), opt('B', 'recommended')] }),
    advice({ options: [opt('A', 'viable'), opt('a', 'viable')] }),
    advice({ options: Array.from({ length: 9 }, (_, i) => opt(`O${i}`, 'viable')) }),
    advice({ claims: [{ claim: 'c', evidence: [] }] }),
    withEvidence('../x.js:1'),
    withEvidence('src/a.js:0'),
    advice({ question: ' ' }),
  ]
  for (const fixture of semantic) {
    assert.equal(validateAdvice(fixture).ok, false)
    assert.deepEqual(schemaErrors(ADVICE_PARAMETERS, fixture), [])
  }
})

// ===========================================================================
// 2. plannerPathDenial, plannerPathAllowed and confinedGrep

test('paths: read stays inside the realpath of the workspace, resolved against cwd', () => {
  for (const file of ['src/a.js', path.join(WS, 'src/a.js'), './src/a.js', 'new/dir/file.js', 'src/new.js', 'docs/readme.md', 'out-link/canary.txt']) {
    assert.equal(deny('read', { file_path: file }), undefined, file)
  }
  for (const file of ['../outside/canary.txt', path.join(OUT, 'canary.txt'), '/etc/hosts', '..', '~', '~/.zshrc', 'link-out', 'link-out/canary.txt', 'link-out/new.txt', 'link-file-out']) {
    assert.match(deny('read', { file_path: file }), /file_path must stay inside the workspace/, file)
  }
  const src = path.join(WS, 'src')
  assert.equal(deny('read', { file_path: 'a.js' }, src), undefined)
  assert.equal(deny('read', { file_path: 'sub/b.js' }, src), undefined)
  assert.match(deny('read', { file_path: 'out-link/canary.txt' }, src), /inside the workspace/, 'relative paths resolve against cwd, not the root')
  for (const value of [undefined, null, '']) assert.match(deny('read', { file_path: value }), /file_path is required/)
  assert.match(deny('read', {}), /file_path is required/)
  assert.match(deny('read', { file_path: 42 }), /file_path must be a path string/)
  assert.match(deny('read', { file_path: 'src/a\u0000.js' }), /file_path must be a path string/)
  assert.match(deny('read', { file_path: 'src/a\n.js' }), /file_path must be a path string/)
  for (const args of [null, [], 'src/a.js', undefined]) {
    assert.match(plannerPathDenial({ name: 'read', arguments: args }, WS), /arguments must be an object/)
  }
  for (const name of [SUBMIT_TOOL, ADVICE_TOOL]) assert.equal(plannerPathDenial({ name, arguments: 'anything' }, WS), undefined, name)
})

test('evidence: the OS and ripgrep resolve <symlink>/.. physically, outside the workspace', () => {
  // String concatenation on purpose: path.join would normalize the .. lexically.
  assert.equal(readFileSync(`${WS}/a/L/../canary.txt`, 'utf8'), 'FAKE_OUTSIDE_CANARY\n')
  if (RG !== undefined) assert.deepEqual(pathsOf(rgMatches(['--regexp=FAKE_OUTSIDE', '--glob=*.txt', '--', 'a/L/..'])), ['a/L/../canary.txt'])
})

test('paths: any ".." segment or leading ~ in read, grep and glob paths is denied', () => {
  const traversal = ['..', '../x', 'a/L/../canary.txt', `${WS}/a/L/../canary.txt`, 'src/../src/a.js', 'src/..', 'a\\..\\b', '~', '~/x', '~root/x']
  for (const value of traversal) {
    assert.match(deny('read', { file_path: value }), /file_path must stay inside the workspace without "\.\."/, value)
    assert.match(deny('grep', { pattern: 'x', path: value }), /path must stay inside the workspace without "\.\."/, value)
    assert.match(deny('glob', { pattern: '*', path: value }), /path must stay inside the workspace without "\.\."/, value)
  }
  for (const value of ['..foo', 'foo..', 'a/..b/c', '...']) assert.equal(deny('read', { file_path: value }), undefined, `${value} is a name, not a parent`)
})

test('paths: protected files and directories are denied; env templates are not', () => {
  const protectedFiles = [
    '.env', '.env.local', '.ENV', 'deep/dir/.env.production', 'id_rsa', 'id_ed25519.pub', 'x.pem', 'certs/tls.KEY',
    '.npmrc', '.git', '.git/config', 'nested/.ssh', 'nested/.ssh/known_hosts', 'config/credentials.json',
    'secrets.yaml', 'prod.tfvars', 'link-env',
  ]
  for (const file of protectedFiles) assert.match(deny('read', { file_path: file }), /reaches a protected file or directory/, file)
  for (const file of ['.env.example', '.env.sample', 'src/environment.js', 'docs/pem-format.md', 'gitconfig.md']) {
    assert.equal(deny('read', { file_path: file }), undefined, file)
  }
  assert.equal(protectedSegment('src/.git/hooks/x'), '.git')
  assert.equal(protectedSegment('.env.example'), undefined)
})

test('paths: glob patterns and grep includes cannot name parents, absolute or home paths, or .git', () => {
  const forms = [['glob', 'pattern', (value) => ({ pattern: value })], ['grep', 'include', (value) => ({ pattern: 'x', include: value })]]
  for (const [name, field, args] of forms) {
    for (const value of ['../**', 'src/../../x', '..', '{..,src}/*.js', '{src,..}/*.js', 'x,../y', '/etc/*', '/**', '~/x', '~']) {
      assert.match(deny(name, args(value)), new RegExp(`^${field} must stay inside the workspace`), `${name} ${value}`)
    }
    for (const value of ['.git/**', 'a/.git/x', '.GIT/HEAD', '{.git,config}', '{config,.GIT}', 'x,.git']) {
      assert.match(deny(name, args(value)), new RegExp(`^${field} must not reach \\.git`), `${name} ${value}`)
    }
    for (const value of [5, {}, 'a\u0000']) assert.match(deny(name, args(value)), new RegExp(`^${field} must be a glob string`), `${name} ${JSON.stringify(value)}`)
  }
  for (const pattern of ['**/*.js', 'src/**/*.ts', '*.md', '**/.env*']) assert.equal(deny('glob', { pattern }), undefined, pattern)
  for (const include of [undefined, null, '', '*', '**', '*.*', '.*', '.env*', '*.pem', '*.{js,ts,md}', '*.json', '.e\\nv', '{.gi[t],config}']) {
    assert.equal(deny('grep', { pattern: 'x', include }), undefined, `include ${String(include)} is allowed; confinedGrep filters the results`)
  }
  assert.equal(deny('glob', { pattern: '*.js', path: 'src' }), undefined)
  assert.equal(deny('grep', { pattern: 'x', path: 'src' }), undefined)
  for (const dir of ['/etc', OUT, 'link-out', '.git', 'nested/.ssh']) assert.notEqual(deny('glob', { pattern: '*', path: dir }), undefined, dir)
  for (const dir of [OUT, 'link-out', '.git', 'nested/.ssh', 'x.pem', '.env']) assert.notEqual(deny('grep', { pattern: 'x', path: dir }), undefined, dir)
})

test('paths: any other tool is denied', () => {
  for (const name of ['bash', 'write', 'edit', 'send_message', 'subagent', 'web_fetch', 'Read', 'read_image']) {
    assert.match(deny(name, {}), /^Advisor child is read-only: this tool is not permitted\.$/, name)
  }
})

// Paths a grep result may report, relative to the workspace root.
const KEPT_MATCHES = ['src/a.js', 'docs/readme.md', '.env.example', path.join(WS, 'src/sub/b.js'), 'config/settings.json', 'src/sub/b.js']
const DROPPED_MATCHES = [
  '.env', 'deep/.env.local', '.ENV', 'config/credentials.json', '.git/config', '.GIT/HEAD', 'secret.json', 'x.pem',
  'infra.tfstate', 'key.asc', 'id_rsa', 'nested/.ssh/known_hosts', 'link-env', 'link-out/canary.txt', 'link-file-out',
  path.join(OUT, 'canary.txt'), '../outside/canary.txt', 'a/L/../canary.txt', '~/x', '/etc/hosts', '', 'src/a\u0000.js', 'src/a\n.js',
]

test('plannerPathAllowed: inside the realpath of the workspace, unprotected, and never through ..', () => {
  for (const value of KEPT_MATCHES) assert.equal(plannerPathAllowed(value, WS), true, value)
  for (const value of [...DROPPED_MATCHES, 42, undefined, null, {}]) assert.equal(plannerPathAllowed(value, WS), false, JSON.stringify(value))
  const src = path.join(WS, 'src')
  assert.equal(plannerPathAllowed('sub/b.js', WS, src), true)
  assert.equal(plannerPathAllowed('out-link/canary.txt', WS, src), false)
  assert.equal(plannerPathAllowed('out-link/canary.txt', WS, WS), true, 'resolved against cwd: WS/out-link does not exist')
})

test('confinedGrep: keeps the Host definition and drops matches in protected or outside files', async () => {
  const calls = []
  const matches = [...KEPT_MATCHES, ...DROPPED_MATCHES].map((value, index) => ({ path: value, lineNumber: index + 1, line: `line ${index}` }))
  matches.push({ path: 42, lineNumber: 1, line: 'number path' }, { lineNumber: 1, line: 'no path' }, null)
  const base = {
    name: 'grep',
    description: 'Search file contents.',
    parameters: { type: 'object' },
    output: { schema: { type: 'object' }, render: () => [], presentationMeta: () => ({}) },
    timeoutMs: 1000,
    isConcurrencySafe: () => true,
    presentCall: () => undefined,
    presentResult: () => undefined,
    projectContent: () => undefined,
    async execute(args, exec) {
      calls.push([args, exec])
      return { matches, note: 'kept' }
    },
  }
  const grep = confinedGrep(base, WS, WS)
  for (const key of ['name', 'parameters', 'output', 'timeoutMs', 'isConcurrencySafe', 'presentCall', 'presentResult', 'projectContent']) {
    assert.equal(grep[key], base[key], key)
  }
  assert.equal(grep.description, 'Search file contents. Matches in protected files are withheld.')
  const exec = { name: 'grep', arguments: { pattern: 'x' } }
  const value = await grep.execute({ pattern: 'x' }, exec)
  assert.deepEqual(calls, [[{ pattern: 'x' }, exec]], 'arguments and exec pass through unchanged')
  assert.equal(value.note, 'kept')
  assert.deepEqual(value.matches.map((match) => match.path), KEPT_MATCHES)
  assert.deepEqual(value.matches[0], { path: 'src/a.js', lineNumber: 1, line: 'line 0' })

  const inSrc = confinedGrep({ ...base, execute: async () => ({ matches: [{ path: 'sub/b.js' }, { path: 'out-link/canary.txt' }, { path: 'a.js' }] }) }, WS, path.join(WS, 'src'))
  assert.deepEqual((await inSrc.execute({}, {})).matches.map((match) => match.path), ['sub/b.js', 'a.js'])
  for (const returned of [undefined, null, {}, { matches: 'x' }]) {
    const odd = confinedGrep({ ...base, execute: async () => returned }, WS, WS)
    assert.deepEqual((await odd.execute({}, {})).matches, [], JSON.stringify(returned))
  }
  const failing = confinedGrep({ ...base, execute: async () => { throw new Error('rg failed') } }, WS, WS)
  await assert.rejects(failing.execute({}, {}), /rg failed/)
})

test('evidence: includes that make ripgrep select protected files yield no matches through confinedGrep', {
  skip: RG === undefined && 'ripgrep (rg) is not on PATH',
}, async () => {
  const selected = {
    '.e\\nv': ['.env'], // backslash escape
    '*.p\\em': ['x.pem'],
    '.env.development': ['.env.development'],
    '*.tfstate': ['infra.tfstate'],
    '*.asc': ['key.asc'],
    'secret.*': ['secret.json'],
    '{.gi[t],config}': ['.git/config'], // passes the include check, still whitelists the hidden .git
    '*.json': ['config/credentials.json', 'secret.json'],
    '*': Object.keys(PROTECTED_FIXTURES).sort(), // override globs also select hidden files
  }
  for (const [include, files] of Object.entries(selected)) {
    assert.equal(deny('grep', { pattern: 'FAKE_SECRET', include }), undefined, `the guard allows ${include}`)
    const raw = rgMatches(['--regexp=FAKE_SECRET', `--glob=${include}`])
    assert.deepEqual(pathsOf(raw), files, `ripgrep selects ${include}`)
    const grep = confinedGrep({ name: 'grep', description: 'grep', execute: async () => ({ matches: raw }) }, WS, WS)
    assert.deepEqual((await grep.execute({ pattern: 'FAKE_SECRET', include }, {})).matches, [], include)
  }
  const kept = rgMatches(['--regexp=export', '--glob=*.js'])
  const grep = confinedGrep({ name: 'grep', description: 'grep', execute: async () => ({ matches: kept }) }, WS, WS)
  assert.deepEqual(pathsOf((await grep.execute({}, {})).matches), ['src/a.js'])
})

// ===========================================================================
// 3. sessionUsage

test('sessionUsage: unavailable logs give null input/output tokens', () => {
  const unavailable = [
    undefined,
    {},
    { session: {} },
    { session: { ownEvents: () => { throw new Error('log closed') } } },
    { session: { ownEvents: () => undefined } },
    { session: { ownEvents: () => new Set() } },
    { get session() { throw new Error('disposed') } },
  ]
  for (const agent of unavailable) assert.deepEqual(sessionUsage(agent), { input_tokens: null, output_tokens: null })
  assert.deepEqual(sessionUsage(agentWith([])), USAGE_ZERO)
})

test('sessionUsage: sums message usage, skips other events and absent usage, and zeroes non-numeric fields', () => {
  const events = [
    { type: 'assistant/message', data: { usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 5, reasoningTokens: 7 } } },
    { type: 'assistant/message', data: { usage: { inputTokens: 50, outputTokens: 10 } } },
    { type: 'assistant/message', data: { usage: { inputTokens: 'many', outputTokens: null, cacheReadTokens: {}, reasoningTokens: Number.NaN } } },
    { type: 'assistant/message', data: {} },
    { type: 'assistant/message', data: { usage: null } },
    { type: 'tool/result', data: { usage: { inputTokens: 999, outputTokens: 999 } } },
    { type: 'user/message', data: { usage: { inputTokens: 999 } } },
    null,
    'garbage',
  ]
  assert.deepEqual(sessionUsage(agentWith(events)), {
    input_tokens: 150, output_tokens: 30, cache_read_tokens: 80, cache_write_tokens: 5, reasoning_tokens: 7, model_requests: 3,
  })
})

test('sessionUsage: retried attempts count with the usage kept in their stream', {
  // fixed: 'BUG: sessionUsage reads only event.data.usage (planner.js:511), but DSH appends assistant/attempt as { turn, step, stream } and keeps a retried attempt\'s usage in its stream (dsh-agent-loop; dsh-headless sums streamUsage(event.data.stream)), so retries are never counted'
}, () => {
  const events = [
    { type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [usageChunk({ inputTokens: 100, outputTokens: 5 })] } },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: {}, usage: { inputTokens: 120, outputTokens: 40 }, stream: [] } },
  ]
  const usage = sessionUsage(agentWith(events))
  assert.deepEqual([usage.input_tokens, usage.output_tokens, usage.model_requests], [220, 45, 2])
})

test('sessionUsage: negative, non-finite and boolean token counts are ignored', {
  // fixed: 'BUG (minor): Number(x) || 0 (planner.js:514-518) adds negative counts, turns Infinity into a total that JSON writes as null, and counts true as 1'
}, () => {
  const events = [
    { type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 5 } } },
    { type: 'assistant/message', data: { usage: { inputTokens: -100, outputTokens: Number.POSITIVE_INFINITY, cacheReadTokens: true } } },
  ]
  const usage = JSON.parse(JSON.stringify(sessionUsage(agentWith(events))))
  assert.deepEqual([usage.input_tokens, usage.output_tokens, usage.cache_read_tokens], [10, 5, 0])
})

// ===========================================================================
// 4. installPlannerBoundary: delegation and the host guard

test('delegation: only a well-formed subagent call from the root lead passes, for either kind', (t) => {
  const h = harness()
  t.after(h.dispose)
  for (const name of [PLANNER, CONSULT]) {
    for (const tool of ['subagent_fork', 'subagent_claude_code', 'subagent_codex']) {
      assert.match(h.delegate({ name }, { tool }), /^Advisor children require the fresh in-process subagent tool\.$/, `${tool} ${name}`)
    }
  }
  const malformed = [
    'advisor-planner', 'advisor-planner-', 'advisor-planner-ABCDEF012345', 'advisor-planner-abcdef01234',
    'advisor-planner-abcdef0123456', 'advisor-planner-abcdef01234g', `${PLANNER}-x`,
    'advisor-consult', 'advisor-consult-', 'advisor-consult-ABCDEF012345', `${CONSULT}-x`,
  ]
  for (const name of malformed) assert.match(h.delegate({ name }), /must be advisor-planner-<id> or advisor-consult-<id> with a 12 lowercase hex id/, name)
  for (const args of [{ reasoning_effort: 'high' }, { reasoning_effort: null }, { agent_preset: 'planner' }, { name: CONSULT, agent_preset: 'x' }]) {
    assert.equal(h.delegate(args), CHILD_MUST_OMIT, JSON.stringify(args))
  }
  for (const name of [PLANNER, CONSULT]) {
    assert.match(h.delegate({ name }, { agent: h.mate }), /^Only the lead can start an advisor child\.$/)
    assert.match(h.delegate({ name }, { agent: undefined }), /^Only the lead can start an advisor child\.$/)
  }
  h.lead.rootThrows = true
  assert.match(h.delegate(), /Only the lead can start an advisor child/)
  h.lead.rootThrows = false
  assert.equal(h.delegate({ name: CONSULT }), undefined)
})

test('delegation: Advisor must be on and Agent Teams enabled; Advisor on is enough', (t) => {
  const h = harness()
  t.after(h.dispose)
  for (const settings of [undefined, {}, { active: false, advisorModel: null }, { active: 'yes', advisorModel: null }]) {
    h.state.settings = settings
    assert.match(h.delegate(), /^Advisor is off for this session; enable Advisor first\.$/, JSON.stringify(settings))
  }
  h.state.settings = { active: true }
  h.state.teams = false
  assert.match(h.delegate({ name: CONSULT }), /Agent Teams must be enabled before starting an advisor child/)
  h.state.teams = true
  assert.equal(h.delegate({ name: CONSULT }), undefined, 'an absent advisorModel means Inherit')
})

test('delegation: a selected Advisor model needs the exact, currently authorized route; Inherit forbids overrides', (t) => {
  for (const name of [PLANNER, CONSULT]) {
    const h = harness()
    t.after(h.dispose)
    h.state.settings = { active: true, advisorModel: ROUTE }
    const selected = new RegExp(`^Advisor children must use the selected Advisor model ${escapeRegExp(`${ROUTE.provider}/${ROUTE.model}`)}\\.$`)
    for (const args of [{}, { provider: ROUTE.provider }, { model: ROUTE.model }, { provider: ROUTE.provider, model: 'other' }, { provider: OTHER_ROUTE.provider, model: ROUTE.model }]) {
      assert.match(h.delegate({ name, ...args }), selected, `${name} ${JSON.stringify(args)}`)
    }
    h.state.routes = [OTHER_ROUTE]
    assert.match(h.delegate({ name, ...ROUTE }), /is no longer authorized for this session; choose another with \/advisor model/)
    h.state.routes = null
    assert.match(h.delegate({ name, ...ROUTE }), /is no longer authorized for this session/)
    h.state.routes = [OTHER_ROUTE, ROUTE]
    assert.equal(h.delegate({ name, ...ROUTE }), undefined)

    const inherit = harness()
    t.after(inherit.dispose)
    assert.match(inherit.delegate({ name, provider: ROUTE.provider }), /^Advisor model is Inherit; omit provider and model instead of overriding them\.$/)
    assert.match(inherit.delegate({ name, model: ROUTE.model }), /^Advisor model is Inherit/)
    assert.equal(inherit.delegate({ name }), undefined)
  }
})

/** The denial while an effort is stored and a delegation does not pass it with the exact route. */
const advisorEffortDenial = (route) => `Advisor children must use the selected Advisor model ${route.provider}/${route.model} with reasoning_effort "${route.effort}". Do not omit or change the effort; the user can reset it with /advisor model ${route.provider}/${route.model}.`
/** The agent_preset denial while an effort is stored: it must not say to omit reasoning_effort. */
const advisorPresetDenial = (route) => `Advisor children must omit agent_preset and use the selected Advisor model ${route.provider}/${route.model} with reasoning_effort "${route.effort}". Do not omit or change the effort; the user can reset it with /advisor model ${route.provider}/${route.model}.`
const ADVISOR_TEXTS = Object.freeze({
  mustOmit: CHILD_MUST_OMIT,
  inherit: 'Advisor model is Inherit; omit provider and model instead of overriding them.',
  wrongRoute: (route) => `Advisor children must use the selected Advisor model ${route.provider}/${route.model}.`,
  effortRequired: advisorEffortDenial,
  presetRequired: advisorPresetDenial,
})
// Every state of a model setting, with a model id that contains a space and an effort id in mixed case.
const SETTINGS = Object.freeze([null, ROUTE, ROUTE_EFFORT, Object.freeze({ provider: 'p', model: 'my model', effort: 'HiGh' })])
const SETTING_ROUTES = Object.freeze([ROUTE, OTHER_ROUTE, Object.freeze({ provider: 'p', model: 'my model' })])

/**
 * The spawn arguments a lead takes from one model policy sentence: none for
 * Inherit; else the provider and model of its label, plus reasoning_effort
 * when it says pass reasoning_effort "<id>".
 */
function argsFromPolicy(policy, heading) {
  const match = new RegExp(`^${heading}: (.+?)\\. (?:Pass exactly this provider and model|For advisor-planner|Omit provider)`).exec(policy)
  assert.ok(match !== null, policy)
  if (/omit provider, model, reasoning_effort, and agent_preset/i.test(policy)) return {}
  const label = parseModelSetting(match[1])
  const quoted = /pass reasoning_effort "([^"]*)"/.exec(policy)
  assert.equal(quoted?.[1], label.effort, `the label and the instruction name the same effort: ${policy}`)
  if (quoted === null) assert.match(policy, /omit reasoning_effort and agent_preset/)
  return quoted === null
    ? { provider: label.provider, model: label.model }
    : { provider: label.provider, model: label.model, reasoning_effort: quoted[1] }
}

/** Single deviations from the spawn arguments a setting requires, each with the denial it must get. */
function spawnDeviations(setting, { mustOmit, inherit, wrongRoute, effortRequired, presetRequired }) {
  const expected = spawnArgs(setting) ?? {}
  const stored = setting?.effort
  const effortText = stored === undefined ? mustOmit : effortRequired(setting)
  // The old agent_preset text says to omit reasoning_effort: only right without a stored effort.
  const presetText = stored === undefined ? mustOmit : presetRequired(setting)
  const cases = [
    ['agent_preset added', { ...expected, agent_preset: 'planner' }, presetText],
    ['agent_preset with another effort', { ...expected, agent_preset: 'planner', reasoning_effort: 'low' }, presetText],
    ['agent_preset without the route', { agent_preset: 'planner' }, presetText],
    ['reasoning_effort null', { ...expected, reasoning_effort: null }, effortText],
    ['reasoning_effort empty', { ...expected, reasoning_effort: '' }, effortText],
  ]
  if (stored === undefined) {
    cases.push(['reasoning_effort added', { ...expected, reasoning_effort: 'high' }, mustOmit])
  } else {
    cases.push(
      ['reasoning_effort removed', omit(expected, 'reasoning_effort'), effortText],
      ['reasoning_effort changed', { ...expected, reasoning_effort: 'low' }, effortText],
      ['reasoning_effort case-changed', { ...expected, reasoning_effort: stored.toUpperCase() }, effortText],
      ['reasoning_effort lower-cased', { ...expected, reasoning_effort: stored.toLowerCase() === stored ? `${stored}x` : stored.toLowerCase() }, effortText],
      ['reasoning_effort padded', { ...expected, reasoning_effort: ` ${stored}` }, effortText],
    )
  }
  if (setting === null) {
    cases.push(
      ['provider added', { provider: ROUTE.provider }, inherit],
      ['model added', { model: ROUTE.model }, inherit],
      ['route added', { ...ROUTE }, inherit],
    )
  } else {
    const routeText = stored === undefined ? wrongRoute(setting) : effortRequired(setting)
    cases.push(
      ['provider changed', { ...expected, provider: OTHER_ROUTE.provider }, routeText],
      ['model changed', { ...expected, model: 'other' }, routeText],
      ['provider removed', omit(expected, 'provider'), routeText],
      ['model removed', omit(expected, 'model'), routeText],
      ['everything omitted', {}, routeText],
    )
  }
  return cases
}

test('delegation: in every Advisor model state the policy\'s own spawn arguments pass and every single deviation is denied', (t) => {
  for (const setting of SETTINGS) {
    for (const name of [PLANNER, CONSULT]) {
      const label = `${name} ${JSON.stringify(setting)}`
      const h = harness()
      t.after(h.dispose)
      h.state.settings = { active: true, advisorModel: setting }
      h.state.routes = [...SETTING_ROUTES]
      const args = argsFromPolicy(advisorModelPolicy(setting), 'Advisor model')
      assert.deepEqual(args, spawnArgs(setting) ?? {}, label)
      for (const [deviation, changed, denial] of spawnDeviations(setting, ADVISOR_TEXTS)) {
        assert.equal(h.delegate({ name, ...changed }), denial, `${label}: ${deviation}`)
      }
      assert.equal(h.delegate({ name, ...args }), undefined, `${label}: the policy's own arguments pass`)
    }
  }
})

test('delegation: agent_preset is refused first, with the old text only without a stored effort; an effort is checked after the lead and Advisor-on checks', (t) => {
  const h = harness()
  t.after(h.dispose)
  h.state.settings = { active: true, advisorModel: ROUTE_EFFORT }
  assert.equal(h.delegate({ ...spawnArgs(ROUTE_EFFORT), agent_preset: 'x' }, { agent: h.mate }), advisorPresetDenial(ROUTE_EFFORT), 'before the lead check')
  assert.equal(h.delegate({ agent_preset: 'x' }), advisorPresetDenial(ROUTE_EFFORT))
  assert.doesNotMatch(advisorPresetDenial(ROUTE_EFFORT), /omit reasoning_effort/)
  assert.ok(advisorPresetDenial(ROUTE_EFFORT).includes(`${ROUTE.provider}/${ROUTE.model} with reasoning_effort "high"`))
  assert.ok(advisorPresetDenial(ROUTE_EFFORT).includes(`/advisor model ${ROUTE.provider}/${ROUTE.model}.`))
  for (const advisorModel of [null, ROUTE]) {
    h.state.settings = { active: true, advisorModel }
    assert.equal(h.delegate({ ...spawnArgs(advisorModel), agent_preset: 'x' }, { agent: h.mate }), CHILD_MUST_OMIT, `${JSON.stringify(advisorModel)}: the old text, byte for byte`)
  }
  h.state.settings = { active: true, advisorModel: ROUTE_EFFORT }
  assert.equal(h.delegate({ ...ROUTE }, { agent: h.mate }), 'Only the lead can start an advisor child.')
  h.state.settings = { active: false, advisorModel: ROUTE_EFFORT }
  assert.equal(h.delegate({ ...ROUTE, reasoning_effort: 'low' }), 'Advisor is off for this session; enable Advisor first.')
  h.state.settings = { active: true, advisorModel: ROUTE_EFFORT }
  assert.equal(h.delegate({ ...ROUTE }), advisorEffortDenial(ROUTE_EFFORT))
  assert.ok(advisorEffortDenial(ROUTE_EFFORT).includes('reasoning_effort "high"') && advisorEffortDenial(ROUTE_EFFORT).includes(`/advisor model ${ROUTE.provider}/${ROUTE.model}`))
  // The authorization check still compares provider and model only.
  h.state.routes = [OTHER_ROUTE]
  assert.match(h.delegate({ ...spawnArgs(ROUTE_EFFORT) }), /is no longer authorized for this session; choose another with \/advisor model/)
  h.state.routes = [ROUTE]
  assert.equal(h.delegate({ ...spawnArgs(ROUTE_EFFORT) }), undefined)
})

test('delegation: used ids are refused; one advisor child of either kind per root, with a 60 s start reservation', async (t) => {
  const h = harness()
  t.after(h.dispose)
  h.state.used.add(PLAN_ID)
  assert.match(h.delegate(), /^id abcdef012345 is already used in the ledger or replies; generate a new one\.$/)
  assert.match(h.delegate({ name: CONSULT }), /id abcdef012345 is already used/)
  h.state.used.delete(PLAN_ID)

  assert.equal(h.delegate(), undefined, 'reserves PLAN_ID')
  assert.equal(h.delegate(), undefined, 'a retry of the reserved child stays allowed')
  assert.match(h.delegate({ name: PLANNER_B }), /^Another advisor child is starting for this session; only one may run at a time\.$/)
  assert.match(h.delegate({ name: CONSULT_B }), /Another advisor child is starting/, 'the reservation covers both kinds')
  h.state.clock += 59_999
  assert.match(h.delegate({ name: CONSULT_B }), /Another advisor child is starting/)
  h.state.clock += 1
  assert.equal(h.delegate({ name: CONSULT_B }), undefined, 'the reservation expires after 60 s')

  const b = h.child({ id: 'consult-b', self: CONSULT_B })
  h.start(b)
  assert.deepEqual(h.boundary.livePlanners.get(h.lead.id), { planId: PLAN_ID_B, agentId: 'consult-b', name: CONSULT_B })
  assert.match(h.delegate(), /^Advisor child advisor-consult-0123456789ab is still running; only one advisor child may run at a time\.$/)
  assert.match(h.delegate({ name: PLANNER_B }), /is still running/)
  h.end(b)
  await settle()
  assert.match(h.delegate({ name: PLANNER_B }), /already used/, 'a consult id cannot come back as a plan id')
  assert.match(h.delegate({ name: CONSULT_B }), /already used/)
  assert.equal(h.delegate(), undefined)
})

test('delegation: an id reserved by one kind cannot be reused by the other kind', {
  // fixed: 'BUG: the reservation exemption is keyed by id only (planner.js:751, 754); while advisor-planner-<id> is reserved, advisor-consult-<id> skips both the one-at-a-time check and idInUse, so two children with one id can start in parallel'
}, (t) => {
  const h = harness()
  t.after(h.dispose)
  assert.equal(h.delegate(), undefined)
  assert.match(h.delegate({ name: CONSULT }) ?? 'ALLOWED', /already used|is starting|is reserved/)
})

test('start: a child whose id is held by a running child of the other kind is refused', {
  // fixed: 'BUG: subagent/start does not check whether another open record already holds the id (planner.js:963-974); advisor-consult-<id> runs beside advisor-planner-<id>, and both write terminal lines under one consult_id with different kinds'
}, async (t) => {
  const h = harness()
  t.after(h.dispose)
  startChild(h)
  await settle()
  const consult = h.child({ id: 'consult-1', self: CONSULT })
  h.start(consult)
  assert.equal(consult.agent.cancelled, 1)
})

test('delegation: a failed start consumes its id and frees the start reservation', async (t) => {
  const h = harness()
  t.after(h.dispose)
  h.state.settings = { active: true, advisorModel: ROUTE }
  assert.equal(h.delegate({ ...ROUTE }), undefined)
  const c = h.child({ route: OTHER_ROUTE }) // spawned on another route
  h.start(c)
  h.end(c)
  await settle()
  assert.deepEqual(h.statuses(), ['failed'])
  assert.match(h.delegate({ ...ROUTE }), /already used/)
  assert.equal(h.delegate({ ...ROUTE, name: CONSULT_B }), undefined)
})

test('delegation: an invalid reserved child takes no slot and consumes its id', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const stray = h.child({ self: CONSULT, parent: 'mate' }) // e.g. a grandchild that slipped past delegation
  h.start(stray)
  assert.equal(stray.agent.cancelled, 1)
  assert.equal(h.boundary.livePlanners.size, 0, 'no slot while the invalid child is still resident')
  await settle()
  assert.match(h.delegate({ name: CONSULT }), /already used/)
  assert.equal(h.delegate({ name: PLANNER_B }), undefined)
})

test('host guard: advisor children cannot be messaged and unknown advisor-* children are refused', (t) => {
  const h = harness()
  t.after(h.dispose)
  for (const agent of [PLANNER, CONSULT, `lead/${PLANNER}`, `x/${CONSULT}`, 'advisor-planner', 'advisor-consult', 'advisor-consult-zzz']) {
    assert.match(h.call('send_message', { agent, message: 'hello' }), /^Advisor children do not accept messages/, agent)
  }
  assert.equal(h.call('send_message', { agent: 'reviewer', message: 'hello' }), undefined)
  for (const tool of ['subagent', 'subagent_fork', 'subagent_claude_code', 'subagent_codex']) {
    for (const name of ['advisor-foo', 'advisor-', 'advisor-plannerx', 'advisor-consultx', 'advisor-consults-abcdef012345', 'advisor-verifierx', 'advisor-verifiers-abcdef012345']) {
      assert.match(h.call(tool, { name }), /reserved for Advisor roles: advisor-planner-<id>, advisor-consult-<id>, or advisor-verifier-<id>/, `${tool} ${name}`)
    }
  }
  for (const name of ['advisor-verifier', 'advisor-verifier-abcdef012345', 'advisor-verifier-typo']) {
    assert.equal(advisorNamespaceDenial({ name: 'subagent', arguments: { name } }), undefined, `${name} is left to the verifier boundary`)
  }
  for (const name of ['advisor-verifierx', 'advisor-verifiers-abcdef012345', 'advisor-consultx']) {
    const exec = { name: 'subagent', arguments: { name } }
    assert.notEqual(advisorNamespaceDenial(exec) ?? verifierDelegationDenial(exec), undefined, `${name} cannot start an unconfined child`)
  }
  assert.equal(h.call('create_worktree', { name: 'advisor-foo' }), undefined)
  assert.equal(h.call('team_task_create', { name: 'advisor-foo' }), undefined)
  assert.equal(h.call('subagent', { name: 'reviewer' }), undefined)
  assert.equal(isDelegationTool('subagent_fork'), true)
  assert.equal(isDelegationTool('workflow'), false)
})

test('host guard: odd arguments and agents never make a guard throw', (t) => {
  const h = harness()
  t.after(h.dispose)
  for (const args of [null, undefined, 'x', 7, [], { name: 7 }, { name: null }, { agent: 7 }]) {
    for (const name of ['subagent', 'send_message', SUBMIT_TOOL, ADVICE_TOOL, 'read']) {
      assert.doesNotThrow(() => h.call(name, args), `${name} ${JSON.stringify(args)}`)
      assert.doesNotThrow(() => h.call(name, args, { agent: undefined }), `${name} ${JSON.stringify(args)} without agent`)
    }
  }
  assert.doesNotThrow(() => h.start({ agent: { id: 'ghost' } }), 'an unknown agent id is ignored')
  const c = startChild(h)
  for (const args of [null, undefined, 'x', [], { file_path: {} }, { path: [] }, { include: 5 }, { pattern: 5 }]) {
    for (const name of ['read', 'glob', 'grep']) assert.doesNotThrow(() => h.run(c, name, args), `${name} ${JSON.stringify(args)}`)
  }
})

test('guards: a throwing dependency or registry fails closed instead of throwing', async (t) => {
  const h = harness({ settingsFor: () => { throw new Error('projection unavailable') } })
  t.after(h.dispose)
  assert.match(h.delegate(), /^Advisor child guard failed closed: projection unavailable$/)

  const pinned = harness({ fileHash: () => { throw new Error('EIO') } })
  t.after(pinned.dispose)
  const c = startChild(pinned)
  await pinned.submit(c, plan())
  assert.match(pinned.call('subagent', { name: `advisor-verifier-${PLAN_ID}` }), /failed closed: EIO/)

  const broken = harness()
  t.after(broken.dispose)
  const b = startChild(broken)
  b.agent.ctx.tools.get = () => { throw new Error('registry gone') }
  assert.match(broken.run(b, 'read', { file_path: 'src/a.js' }), /^Advisor child failed closed: registry gone$/)
})

// ===========================================================================
// 4. installPlannerBoundary: start

test('start: planner child: guard first, its own submit tool and confined grep, capture, policy and inbox hook', async (t) => {
  const h = harness()
  t.after(h.dispose)
  assert.equal(h.delegate(), undefined)
  const c = h.child()
  h.start(c)
  c.sequence.push('initial-prompt')
  assert.deepEqual(c.sequence, [
    'guard', `register:${SUBMIT_TOOL}`, 'get:grep', 'register:grep',
    'get:glob', 'get:grep', 'get:read', `get:${SUBMIT_TOOL}`,
    'section', 'on:agent/inbox/inserted', 'initial-prompt',
  ])
  assert.equal(c.agent.cancelled, 0)
  assert.equal(c.guards.length, 1)
  assert.equal(c.registered.get(SUBMIT_TOOL).parameters, PLAN_PARAMETERS)
  assert.equal(c.registered.has(ADVICE_TOOL), false, 'a planner gets no advice tool')
  assert.equal(h.ctx.tools.get(SUBMIT_TOOL), undefined, 'the submit tool is registered on the child only')
  assert.equal(h.ctx.tools.get('grep'), h.hostGrep, 'the Host grep itself is untouched')
  assert.notEqual(c.registered.get('grep'), h.hostGrep)
  assert.deepEqual(c.sections, [{ name: 'advisor:planner-policy', order: 500, text: PLANNER_POLICY }])
  assert.deepEqual(h.boundary.livePlanners.get(h.lead.id), { planId: PLAN_ID, agentId: c.agent.id, name: PLANNER })
  await settle()
  assert.deepEqual(h.state.ledger, [{
    consult_id: PLAN_ID, kind: 'plan', advisor: 'dsh', caller: 'advisor-plugin', topic: 'unset',
    session_id: h.lead.id, planner_session_id: c.agent.id, cwd: WS,
    briefing_sha256: null, briefing_chars: null,
    backend: `dsh:${ROUTE.provider}/${ROUTE.model}`, model: ROUTE.model, effort: null, effort_requested: null,
    ts: Math.floor(h.state.clock / 1000), status: 'started',
  }])

  // A later residency epoch on the same Agent object: one guard, refreshed
  // registrations and section, no second started line, and submit still works.
  h.start(c)
  await settle()
  assert.deepEqual(h.statuses(), ['started'])
  assert.equal(c.guards.length, 1)
  for (const step of [`unregister:${SUBMIT_TOOL}`, 'unregister:grep', 'unsection', 'off:agent/inbox/inserted']) assert.ok(c.sequence.includes(step), step)
  assert.equal(c.sections.length, 1)
  assert.equal(c.inbox.length, 1)
  assert.notEqual(c.registered.get('grep'), h.hostGrep)
  assert.equal((await h.submit(c, plan())).plan_id, PLAN_ID)
})

test('start: consult child: its own advice tool, CONSULT_POLICY, confined grep and an advice started line', async (t) => {
  const h = harness()
  t.after(h.dispose)
  assert.equal(h.delegate({ name: CONSULT }), undefined)
  const c = h.child({ self: CONSULT })
  h.start(c)
  assert.deepEqual(c.sequence, [
    'guard', `register:${ADVICE_TOOL}`, 'get:grep', 'register:grep',
    'get:glob', 'get:grep', 'get:read', `get:${ADVICE_TOOL}`,
    'section', 'on:agent/inbox/inserted',
  ])
  assert.equal(c.registered.get(ADVICE_TOOL).parameters, ADVICE_PARAMETERS)
  assert.equal(c.registered.has(SUBMIT_TOOL), false, 'a consult child gets no plan tool')
  assert.notEqual(c.registered.get('grep'), h.hostGrep)
  assert.deepEqual(c.sections, [{ name: 'advisor:consult-policy', order: 500, text: CONSULT_POLICY }])
  assert.deepEqual(h.boundary.livePlanners.get(h.lead.id), { planId: PLAN_ID, agentId: c.agent.id, name: CONSULT })
  await settle()
  assert.deepEqual(h.state.ledger.map((line) => [line.consult_id, line.kind, line.status]), [[PLAN_ID, 'advice', 'started']])
})

test('start: a child resumed on a new Agent object gets its own guard and shuts the old object out', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const first = startChild(h)
  const second = h.child() // same id, new Agent object and ctx
  h.start(second)
  assert.equal(second.guards.length, 1)
  assert.equal(first.registered.has(SUBMIT_TOOL), false, 'registrations on the old ctx were disposed')
  assert.equal(first.sections.length, 0)
  assert.match(h.run(first, 'read', { file_path: 'src/a.js' }), /failed closed|no exact agent scope/)
  assert.equal(h.run(second, 'read', { file_path: 'src/a.js' }), undefined)
  h.agentDisposed(first) // a late disposal of the replaced object
  assert.equal(h.run(second, 'read', { file_path: 'src/a.js' }), undefined, 'the current epoch stays open')
  assert.equal((await h.submit(second, plan())).plan_id, PLAN_ID)
  await settle()
  assert.deepEqual(h.statuses(), ['started', 'ok'])
})

test('start: a cold resume writes no second started line and never reopens a finished result', async (t) => {
  for (const self of [PLANNER, CONSULT]) {
    const open = harness()
    t.after(open.dispose)
    open.state.ledger.push({ consult_id: PLAN_ID, status: 'started' })
    const c1 = open.child({ self })
    open.start(c1)
    await settle()
    assert.equal(open.state.ledger.length, 1, self)
    assert.equal(open.run(c1, 'read', { file_path: 'src/a.js' }), undefined, self)
    assert.equal(c1.agent.cancelled, 0, self)

    for (const prior of [[{ consult_id: PLAN_ID, status: 'started' }, { consult_id: PLAN_ID, status: 'failed' }], [{ consult_id: PLAN_ID, status: 'ok' }]]) {
      const h = harness()
      t.after(h.dispose)
      h.state.ledger.push(...prior)
      const c = h.child({ self })
      h.start(c)
      assert.equal(c.agent.cancelled, 1, `${self}: a finished child is stopped instead of running again`)
      assert.equal(c.registered.has(c.tool), false)
      for (const name of ['read', 'grep', 'glob', c.tool]) assert.match(h.run(c, name, { file_path: 'src/a.js', pattern: 'x' }), /failed closed/, `${self} ${name}`)
      assert.equal(h.boundary.livePlanners.size, 0)
      h.end(c)
      await settle()
      assert.deepEqual(h.state.ledger, prior, 'nothing is added')
    }
  }
})

test('start: verification lines carry no top-level consult_id, so the cold-resume, other-kind and id-in-use checks ignore them', async (t) => {
  // As the verifier boundary writes them: kind verification, the run's id under verifies only.
  const verification = (verifies, extra = {}) => ({
    kind: 'verification', schema: 'advisor-verification/1', verifies, verified_kind: 'plan', ts: 1, status: 'recorded', ...extra,
  })
  // An open run (only its started line) followed by verification lines naming its id resumes as before.
  const open = harness({ ledgerMode: 'real' })
  t.after(open.dispose)
  await open.ledger.appendLedger({ consult_id: PLAN_ID, kind: 'plan', advisor: 'dsh', status: 'started', topic: 'unset' })
  await open.ledger.appendLedger(verification(PLAN_ID))
  await open.ledger.appendLedger(verification(PLAN_ID, { status: 'unrecorded', reason: 'not_called' }))
  const c = open.child()
  open.start(c)
  assert.equal(c.agent.cancelled, 0, 'a line of kind verification does not trip the other-kind check')
  assert.equal(open.run(c, 'read', { file_path: 'src/a.js' }), undefined)
  open.brief(c, 'Sanitized briefing.')
  assert.equal((await open.submit(c, plan())).plan_id, PLAN_ID)
  await until(() => open.lines().length === 4, 'the ok line')
  assert.deepEqual(open.lines().map((line) => [line.kind, line.status]), [['plan', 'started'], ['verification', 'recorded'], ['verification', 'unrecorded'], ['plan', 'ok']], 'no second started line')

  // A finished run followed by its verification line is still finished: never reopened, nothing added.
  for (const self of [PLANNER, CONSULT]) {
    const kind = self === PLANNER ? 'plan' : 'advice'
    const done = harness({ ledgerMode: 'real' })
    t.after(done.dispose)
    await done.ledger.appendLedger({ consult_id: PLAN_ID, kind, advisor: 'dsh', status: 'started' })
    await done.ledger.appendLedger({ consult_id: PLAN_ID, kind, advisor: 'dsh', status: 'ok', reply_file: done.ledger.replyPath(PLAN_ID), reply_sha256: 'a'.repeat(64) })
    await done.ledger.appendLedger(verification(PLAN_ID, { verified_kind: kind }))
    const before = readFileSync(done.ledger.ledgerPath, 'utf8')
    const d = done.child({ self })
    done.start(d)
    assert.equal(d.agent.cancelled, 1, `${self}: a finished run is stopped instead of running again`)
    assert.equal(d.registered.has(d.tool), false, self)
    done.end(d)
    await settle()
    assert.equal(readFileSync(done.ledger.ledgerPath, 'utf8'), before, `${self}: nothing is added`)
  }

  // A verification line alone does not make its id used.
  const fresh = harness({ ledgerMode: 'real' })
  t.after(fresh.dispose)
  await fresh.ledger.appendLedger(verification(PLAN_ID_B, { status: 'unrecorded', reason: 'reply_withheld' }))
  assert.equal(fresh.ledger.idInUse(PLAN_ID_B), false)
  assert.equal(fresh.delegate({ name: PLANNER_B }), undefined)
})

test('start: a child resumed after a Host restart keeps the effort_requested of its started line, whatever the setting is now', async (t) => {
  const before = harness()
  t.after(before.dispose)
  before.state.settings = { active: true, advisorModel: ROUTE_EFFORT }
  startChild(before)
  await settle()
  const [started] = before.state.ledger
  assert.deepEqual([started.status, started.effort_requested], ['started', 'high'])

  // A Host restart: a new boundary with the same ledger, and the setting changed meanwhile.
  for (const later of [{ ...ROUTE, effort: 'low' }, ROUTE, null]) {
    const after = harness()
    t.after(after.dispose)
    after.state.ledger.push(structuredClone(started))
    after.state.settings = { active: true, advisorModel: later }
    const c = startChild(after)
    assert.equal(c.agent.cancelled, 0, JSON.stringify(later))
    assert.equal((await after.submit(c, plan())).plan_id, PLAN_ID)
    await settle()
    assert.deepEqual(after.lines().map((line) => [line.status, line.effort_requested]), [['started', 'high'], ['ok', 'high']], JSON.stringify(later))
  }

  // A resumed child refused at start records the same value on its failed line.
  const moved = harness()
  t.after(moved.dispose)
  moved.state.ledger.push(structuredClone(started))
  moved.state.settings = { active: true, advisorModel: { ...OTHER_ROUTE, effort: 'low' } }
  const refused = startChild(moved)
  assert.equal(refused.agent.cancelled, 1)
  await settle()
  assert.deepEqual(moved.terminal().map((line) => [line.status, line.failure_reason, line.effort_requested]),
    [['failed', 'child started on a route other than the selected Advisor model', 'high']])

  // A started line written before efforts existed has none: the resumed child records null.
  const legacy = harness()
  t.after(legacy.dispose)
  legacy.state.ledger.push({ consult_id: PLAN_ID, kind: 'plan', status: 'started' })
  legacy.state.settings = { active: true, advisorModel: ROUTE_EFFORT }
  const c = startChild(legacy)
  await legacy.submit(c, plan())
  await settle()
  assert.deepEqual(legacy.terminal().map((line) => [line.status, line.effort_requested]), [['ok', null]])
})

test('start: invalid reserved children are cancelled, fail closed and take no slot; only well-formed ids get a failed line', async (t) => {
  const routed = { active: true, advisorModel: ROUTE }
  const routeReason = 'child started on a route other than the selected Advisor model'
  const cases = [
    ['not in-process', { info: { local: false } }, 'invalid advisor child start'],
    ['not started by subagent', { info: { provider: 'claude_code' } }, 'invalid advisor child start'],
    ['grandchild', { child: { parent: 'mate' } }, 'invalid advisor child start'],
    ['malformed planner id', { child: { self: 'advisor-planner-xyz' } }, undefined],
    ['malformed consult id', { child: { self: 'advisor-consult-xyz' } }, undefined],
    ['bare prefix', { child: { self: 'advisor-consult' } }, undefined],
    ['Advisor off', { state: { settings: { active: false, advisorModel: null } } }, 'invalid advisor child start'],
    ['no settings', { state: { settings: undefined } }, 'invalid advisor child start'],
    ['no lead workspace', { state: { workspace: undefined } }, 'invalid advisor child start'],
    ['lead workspace missing', { state: { workspace: path.join(TMP, 'missing') } }, 'invalid advisor child start'],
    ['child cwd unknown', { child: { cwd: undefined } }, 'invalid advisor child start'],
    ['cwd outside the workspace', { child: { cwd: OUT } }, 'invalid advisor child start'],
    ['cwd symlinked outside', { child: { cwd: path.join(WS, 'link-out') } }, 'invalid advisor child start'],
    ['rootOf throws', { child: { rootThrows: true } }, 'invalid advisor child start'],
    ['started on another route', { state: { settings: routed }, child: { route: OTHER_ROUTE } }, routeReason],
    ['route unreadable', { state: { settings: routed }, child: { route: new Error('no selection') } }, routeReason],
    ['route missing', { state: { settings: routed }, child: { route: null } }, routeReason],
    ['consult on another route', { state: { settings: routed }, child: { self: CONSULT, route: OTHER_ROUTE } }, routeReason],
  ]
  for (const [label, setup, reason] of cases) {
    const h = harness()
    t.after(h.dispose)
    Object.assign(h.state, setup.state ?? {})
    const c = h.child(setup.child)
    h.start(c, setup.info)
    assert.equal(c.agent.cancelled, 1, label)
    assert.equal(h.boundary.livePlanners.size, 0, `${label}: no slot`)
    for (const tool of [SUBMIT_TOOL, ADVICE_TOOL, 'grep']) assert.equal(c.registered.has(tool), false, `${label}: ${tool}`)
    for (const name of ['read', 'glob', 'grep', SUBMIT_TOOL, ADVICE_TOOL, 'bash']) {
      assert.match(h.run(c, name, { file_path: 'src/a.js', pattern: 'x' }) ?? 'ALLOWED', /failed closed|only available to its advisor child/, `${label}: ${name}`)
    }
    await settle()
    if (reason === undefined) assert.deepEqual(h.state.ledger, [], `${label}: no ledger line for a malformed id`)
    else assert.deepEqual(h.state.ledger.map((line) => [line.consult_id, line.status, line.failure_reason]), [[PLAN_ID, 'failed', reason]], label)
    h.end(c)
    await settle()
    assert.equal(h.boundary.records.size, 0, label)
    assert.equal(h.state.ledger.length, reason === undefined ? 0 : 1, `${label}: end adds nothing`)
  }
})

test('start: setup failures, including a guard that cannot be installed, fail closed with a single failed line', async (t) => {
  const cases = [
    ['submit tool refused', { refuse: [SUBMIT_TOOL] }, 'boundary setup failed: submit tool did not register'],
    ['advice tool refused', { self: CONSULT, refuse: [ADVICE_TOOL] }, 'boundary setup failed: submit tool did not register'],
    ['confined grep refused', { refuse: ['grep'] }, 'boundary setup failed: confined grep did not register'],
    ['child guard throws', { guardThrows: true }, 'boundary setup failed: guard registry closed'],
  ]
  for (const [label, options, reason] of cases) {
    const h = harness()
    t.after(h.dispose)
    const c = h.child(options)
    h.start(c)
    assert.equal(c.agent.cancelled, 1, label)
    assert.match(h.run(c, 'read', { file_path: 'src/a.js' }), /failed closed/, label)
    assert.match(h.run(c, 'bash', { command: 'id' }), /failed closed/, `${label}: the host guard denies a child without a valid record`)
    assert.equal(h.boundary.livePlanners.size, 0, label)
    await settle()
    assert.deepEqual(h.reasons(), [['started', undefined], ['failed', reason]], label)
  }
  const finished = harness()
  t.after(finished.dispose)
  finished.state.ledger.push({ consult_id: PLAN_ID, status: 'ok' })
  const old = finished.child({ guardThrows: true })
  finished.start(old)
  assert.equal(old.agent.cancelled, 1, 'a finished child whose guard cannot be installed is still stopped')
  assert.match(finished.run(old, 'bash', { command: 'id' }), /failed closed/)
})

test('start: a valid child may work in a workspace subdirectory; paths and grep results follow its cwd', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const c = startConsult(h, { cwd: path.join(WS, 'src') })
  assert.equal(c.agent.cancelled, 0)
  assert.equal(h.run(c, 'read', { file_path: 'sub/b.js' }), undefined)
  assert.match(h.run(c, 'read', { file_path: 'out-link/canary.txt' }), /inside the workspace/)
  assert.match(h.run(c, 'read', { file_path: path.join(WS, '.env') }), /protected/)
  h.state.grepMatches = [{ path: 'sub/b.js', lineNumber: 1, line: 'x' }, { path: 'out-link/canary.txt', lineNumber: 1, line: 'FAKE_OUTSIDE_CANARY' }]
  const value = await c.registered.get('grep').execute({ pattern: 'x' }, { name: 'grep', arguments: { pattern: 'x' }, agent: c.agent })
  assert.deepEqual(value.matches.map((match) => match.path), ['sub/b.js'])
})

test('host guard: a reserved child without a start record fails closed, also after release', (t) => {
  const h = harness()
  t.after(h.dispose)
  for (const self of [PLANNER, CONSULT]) {
    const unseen = h.child({ id: `unseen-${self}`, self })
    assert.match(h.run(unseen, 'read', { file_path: 'src/a.js' }), /failed closed/, `${self}: subagent/start never observed`)
  }
  const late = h.child({ id: 'late', namesThrow: true })
  h.start(late) // names unavailable at start: no record
  late.agent.namesThrow = false
  assert.match(h.run(late, 'read', { file_path: 'src/a.js' }), /failed closed/)

  const c = startConsult(h)
  assert.equal(h.run(c, 'read', { file_path: 'src/a.js' }), undefined)
  h.end(c)
  assert.match(h.run(c, 'read', { file_path: 'src/a.js' }), /failed closed/)
  assert.equal(c.registered.has(ADVICE_TOOL), false, 'release disposed the scoped advice tool')
  assert.equal(c.registered.has('grep'), false, 'release disposed the confined grep')
  assert.equal(c.sections.length, 0, 'release disposed the policy section')
  assert.equal(c.inbox.length, 0, 'release disposed the inbox hook')
})

test('start: resumed children never take over a running child\'s slot', async (t) => {
  for (const prior of [[{ consult_id: OLD_ID, status: 'started' }, { consult_id: OLD_ID, status: 'failed' }], [{ consult_id: OLD_ID, status: 'started' }]]) {
    const h = harness()
    t.after(h.dispose)
    h.state.ledger.push(...prior)
    assert.equal(h.delegate(), undefined)
    startChild(h) // PLAN_ID, still running
    const old = h.child({ id: 'consult-old', self: `advisor-consult-${OLD_ID}` })
    h.start(old)
    h.end(old)
    assert.match(h.delegate({ name: PLANNER_B }), /advisor-planner-abcdef012345 is still running/, JSON.stringify(prior.map((entry) => entry.status)))
  }
})

test('start: the root stays busy while a resumed child still runs after the slot holder ends', {
  // fixed: 'BUG (minor, rest of #5): an orphaned child that resumed while another held the slot never takes it over (planner.js:1000-1005); once the holder ends, releaseSlot frees the root although the orphan still runs, so a third child can start'
}, async (t) => {
  const h = harness()
  t.after(h.dispose)
  h.state.ledger.push({ consult_id: OLD_ID, status: 'started' })
  assert.equal(h.delegate(), undefined)
  const holder = startChild(h)
  const orphan = h.child({ id: 'consult-old', self: `advisor-consult-${OLD_ID}` })
  h.start(orphan)
  h.end(holder)
  assert.equal(orphan.agent.cancelled, 0)
  assert.match(h.delegate({ name: PLANNER_B }) ?? 'ALLOWED', /is still running/)
})

test('start: a resumed child that is invalid at its next start gets one failed line', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const c = startConsult(h)
  await settle()
  h.state.settings = { active: false, advisorModel: null }
  h.start(c) // a later residency epoch, now invalid
  assert.equal(c.agent.cancelled, 1)
  assert.match(h.run(c, 'read', { file_path: 'src/a.js' }), /failed closed/)
  assert.equal(h.boundary.livePlanners.size, 0)
  h.end(c)
  await settle()
  assert.deepEqual(h.reasons(), [['started', undefined], ['failed', 'invalid advisor child start']])
})

// ===========================================================================
// 4. installPlannerBoundary: child guard

test('child guard: default deny, exact agent, no shadows, confinement and a tool-call cap', async (t) => {
  const h = harness({ maxToolCalls: 4 })
  t.after(h.dispose)
  const c = startChild(h, { cwd: path.join(WS, 'src') })
  for (const name of ['bash', 'write', 'edit', 'send_message', 'subagent', 'team_task_create', 'web_fetch', 'working_directory', ADVICE_TOOL]) {
    assert.match(h.run(c, name, {}), /read-only: this tool is not permitted|only available to its advisor child/, name)
  }
  assert.match(h.run(c, 'read', { file_path: 'a.js' }, { agent: h.mate }), /no exact agent scope/)
  assert.match(h.run(c, 'read', { file_path: 'a.js' }, { agent: undefined }), /no exact agent scope/)
  for (const [name, shadow] of [['read', { name: 'read' }], ['grep', h.hostGrep], [SUBMIT_TOOL, { name: SUBMIT_TOOL, execute() {} }]]) {
    c.shadows.set(name, shadow)
    assert.match(h.run(c, name, { file_path: 'a.js', pattern: 'x' }), /unavailable or shadowed/, name)
    c.shadows.delete(name)
  }

  assert.equal(h.run(c, 'read', { file_path: 'a.js' }), undefined, 'call 1')
  assert.match(h.run(c, 'read', { file_path: path.join(WS, '.env') }), /protected/, 'call 2')
  assert.equal(h.run(c, 'grep', { pattern: 'x' }), undefined, 'call 3')
  assert.equal(h.run(c, 'glob', { pattern: '**/*.js' }), undefined, 'call 4')
  assert.equal(c.agent.cancelled, 0)
  assert.match(h.run(c, 'read', { file_path: 'a.js' }), /^Tool-call budget exhausted; this advisor child is stopped\.$/, 'call 5 exceeds the cap')
  assert.equal(c.agent.cancelled, 1)
  assert.match(h.run(c, 'read', { file_path: 'a.js' }), /^This advisor child has stopped; end your turn\.$/)
  await settle()
  const lines = h.terminal()
  assert.equal(lines.length, 1)
  assert.equal(lines[0].status, 'failed')
  assert.equal(lines[0].failure_reason, 'tool-call cap (4) reached')
  assert.equal(lines[0].tool_calls, 5)
  h.end(c)
  await settle()
  assert.equal(h.terminal().length, 1)
})

test('child guard: each kind may call only its own submit tool', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const planner = startChild(h)
  const other = harness()
  t.after(other.dispose)
  const consult = startConsult(other)
  assert.match(h.run(planner, ADVICE_TOOL, advice()), /^advisor_advice_submit is only available to its advisor child\.$/)
  assert.match(other.run(consult, SUBMIT_TOOL, plan()), /^advisor_plan_submit is only available to its advisor child\.$/)
  // Even if the other kind's tool were visible to the child, its own guard refuses it.
  assert.match(consult.guards[0]({ name: SUBMIT_TOOL, arguments: plan(), agent: consult.agent }), /read-only: this tool is not permitted/)
  assert.match(planner.guards[0]({ name: ADVICE_TOOL, arguments: advice(), agent: planner.agent }), /read-only: this tool is not permitted/)
  assert.equal(other.run(consult, ADVICE_TOOL, advice()), undefined)
  assert.match(h.call(ADVICE_TOOL, advice()), /only available to its advisor child/, 'the lead')
  assert.match(h.call(SUBMIT_TOOL, plan(), { agent: consult.agent }), /only available to its advisor child/, 'an agent from another host instance')
  assert.equal(h.state.writeCalls.length + other.state.writeCalls.length, 0)
})

test('child guard: the planner grep is the confined wrapper and withholds protected or outside matches', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const c = startChild(h)
  const grep = c.registered.get('grep')
  for (const key of ['name', 'parameters', 'output', 'timeoutMs', 'isConcurrencySafe', 'presentCall', 'presentResult']) {
    assert.equal(grep[key], h.hostGrep[key], `${key} is preserved`)
  }
  h.state.grepMatches = [
    { path: 'src/a.js', lineNumber: 1, line: 'export const a = 1' },
    { path: '.env', lineNumber: 1, line: 'FAKE_SECRET_ENV=1' },
    { path: 'config/credentials.json', lineNumber: 1, line: '{"token":"FAKE_SECRET_CRED"}' },
    { path: '.git/config', lineNumber: 2, line: 'url = https://FAKE_SECRET_GIT@example.invalid' },
    { path: 'link-env', lineNumber: 1, line: 'FAKE_SECRET_ENV=1' },
    { path: 'link-out/canary.txt', lineNumber: 1, line: 'FAKE_OUTSIDE_CANARY' },
    { path: path.join(OUT, 'canary.txt'), lineNumber: 1, line: 'FAKE_OUTSIDE_CANARY' },
    { path: 'docs/readme.md', lineNumber: 1, line: 'x' },
  ]
  const args = { pattern: 'FAKE|export|x', include: '*' }
  assert.equal(h.run(c, 'grep', args), undefined, 'any include passes the guard')
  const exec = { name: 'grep', arguments: args, agent: c.agent }
  const value = await grep.execute(args, exec)
  assert.deepEqual(value.matches.map((match) => match.path), ['src/a.js', 'docs/readme.md'])
  assert.equal(h.state.grepCalls.length, 1)
  assert.equal(h.state.grepCalls[0].exec, exec)
  const [rendered] = grep.output.render(args, value)
  assert.doesNotMatch(rendered.text, /FAKE_SECRET|FAKE_OUTSIDE/)
})

test('child guard: without a Host grep the child has no grep', (t) => {
  const h = harness({ noGrep: true })
  t.after(h.dispose)
  const c = startConsult(h)
  assert.equal(c.agent.cancelled, 0)
  assert.equal(c.registered.has('grep'), false)
  assert.match(h.run(c, 'grep', { pattern: 'x' }), /unavailable or shadowed/)
  assert.equal(h.run(c, 'read', { file_path: 'src/a.js' }), undefined)
})

// ===========================================================================
// 4. installPlannerBoundary: submit

test('submit: a valid plan is written once and recorded with a complete ok ledger line', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const c = h.child({
    route: { ...ROUTE, reasoningEffort: 'high' },
    events: [
      { type: 'assistant/message', data: { usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 600, cacheWriteTokens: 40, reasoningTokens: 50 } } },
      { type: 'tool/result', data: {} },
      { type: 'assistant/message', data: { usage: { inputTokens: 1300, outputTokens: 150, cacheReadTokens: 900 } } },
    ],
  })
  h.start(c)
  h.brief(c, 'BRIEFING one')
  h.brief(c, 'a later inbox message')
  h.state.clock += 12_345
  const input = plan([task('T1', { write_scopes: ['./src//lib/'] }), task('T2', { write_scopes: ['src/lib/x.js'], blocked_by: ['T1'] })])
  const result = await h.submit(c, input)

  const expected = renderPlan(PLAN_ID, validatePlan(input).plan)
  assert.deepEqual(h.state.writeCalls, [{ id: PLAN_ID, text: expected }])
  const rendered = JSON.parse(expected)
  assert.equal(rendered.schema, PLAN_SCHEMA_ID)
  assert.equal(rendered.plan_id, PLAN_ID)
  assert.deepEqual(rendered.tasks[0].write_scopes, ['src/lib'])
  assert.deepEqual(result, { plan_id: PLAN_ID, reply_file: h.ledger.replyPath(PLAN_ID), reply_sha256: hash(expected), task_count: 2 })
  assert.equal(readFileSync(result.reply_file, 'utf8'), expected)
  assert.deepEqual(h.boundary.plans.get(PLAN_ID), { reply_file: result.reply_file, reply_sha256: result.reply_sha256 })
  await settle()
  assert.deepEqual(h.terminal(), [{
    consult_id: PLAN_ID, kind: 'plan', advisor: 'dsh', caller: 'advisor-plugin', topic: 'unset',
    session_id: h.lead.id, planner_session_id: c.agent.id, cwd: WS,
    briefing_sha256: hash('BRIEFING one'), briefing_chars: 'BRIEFING one'.length,
    backend: `dsh:${ROUTE.provider}/${ROUTE.model}`, model: ROUTE.model, effort: 'high', effort_requested: null,
    ts: Math.floor(h.state.clock / 1000), status: 'ok',
    reply_file: result.reply_file, reply_sha256: result.reply_sha256, task_count: 2,
    submit_attempts: 1, tool_calls: 1, duration_s: 12.3, cost_usd: null,
    input_tokens: 2300, output_tokens: 350, cache_read_tokens: 1500, cache_write_tokens: 40, reasoning_tokens: 50, model_requests: 2,
  }])
  const [output] = c.registered.get(SUBMIT_TOOL).output.render(input, result)
  assert.match(output.text, /End your turn with exactly: PLAN abcdef012345/)

  for (const [name, args] of [['read', { file_path: 'src/a.js' }], ['glob', { pattern: '*.js' }], ['grep', { pattern: 'x' }], [SUBMIT_TOOL, input]]) {
    assert.match(h.run(c, name, args), /^The plan is recorded; end your turn with exactly: PLAN abcdef012345$/, name)
  }
  assert.match(h.run(c, 'bash', {}), /read-only/)
  await assert.rejects(c.registered.get(SUBMIT_TOOL).execute(input, { name: SUBMIT_TOOL, agent: c.agent }), /already finished or is recording its plan; it cannot be replaced/)
  assert.equal(h.state.writeCalls.length, 1)
})

test('briefingTopic: only a valid first-line topic slug is recorded, verbatim', () => {
  const max = `a${'b'.repeat(39)}`
  const cases = [
    ['topic: smoke-plan', 'smoke-plan'],
    ['topic: smoke-plan\nrest of the briefing', 'smoke-plan'],
    ['topic: smoke-plan\r\nrest', 'smoke-plan'],
    ['topic:smoke', 'smoke'],
    ['topic:\t \tsmoke \t\nrest', 'smoke'],
    ['topic: 9lives', '9lives'],
    ['topic: a', 'a'],
    [`topic: ${max}`, max],
    [`topic: ${max}b`, 'unset'],
    ['topic: Smoke-plan', 'unset'],
    ['topic: SMOKE', 'unset'],
    ['Topic: smoke', 'unset'],
    ['topic: smoke_plan', 'unset'],
    ['topic: -smoke', 'unset'],
    ['topic: smoke plan', 'unset'],
    ['topic: smoke.plan', 'unset'],
    ['topic: smoke\rrest', 'unset'],
    ['topic:', 'unset'],
    ['topic: ', 'unset'],
    [' topic: smoke', 'unset'],
    ['\ntopic: smoke', 'unset'],
    ['\r\ntopic: smoke', 'unset'],
    ['Briefing first.\ntopic: smoke', 'unset'],
    ['topic smoke', 'unset'],
    ['', 'unset'],
    [undefined, 'unset'],
    [null, 'unset'],
    [42, 'unset'],
  ]
  for (const [text, expected] of cases) assert.equal(briefingTopic(text), expected, JSON.stringify(text))
})

test('submit: the first briefing topic is recorded on the ok line; started lines and other fields are unchanged', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const c = h.child({ route: { ...ROUTE, reasoningEffort: 'high' } })
  h.start(c)
  const body = 'topic: smoke-plan\r\nBRIEFING one'
  h.brief(c, body)
  h.brief(c, 'topic: other-topic\na later inbox message')
  await settle()
  const [started] = h.state.ledger
  assert.equal(started.status, 'started')
  assert.equal(started.topic, 'unset', 'the started line precedes the briefing')
  const result = await h.submit(c, plan())
  await settle()
  const [ok] = h.terminal()
  assert.equal(ok.status, 'ok')
  assert.equal(ok.topic, 'smoke-plan')
  assert.equal(ok.briefing_sha256, hash(body), 'the hash covers the whole first message body')
  assert.equal(ok.briefing_chars, body.length)
  assert.equal(ok.reply_sha256, result.reply_sha256)
  // Same key set as the exact ok line asserted in the complete-ok-line test.
  const expectedKeys = [
    'consult_id', 'kind', 'advisor', 'caller', 'topic', 'session_id', 'planner_session_id', 'cwd',
    'briefing_sha256', 'briefing_chars', 'backend', 'model', 'effort', 'effort_requested', 'ts', 'status',
    'reply_file', 'reply_sha256', 'task_count', 'submit_attempts', 'tool_calls', 'duration_s', 'cost_usd',
    'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'model_requests',
  ]
  assert.deepEqual(Object.keys(ok).sort(), [...expectedKeys].sort())
  assert.deepEqual(Object.keys(started).sort(), [
    'consult_id', 'kind', 'advisor', 'caller', 'topic', 'session_id', 'planner_session_id', 'cwd',
    'briefing_sha256', 'briefing_chars', 'backend', 'model', 'effort', 'effort_requested', 'ts', 'status',
  ].sort())
})

test('ledger: effort is what the child reports; effort_requested is the Advisor model effort when the child started', async (t) => {
  const cases = [
    // [label, setting at start, the child's current() selection, effort, effort_requested]
    ['stored effort, child reports another', ROUTE_EFFORT, { ...ROUTE, reasoningEffort: 'low' }, 'low', 'high'],
    ['stored effort, child reports none', ROUTE_EFFORT, ROUTE, null, 'high'],
    ['stored effort, child reports it', ROUTE_EFFORT, { ...ROUTE, reasoningEffort: 'high' }, 'high', 'high'],
    ['no stored effort', ROUTE, { ...ROUTE, reasoningEffort: 'medium' }, 'medium', null],
    ['Inherit', null, { ...OTHER_ROUTE, reasoningEffort: 'high' }, 'high', null],
  ]
  for (const self of [PLANNER, CONSULT]) {
    for (const [label, setting, current, effort, requested] of cases) {
      const h = harness()
      t.after(h.dispose)
      h.state.settings = { active: true, advisorModel: setting }
      const c = startChild(h, { self, route: current })
      assert.equal(c.agent.cancelled, 0, `${self} ${label}: the start check ignores the effort`)
      await h.submit(c, self === PLANNER ? plan() : advice())
      await settle()
      assert.deepEqual(h.lines().map((line) => [line.status, line.effort, line.effort_requested]), [['started', effort, requested], ['ok', effort, requested]], `${self} ${label}`)
    }
  }

  // Failed lines carry both too, also when the child's selection cannot be read.
  const h = harness()
  t.after(h.dispose)
  h.state.settings = { active: true, advisorModel: ROUTE_EFFORT }
  const c = startChild(h, { route: { ...ROUTE, reasoningEffort: 'high' } })
  c.route = new Error('no selection')
  h.state.settings = { active: false, advisorModel: ROUTE_EFFORT }
  await assert.rejects(h.submit(c, plan()), /Advisor was turned off/)
  await settle()
  const [failed] = h.terminal()
  assert.deepEqual(
    [failed.status, failed.backend, failed.model, failed.effort, failed.effort_requested],
    ['failed', `dsh:${ROUTE.provider}/${ROUTE.model}`, ROUTE.model, null, 'high'],
    'the start snapshot gives the backend; the observed effort stays null',
  )
})

test('submit: an effort change mid-run keeps the run and records the effort requested at start; a model change still fails it', async (t) => {
  for (const later of [{ ...ROUTE, effort: 'low' }, ROUTE, { ...ROUTE, effort: 'HIGH' }]) {
    const h = harness()
    t.after(h.dispose)
    h.state.settings = { active: true, advisorModel: ROUTE_EFFORT }
    const c = startChild(h, { route: { ...ROUTE, reasoningEffort: 'high' } })
    h.state.settings = { active: true, advisorModel: later }
    assert.equal((await h.submit(c, plan())).plan_id, PLAN_ID, JSON.stringify(later))
    await settle()
    assert.deepEqual(h.terminal().map((line) => [line.status, line.effort, line.effort_requested]), [['ok', 'high', 'high']], JSON.stringify(later))
  }
  const moved = harness()
  t.after(moved.dispose)
  moved.state.settings = { active: true, advisorModel: ROUTE_EFFORT }
  const c = startChild(moved)
  moved.state.settings = { active: true, advisorModel: { ...OTHER_ROUTE, effort: 'high' } }
  await assert.rejects(moved.submit(c, plan()), /not running on the selected Advisor model/)
  await settle()
  assert.deepEqual(moved.terminal().map((line) => [line.status, line.failure_reason, line.effort_requested]),
    [['failed', 'advisor child model does not match the selected Advisor model', 'high']])
})

test('submit: a child without a valid topic line keeps topic unset', async (t) => {
  for (const body of ['BRIEFING one\ntopic: smoke-plan', 'topic: Smoke_Plan\nBRIEFING', '\ntopic: smoke-plan']) {
    const h = harness()
    t.after(h.dispose)
    const c = h.child()
    h.start(c)
    h.brief(c, body)
    await h.submit(c, plan())
    await settle()
    const [ok] = h.terminal()
    assert.deepEqual([ok.status, ok.topic, ok.briefing_sha256], ['ok', 'unset', hash(body)], JSON.stringify(body))
  }
})

test('fail: a failed line after the briefing carries the parsed topic', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const c = h.child({ self: CONSULT })
  h.start(c)
  h.brief(c, 'topic: smoke-plan\nDecide between A and B.')
  h.state.settings = { active: false, advisorModel: null }
  await assert.rejects(h.submit(c, advice()), /Advisor was turned off/)
  await settle()
  const [failed] = h.terminal()
  assert.deepEqual([failed.status, failed.failure_reason, failed.topic, failed.kind], ['failed', 'advisor turned off', 'smoke-plan', 'advice'])
  assert.equal(h.state.ledger[0].topic, 'unset', 'the started line keeps unset')
})

test('submit: valid advice is written once and recorded with kind advice and claim_count', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const c = h.child({ self: CONSULT, events: [{ type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 2 } } }] })
  h.start(c)
  h.brief(c, 'Decide between A and B.')
  const input = advice({ question: '  Which?  ' })
  const result = await h.submit(c, input)
  const expected = renderAdvice(PLAN_ID, validateAdvice(input).advice)
  assert.deepEqual(h.state.writeCalls, [{ id: PLAN_ID, text: expected }])
  assert.equal(JSON.parse(expected).question, 'Which?')
  assert.deepEqual(result, { advice_id: PLAN_ID, reply_file: h.ledger.replyPath(PLAN_ID), reply_sha256: hash(expected), claim_count: 2 })
  await settle()
  const [ok] = h.terminal()
  assert.deepEqual(
    [ok.consult_id, ok.kind, ok.status, ok.claim_count, ok.task_count, ok.reply_sha256, ok.briefing_sha256, ok.input_tokens, ok.output_tokens, ok.model_requests],
    [PLAN_ID, 'advice', 'ok', 2, undefined, result.reply_sha256, hash('Decide between A and B.'), 10, 2, 1],
  )
  const [output] = c.registered.get(ADVICE_TOOL).output.render(input, result)
  assert.match(output.text, /^Advice recorded: advice_id abcdef012345, 2 claim\(s\)\. End your turn with exactly: ADVICE abcdef012345$/)
  assert.deepEqual(c.registered.get(ADVICE_TOOL).output.schema.required, ['advice_id', 'reply_file', 'reply_sha256', 'claim_count'])
  assert.match(h.run(c, 'read', { file_path: 'src/a.js' }), /^The advice is recorded; end your turn with exactly: ADVICE abcdef012345$/)
  await assert.rejects(c.registered.get(ADVICE_TOOL).execute(input, { name: ADVICE_TOOL, agent: c.agent }), /already finished or is recording its advice/)
})

test('submit: invalid results throw their issues, attempts are counted and the fifth failure stops the child', async (t) => {
  const kinds = [
    [PLANNER, plan([task('T1'), task('T1')]), /^Not recorded\. Fix these problems and call advisor_plan_submit again:\n- tasks\.1\.id: duplicate id T1/, 'invalid plan after 5 attempts', plan()],
    [CONSULT, withEvidence('../x.js:1'), /^Not recorded\. Fix these problems and call advisor_advice_submit again:\n- claims\.0\.evidence\.0: path must not contain \.\./, 'invalid advice after 5 attempts', advice()],
  ]
  for (const [self, bad, message, reason, good] of kinds) {
    const h = harness()
    t.after(h.dispose)
    const c = startChild(h, { self })
    for (let attempt = 1; attempt < MAX_SUBMIT_FAILURES; attempt++) {
      await assert.rejects(h.submit(c, bad), (error) => {
        assert.match(error.message, message)
        return true
      })
    }
    assert.equal(c.agent.cancelled, 0)
    await assert.rejects(h.submit(c, bad), /^Error: Submission rejected 5 times; this advisor child is stopped\.$|Submission rejected 5 times; this advisor child is stopped\./)
    assert.equal(c.agent.cancelled, 1)
    assert.equal(h.state.writeCalls.length, 0)
    await settle()
    const [failed] = h.terminal()
    assert.deepEqual([failed.status, failed.failure_reason, failed.submit_attempts], ['failed', reason, 5], self)
    assert.match(h.run(c, 'read', { file_path: 'src/a.js' }), /This advisor child has stopped/)
    await assert.rejects(c.registered.get(c.tool).execute(good, { name: c.tool, agent: c.agent }), /already finished/)

    const retry = harness()
    t.after(retry.dispose)
    const c2 = startChild(retry, { self })
    await assert.rejects(retry.submit(c2, bad))
    await assert.rejects(retry.submit(c2, { summary: 'only' }))
    await retry.submit(c2, good)
    await settle()
    assert.equal(retry.terminal()[0].submit_attempts, 3, `${self}: attempts include the rejected ones`)
  }
})

test('submit: two concurrent submits record exactly one result', async (t) => {
  for (const [self, value] of [[PLANNER, plan()], [CONSULT, advice()]]) {
    const h = harness()
    t.after(h.dispose)
    const c = startChild(h, { self })
    const tool = c.registered.get(c.tool)
    const exec = { name: c.tool, arguments: value, agent: c.agent }
    const results = await Promise.allSettled([tool.execute(value, exec), tool.execute(value, exec)])
    assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected'], self)
    assert.match(results.find((result) => result.status === 'rejected').reason.message, /already finished or is recording its (plan|advice)/)
    assert.equal(h.state.writeCalls.length, 1)
    await settle()
    assert.deepEqual(h.statuses(), ['started', 'ok'], self)
  }
})

test('submit: only the bound child can submit', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const c = startChild(h)
  const other = h.child({ id: 'planner-2', self: PLANNER_B })
  h.start(other)
  const tool = c.registered.get(SUBMIT_TOOL)
  await assert.rejects(tool.execute(plan(), { name: SUBMIT_TOOL, agent: h.mate }), /^Error: advisor_plan_submit is bound to another advisor child\.$|bound to another advisor child/)
  await assert.rejects(tool.execute(plan(), { name: SUBMIT_TOOL, agent: other.agent }), /bound to another advisor child/)
  await assert.rejects(tool.execute(plan(), { name: SUBMIT_TOOL, agent: undefined }), /bound to another advisor child/)
  assert.match(h.call(SUBMIT_TOOL, plan()), /only available to its advisor child/, 'the lead')
  assert.match(h.call(SUBMIT_TOOL, plan(), { agent: h.mate }), /only available to its advisor child/, 'a teammate')
  assert.match(h.run(c, SUBMIT_TOOL, plan(), { agent: other.agent }), /no exact agent scope/)
  assert.equal(h.state.writeCalls.length, 0)
  assert.equal(c.agent.cancelled, 0)
})

test('submit: the child must still run on the selected Advisor model', async (t) => {
  const routed = { active: true, advisorModel: ROUTE }
  const variants = [
    ['model changed', OTHER_ROUTE, `dsh:${OTHER_ROUTE.provider}/${OTHER_ROUTE.model}`],
    ['selection unreadable', new Error('no selection'), `dsh:${ROUTE.provider}/${ROUTE.model}`],
    ['selection missing', undefined, `dsh:${ROUTE.provider}/${ROUTE.model}`],
  ]
  for (const self of [PLANNER, CONSULT]) {
    for (const [label, current, backend] of variants) {
      const h = harness()
      t.after(h.dispose)
      h.state.settings = routed
      const c = startChild(h, { self })
      c.route = current
      await assert.rejects(h.submit(c, self === PLANNER ? plan() : advice()), /This child is not running on the selected Advisor model; the (plan|advice) was not recorded/, `${self} ${label}`)
      assert.equal(c.agent.cancelled, 1, label)
      assert.equal(h.state.writeCalls.length, 0, label)
      await settle()
      assert.equal(h.terminal()[0].failure_reason, 'advisor child model does not match the selected Advisor model', label)
      assert.equal(h.terminal()[0].backend, backend, label)
    }
  }
  const reselected = harness()
  t.after(reselected.dispose)
  reselected.state.settings = routed
  const c1 = startChild(reselected)
  reselected.state.settings = { active: true, advisorModel: OTHER_ROUTE }
  await assert.rejects(reselected.submit(c1, plan()), /not running on the selected Advisor model/)
  const inherited = harness()
  t.after(inherited.dispose)
  const c2 = startChild(inherited)
  inherited.state.settings = { active: true, advisorModel: null }
  c2.route = OTHER_ROUTE
  assert.equal((await inherited.submit(c2, plan())).plan_id, PLAN_ID, 'Inherit does not pin a route')
})

test('submit: Advisor turned off fails the child', async (t) => {
  for (const settings of [{ active: false, advisorModel: null }, {}, undefined]) {
    const h = harness()
    t.after(h.dispose)
    const c = startConsult(h)
    h.state.settings = settings
    await assert.rejects(h.submit(c, advice()), /^Error: Advisor was turned off; the advice was not recorded\.$|Advisor was turned off; the advice was not recorded/, JSON.stringify(settings))
    assert.equal(c.agent.cancelled, 1)
    assert.equal(h.state.writeCalls.length, 0)
    await settle()
    assert.equal(h.terminal()[0].failure_reason, 'advisor turned off')
  }
})

test('submit: a reply-file write failure fails the child without recording a result', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const c = startChild(h)
  mkdirSync(path.dirname(h.ledger.replyPath(PLAN_ID)), { recursive: true, mode: 0o700 }) // explicit modes, whatever the umask
  writeFileSync(h.ledger.replyPath(PLAN_ID), 'squatted', { mode: 0o600 })
  await assert.rejects(h.submit(c, plan()), /The plan could not be stored; this advisor child is stopped/)
  assert.equal(c.agent.cancelled, 1)
  assert.equal(readFileSync(h.ledger.replyPath(PLAN_ID), 'utf8'), 'squatted', 'the existing reply is not replaced')
  assert.equal(h.boundary.plans.has(PLAN_ID), false)
  await settle()
  assert.match(h.terminal()[0].failure_reason, /^reply file write failed: .*EEXIST/)
})

test('submit: a stop while the reply is being written leaves exactly one failed line and no recorded result', async (t) => {
  const stops = [
    ['subagent/end', {}, (h, c) => h.end(c), 'child ended without a recorded result'],
    ['plugin disposal', {}, (h) => h.dispose(), 'advisor plugin unloaded'],
    ['tool-call cap', { maxToolCalls: 2 }, (h, c) => {
      assert.equal(h.run(c, 'read', { file_path: 'src/a.js' }), undefined)
      assert.match(h.run(c, 'read', { file_path: 'src/a.js' }), /budget exhausted/)
    }, 'tool-call cap (2) reached'],
    ['wall-clock cap', { maxMs: 20 }, () => sleep(80), 'wall-clock cap (0 min) reached'],
    ['Advisor turned off and a concurrent submit', {}, async (h, c) => {
      h.state.settings = { active: false, advisorModel: null }
      await assert.rejects(c.registered.get(c.tool).execute(advice(), { name: c.tool, agent: c.agent }), /recording its advice/)
      h.end(c)
    }, 'child ended without a recorded result'],
  ]
  for (const [label, options, stop, reason] of stops) {
    const h = harness(options)
    t.after(h.dispose)
    const c = startConsult(h)
    const held = holdWrite(h)
    const pending = h.submit(c, advice())
    await settle()
    assert.equal(typeof held.release, 'function', `${label}: the submit is suspended in writeReply`)
    await stop(h, c)
    held.release()
    await assert.rejects(pending, /This advisor child was stopped before its advice was recorded/, label)
    await settle()
    assert.deepEqual(h.reasons(), [['started', undefined], ['failed', reason]], label)
    assert.equal(h.boundary.plans.has(PLAN_ID), false, `${label}: no pin`)
    assert.equal(existsSync(h.ledger.replyPath(PLAN_ID)), true, `${label}: the written reply stays and marks the id used`)
  }
})

test('submit: a stop during the ok-line append keeps the single ok line', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const c = startChild(h)
  let releaseAppend
  const appending = new Promise((signal) => {
    h.state.beforeAppend = (line) => {
      if (line.status !== 'ok') return undefined
      signal()
      return new Promise((resolve) => { releaseAppend = resolve })
    }
  })
  const pending = h.submit(c, plan())
  await appending // the reply is written and the ok line is being appended
  assert.match(h.run(c, 'read', { file_path: 'src/a.js' }), /This advisor child has stopped/)
  h.end(c)
  releaseAppend()
  assert.equal((await pending).plan_id, PLAN_ID)
  await settle()
  assert.deepEqual(h.statuses(), ['started', 'ok'])
  assert.equal(h.boundary.plans.has(PLAN_ID), true)
})

test('submit: a failed ok-line append fails the child and is reported', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const c = startConsult(h)
  h.state.failAppend = (line) => line.status === 'ok'
  await assert.rejects(h.submit(c, advice()), /The advice could not be recorded in the ledger; this advisor child is stopped/)
  assert.equal(c.agent.cancelled, 1)
  await settle()
  assert.deepEqual(h.reasons(), [['started', undefined], ['failed', 'ledger append failed: ledger disk full']])
  assert.equal(h.boundary.plans.has(PLAN_ID), false)
  assert.match(h.run(c, 'read', { file_path: 'src/a.js' }), /This advisor child has stopped/)
  assert.equal(h.call('subagent', { name: `advisor-verifier-${PLAN_ID}` }), undefined, 'no pin, so no hash check either')
})

// ===========================================================================
// 4. installPlannerBoundary: end, caps, hash pinning, usage, dispose

test('end: ending without a result writes exactly one failed line and frees the root', async (t) => {
  const h = harness()
  t.after(h.dispose)
  assert.equal(h.delegate({ name: CONSULT }), undefined)
  const c = startConsult(h)
  h.end(c)
  h.agentDisposed(c)
  h.end(c)
  await settle()
  assert.deepEqual(h.reasons(), [['started', undefined], ['failed', 'child ended without a recorded result']])
  assert.equal(h.terminal()[0].kind, 'advice')
  assert.equal(c.agent.cancelled, 0, 'an ended child is not cancelled')
  assert.equal(h.boundary.records.size, 0)
  assert.equal(h.boundary.livePlanners.size, 0)
  assert.match(h.delegate({ name: CONSULT }), /already used/)
  assert.match(h.delegate(), /already used/, 'nor can the id come back as a plan id')
  assert.equal(h.delegate({ name: PLANNER_B }), undefined)
})

test('end: ending after a recorded result adds no line', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const c = startChild(h)
  await h.submit(c, plan())
  h.end(c)
  h.agentDisposed(c)
  await settle()
  assert.deepEqual(h.statuses(), ['started', 'ok'])
})

test('caps: the wall-clock cap fails and cancels a running child; a submit clears it', async (t) => {
  const h = harness({ maxMs: 20 })
  t.after(h.dispose)
  const c = startChild(h)
  await sleep(80)
  assert.equal(c.agent.cancelled, 1)
  await settle()
  assert.deepEqual(h.statuses(), ['started', 'failed'])
  assert.match(h.terminal()[0].failure_reason, /^wall-clock cap/)
  assert.match(h.run(c, 'read', { file_path: 'src/a.js' }), /This advisor child has stopped/)
  assert.equal(h.boundary.livePlanners.size, 0, 'a failed child releases the slot')

  const quick = harness({ maxMs: 40 })
  t.after(quick.dispose)
  const c2 = startConsult(quick)
  await quick.submit(c2, advice())
  await sleep(100)
  assert.equal(c2.agent.cancelled, 0)
  await settle()
  assert.deepEqual(quick.statuses(), ['started', 'ok'])
})

test('hash pinning: the verifier for a recorded plan or advice starts only while the reply file is unchanged', async (t) => {
  for (const [self, value] of [[PLANNER, plan()], [CONSULT, advice()]]) {
    const h = harness()
    t.after(h.dispose)
    const verifier = { name: `advisor-verifier-${PLAN_ID}` }
    assert.equal(h.call('subagent', verifier), undefined, 'no pin before a result is recorded')
    const c = startChild(h, { self })
    const result = await h.submit(c, value)
    assert.equal(h.call('subagent', verifier), undefined, self)
    const original = readFileSync(result.reply_file)
    writeFileSync(result.reply_file, Buffer.concat([original, Buffer.from(' ')]))
    assert.match(h.call('subagent', verifier), /no longer matches the hash recorded by the host/, self)
    writeFileSync(result.reply_file, original)
    assert.equal(h.call('subagent', verifier), undefined)
    rmSync(result.reply_file)
    assert.match(h.call('subagent', verifier), /no longer matches the hash/, `${self}: a deleted reply is a mismatch`)
    assert.equal(h.call('subagent', { name: 'advisor-verifier-999999999999' }), undefined, 'other ids are not pinned')
    h.end(c)
    assert.match(h.call('subagent', verifier), /no longer matches the hash/, 'the pin outlives the child record')
  }
})

test('usage: terminal lines carry the child\'s token usage; started lines do not', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const c = startConsult(h, { events: [{ type: 'assistant/message', data: { usage: { inputTokens: 7, outputTokens: 3 } } }] })
  h.end(c)
  await settle()
  const [started, failed] = h.state.ledger
  assert.equal(Object.hasOwn(started, 'input_tokens'), false)
  assert.deepEqual([failed.input_tokens, failed.output_tokens, failed.model_requests, failed.cost_usd], [7, 3, 1, null])

  const blind = harness()
  t.after(blind.dispose)
  const b = startChild(blind, { events: () => { throw new Error('log closed') } })
  await blind.submit(b, plan())
  await settle()
  const [, ok] = blind.state.ledger
  assert.deepEqual([ok.status, ok.input_tokens, ok.output_tokens, ok.model_requests], ['ok', null, null, undefined], 'a throwing log still records the result')
})

test('dispose: fails open children once, removes hooks and registrations, keeps the child guard', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const c = startConsult(h)
  await settle()
  h.dispose()
  assert.equal(h.hostGuards.length, 0)
  for (const [name, list] of h.listeners) assert.equal(list.length, 0, name)
  assert.equal(h.boundary.records.size, 0)
  assert.equal(c.agent.cancelled, 1)
  assert.equal(c.registered.has(ADVICE_TOOL), false)
  assert.equal(c.registered.has('grep'), false)
  assert.equal(c.sections.length, 0)
  assert.match(c.guards[0]({ name: 'bash', arguments: {}, agent: c.agent }), /read-only/, 'the child guard outlives the plugin')
  assert.match(c.guards[0]({ name: 'read', arguments: { file_path: 'src/a.js' }, agent: c.agent }), /stopped/)
  h.end(c)
  await settle()
  assert.deepEqual(h.reasons(), [['started', undefined], ['failed', 'advisor plugin unloaded']])
})

// ===========================================================================
// 5. The plugin-owned ledger: deps.ledger, fail closed, containment, two hosts.
// (Unit and cross-process tests of src/ledger.js are in ledger.test.mjs.)

test('policy: an unverifiable plan task keeps its confirmed level, except that a confirmed mechanical one becomes ordinary', () => {
  // The model router never raises work that clearly meets a lower level's
  // criteria for safety, so the planner text must not raise every unverifiable
  // task one step. Only a task whose confirmed level is mechanical, whose "no
  // judgment" criterion a doubted premise puts in question, goes up (to
  // ordinary). The exception keys on the confirmed level, not the plan's: a
  // task the plan calls mechanical but the lead raised to hard stays hard.
  const text = ADVISOR_WORKFLOW
  const rule = text.split('\n').find((line) => line.includes('Unverifiable task:'))
  assert.ok(rule, 'the plan rule names the unverifiable case')
  assert.doesNotMatch(text, /raise its level one step/, 'no blanket one-step raise')
  assert.match(rule, /accept it and copy the doubt into its description/)
  assert.match(rule, /keep its confirmed level/)
  assert.match(rule, /a task whose confirmed level is mechanical becomes ordinary/)
  assert.doesNotMatch(rule, /the plan calls mechanical/, 'not the level the plan gave')
  assert.equal(text.split('Unverifiable task:').length - 1, 1, 'the rule appears once')
  // The level rule next to it still resolves doubt upward and never to mechanical.
  assert.match(text, /raise when in doubt, never lower substantive work to mechanical/)
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.doesNotMatch(readme, /An unverifiable task goes up one level/)
  assert.doesNotMatch(readme, /except that a mechanical one goes up to ordinary/)
  assert.match(readme, /An unverifiable task keeps its confirmed level, except that one confirmed as mechanical goes up to ordinary/)
})

test('policy: advisorWorkflow names the absolute ledger and replies paths; ADVISOR_WORKFLOW keeps placeholders', () => {
  const dataDir = path.join(TMP, 'workflow-data')
  const ledger = createLedger(dataDir)
  const text = advisorWorkflow({ ledgerPath: ledger.ledgerPath, repliesDir: ledger.repliesDir })
  assert.ok(text.includes(`the ledger \`${path.join(dataDir, 'sessions.jsonl')}\``), 'absolute ledger file')
  assert.ok(text.includes(`the reply file \`${path.join(dataDir, 'replies', '<id>.md')}\``), 'absolute replies/<id>.md')
  const earlier = 'Runs recorded before this folder existed are not verified from here.'
  assert.equal(text.split(earlier).length - 1, 1, 'the earlier-runs sentence appears once')
  assert.doesNotMatch(text, /<state>|<dataDir>/)
  assert.equal(PLANNER_WORKFLOW, ADVISOR_WORKFLOW)
  assert.equal(ADVISOR_WORKFLOW, advisorWorkflow({ ledgerPath: '<dataDir>/sessions.jsonl', repliesDir: '<dataDir>/replies' }))
  assert.doesNotMatch(ADVISOR_WORKFLOW, /<state>/)
  assert.ok(ADVISOR_WORKFLOW.includes(earlier))
  const placeholders = text
    .replace(path.join(dataDir, 'replies', '<id>.md'), '<dataDir>/replies/<id>.md')
    .replace(ledger.ledgerPath, '<dataDir>/sessions.jsonl')
  assert.equal(placeholders, ADVISOR_WORKFLOW, 'only the two paths differ')
  for (const bad of [{}, { ledgerPath: ledger.ledgerPath }, { repliesDir: ledger.repliesDir }, { ledgerPath: 1, repliesDir: 2 }]) {
    assert.throws(() => advisorWorkflow(bad), TypeError, JSON.stringify(bad))
  }
})

test('fail closed: without deps.ledger or overrides every advisor-planner and advisor-consult delegation is refused', async (t) => {
  const message = 'Advisor data directory is not configured; set dataDir in the advisor plugin config.'
  assert.equal(DATA_DIR_NOT_CONFIGURED, message)
  const h = harness({ ledgerMode: 'none' })
  t.after(h.dispose)
  for (const name of [PLANNER, CONSULT, PLANNER_B, CONSULT_B, 'advisor-planner', 'advisor-consult-x', `${PLANNER}-x`]) {
    for (const tool of ['subagent', 'subagent_fork', 'subagent_claude_code', 'subagent_codex']) {
      assert.equal(h.delegate({ name }, { tool }), message, `${tool} ${name}`)
    }
  }
  h.state.settings = { active: true, advisorModel: ROUTE }
  assert.equal(h.delegate({ ...ROUTE }), message, 'a valid selected route does not help')
  assert.equal(h.delegate({ ...ROUTE }, { agent: h.mate }), message)
  assert.equal(h.call('subagent', { name: 'reviewer' }), undefined, 'other children are unaffected')
  assert.equal(h.call('subagent', { name: `advisor-verifier-${PLAN_ID}` }), undefined)
  assert.match(h.call('subagent', { name: 'advisor-foo' }), /reserved for Advisor roles/)

  // A reserved child that starts anyway (for example a resumed one) fails closed and writes nothing.
  h.state.settings = { active: true, advisorModel: null }
  const c = h.child()
  h.start(c)
  assert.equal(c.agent.cancelled, 1)
  assert.equal(h.boundary.livePlanners.size, 0)
  for (const tool of [SUBMIT_TOOL, ADVICE_TOOL, 'grep']) assert.equal(c.registered.has(tool), false, tool)
  for (const name of ['read', 'glob', 'grep', SUBMIT_TOOL, 'bash']) {
    assert.match(h.run(c, name, { file_path: 'src/a.js', pattern: 'x' }) ?? 'ALLOWED', /failed closed|only available to its advisor child/, name)
  }
  h.end(c)
  await settle()
  assert.ok(h.logs.some((line) => line.includes(`refusing ${PLANNER}: ${message}`)), h.logs.join('\n'))
  assert.deepEqual(tree(h.dir), [], 'no ledger line or reply anywhere')
  assert.equal(h.boundary.records.size, 0)
})

test('fail closed: an incomplete ledger is no ledger', (t) => {
  const dir = mkdtempSync(path.join(TMP, 'partial-'))
  const full = createLedger(dir)
  const partials = [
    { appendLedger: async () => {} },
    { appendLedger: async () => {}, writeReply: async () => ({}), idInUse: () => false },
    { ledger: {} },
    { ledger: null },
    { ledger: { ...full, idInUse: undefined } },
    { ledger: full, ledgerEntriesFor: null },
  ]
  for (const partial of partials) {
    const h = harness({ ledgerMode: 'none', ...partial })
    t.after(h.dispose)
    assert.equal(h.delegate(), DATA_DIR_NOT_CONFIGURED, Object.keys(partial).join(','))
  }
  assert.deepEqual(tree(dir), [])
})

test('deps.ledger: with no overrides, lines, replies and id checks all use the ledger files', async (t) => {
  const h = harness({ ledgerMode: 'real' })
  t.after(h.dispose)
  assert.equal(h.delegate({ name: CONSULT }), undefined)
  const c = startConsult(h)
  await until(() => h.lines().length === 1, 'the started line')
  assert.deepEqual(h.lines().map((line) => [line.consult_id, line.kind, line.status]), [[PLAN_ID, 'advice', 'started']])
  const result = await h.submit(c, advice())
  await until(() => h.lines().length === 2, 'the ok line')
  assert.equal(result.reply_file, h.ledger.replyPath(PLAN_ID))
  assert.equal(result.reply_sha256, sha256(readFileSync(result.reply_file)))
  const [, ok] = h.lines()
  assert.deepEqual([ok.status, ok.kind, ok.reply_file, ok.reply_sha256, ok.claim_count], ['ok', 'advice', result.reply_file, result.reply_sha256, 2])
  h.end(c)
  await settle()
  assert.match(h.delegate({ name: CONSULT }), /^id abcdef012345 is already used in the ledger or replies; generate a new one\.$/)
  assert.match(h.delegate(), /already used/, 'the ledger keeps a consult id from coming back as a plan id')
  assert.equal(h.delegate({ name: PLANNER_B }), undefined)
  assert.deepEqual(tree(h.dir), ['replies/', `replies/${PLAN_ID}.md`, 'sessions.jsonl'])
  assert.deepEqual(h.statuses(), ['started', 'ok'], 'end after a result adds no line')
})

test('deps.ledger: per-function deps override the ledger one by one', async (t) => {
  const used = harness({ ledgerMode: 'real', idInUse: () => true })
  t.after(used.dispose)
  assert.match(used.delegate(), /already used/, 'idInUse override wins over an empty ledger')

  const recorded = []
  const h = harness({ ledgerMode: 'real', appendLedger: async (line) => { recorded.push(line) } })
  t.after(h.dispose)
  const c = startChild(h)
  const result = await h.submit(c, plan())
  await settle()
  assert.deepEqual(recorded.map((line) => line.status), ['started', 'ok'], 'appendLedger override receives the lines')
  assert.equal(existsSync(h.ledger.ledgerPath), false, 'the ledger file is not written')
  assert.equal(result.reply_file, h.ledger.replyPath(PLAN_ID), 'writeReply still comes from deps.ledger')

  const old = harness({ ledgerMode: 'overrides' })
  t.after(old.dispose)
  assert.equal(old.delegate(), undefined, 'the four per-function deps alone still configure the boundary')
  const o = startChild(old)
  assert.equal((await old.submit(o, plan())).plan_id, PLAN_ID)
  await settle()
  assert.deepEqual(old.statuses(), ['started', 'ok'])
})

test('containment: a full submit through apply() writes only dataDir/sessions.jsonl and dataDir/replies/<id>.md', async (t) => {
  const box = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'advisor-containment-')))
  t.after(() => rmSync(box, { recursive: true, force: true }))
  const decoys = {
    HOME: path.join(box, 'home'),
    XDG_STATE_HOME: path.join(box, 'xdg-state'),
    DSH_HOME: path.join(box, 'dsh-home'),
    ADVISOR_LEDGER: path.join(box, 'advisor-ledger', 'sessions.jsonl'),
  }
  for (const dir of [decoys.HOME, decoys.XDG_STATE_HOME, decoys.DSH_HOME, path.dirname(decoys.ADVISOR_LEDGER)]) mkdirSync(dir)
  decoyEnv(t, decoys)
  assert.equal(os.homedir(), decoys.HOME, 'os.homedir() would land in the decoy')
  const dataDir = path.join(box, 'data') // created by the plugin
  // profileContext.home is the decoy DSH home: the configured dataDir must win over it.
  const h = await hostHarness({ dataDir }, { home: decoys.DSH_HOME, dataDir })
  t.after(h.dispose)

  assert.equal(h.delegate(), undefined)
  const c = startChild(h)
  const result = await h.submit(c, plan())
  await until(() => h.lines().length === 2, 'the started and ok lines')
  h.end(c)
  await settle()

  assert.ok(path.isAbsolute(result.reply_file), result.reply_file)
  assert.equal(result.reply_file, path.join(dataDir, 'replies', `${PLAN_ID}.md`))
  assert.equal(path.relative(dataDir, result.reply_file), path.join('replies', `${PLAN_ID}.md`), 'inside dataDir')
  assert.deepEqual(tree(box), [
    'advisor-ledger/',
    'data/',
    'data/replies/',
    `data/replies/${PLAN_ID}.md`,
    'data/sessions.jsonl',
    'dsh-home/',
    'home/',
    'xdg-state/',
  ], 'only the two data files were created; every decoy is still empty')
  assert.equal(statSync(dataDir).mode & 0o777, 0o700)
  assert.equal(statSync(path.join(dataDir, 'replies')).mode & 0o777, 0o700)
  assert.equal(statSync(path.join(dataDir, 'sessions.jsonl')).mode & 0o777, 0o600)
  assert.equal(statSync(result.reply_file).mode & 0o777, 0o600)
  assert.deepEqual(h.statuses(), ['started', 'ok'])
  const [, ok] = h.lines()
  assert.equal(ok.reply_file, result.reply_file)
  assert.equal(ok.reply_sha256, sha256(readFileSync(result.reply_file)))
  assert.match(h.delegate(), /already used/, 'the host reads the same ledger back')

  const [section] = h.sections
  const prompt = section.text({ agent: h.lead })
  assert.ok(prompt.includes(`\`${path.join(dataDir, 'sessions.jsonl')}\``), 'the lead is told the ledger path')
  assert.ok(prompt.includes(`\`${path.join(dataDir, 'replies', '<id>.md')}\``), 'and the reply path')
  const status = await h.command().handler({ agent: h.lead, rawInput: 'status' })
  assert.match(status.text, new RegExp(`Data directory: ${escapeRegExp(dataDir)}\\n`))
  assert.match(status.text, new RegExp(`${PLAN_ID} dsh plan ok unset`))
})

test('fail closed through apply(): no usable dataDir refuses advisor children, warns, and writes nothing', async (t) => {
  const box = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'advisor-unconfigured-')))
  t.after(() => rmSync(box, { recursive: true, force: true }))
  const decoys = {
    HOME: path.join(box, 'home'),
    XDG_STATE_HOME: path.join(box, 'xdg-state'),
    DSH_HOME: path.join(box, 'dsh-home'),
    ADVISOR_LEDGER: path.join(box, 'advisor-ledger', 'sessions.jsonl'),
  }
  for (const dir of [decoys.HOME, decoys.XDG_STATE_HOME, decoys.DSH_HOME, path.dirname(decoys.ADVISOR_LEDGER)]) mkdirSync(dir)
  decoyEnv(t, decoys)
  const cases = [
    ['no config and no DSH home', undefined, undefined, /Advisor dataDir is not configured/],
    ['empty config and no DSH home', {}, undefined, /Advisor dataDir is not configured/],
    ['relative dataDir beside a DSH home', { dataDir: 'advisor-data' }, decoys.DSH_HOME, /absolute path/],
    ['~ dataDir beside a DSH home', { dataDir: '~/advisor' }, decoys.DSH_HOME, /absolute path/],
    ['.. dataDir beside a DSH home', { dataDir: path.join(box, 'x') + '/../data' }, decoys.DSH_HOME, /"\.\." segments/],
    ['relative DSH home', {}, 'dsh-home', /Advisor dataDir is not configured/],
  ]
  for (const [label, config, home, problem] of cases) {
    const h = await hostHarness(config, { home })
    t.after(h.dispose)
    assert.ok(h.logs.some((line) => problem.test(line) && line.includes('Advisor children are refused until dataDir is set in the advisor plugin config.')), `${label}: ${h.logs.join('\n')}`)
    assert.equal(h.delegate(), DATA_DIR_NOT_CONFIGURED, label)
    assert.equal(h.delegate({ name: CONSULT }), DATA_DIR_NOT_CONFIGURED, label)
    const c = h.child()
    h.start(c)
    assert.equal(c.agent.cancelled, 1, `${label}: a child that starts anyway is stopped`)
    const status = await h.command().handler({ agent: h.lead, rawInput: 'status' })
    assert.equal(status.kind, 'success')
    assert.match(status.text, /Advisor data directory is not configured; set dataDir in the advisor plugin config\.\nReason: /, label)
    assert.match(status.text, problem, label)
    assert.doesNotMatch(status.text, /Recent advisor runs|Data directory:/, label)
    const prompt = h.sections[0].text({ agent: h.lead })
    assert.match(prompt, /Advisor data directory is not configured/, label)
    assert.doesNotMatch(prompt, /sessions\.jsonl|replies/, `${label}: no workflow without a folder`)
  }
  assert.deepEqual(tree(box), ['advisor-ledger/', 'dsh-home/', 'home/', 'xdg-state/'], 'nothing was written anywhere')
})

test('cross-host: two boundaries on one dataDir; the second refuses an id the first used', async (t) => {
  const dataDir = path.join(TMP, 'two-hosts')
  const first = harness({ ledgerMode: 'real', dataDir })
  const second = harness({ ledgerMode: 'real', dataDir })
  t.after(first.dispose)
  t.after(second.dispose)
  assert.notEqual(first.ledger, second.ledger, 'each host has its own ledger instance')
  assert.equal(first.delegate(), undefined)
  const c = startChild(first)
  await until(() => second.ledger.idInUse(PLAN_ID), 'the first host\'s started line')
  assert.match(second.delegate(), /^id abcdef012345 is already used in the ledger or replies; generate a new one\.$/)
  assert.match(second.delegate({ name: CONSULT }), /^id abcdef012345 is already used in the ledger or replies/)

  // The other kind under that id is refused at start on the second host and writes nothing.
  const other = second.child({ id: 'consult-on-second', self: CONSULT })
  second.start(other)
  assert.equal(other.agent.cancelled, 1)
  assert.match(second.run(other, 'read', { file_path: 'src/a.js' }), /failed closed/)

  const result = await first.submit(c, plan())
  await until(() => first.lines().length === 2, 'the first host\'s ok line')
  first.end(c)
  second.end(other)
  await settle()
  assert.match(second.delegate(), /already used/)
  assert.equal(existsSync(result.reply_file), true)
  assert.equal(second.delegate({ name: PLANNER_B }), undefined, 'a fresh id is still available on the second host')
  assert.deepEqual(second.lines(), first.lines(), 'one shared ledger file')
  assert.deepEqual(first.lines().map((line) => [line.consult_id, line.kind, line.status]), [[PLAN_ID, 'plan', 'started'], [PLAN_ID, 'plan', 'ok']])
})

test('fail closed: a data directory that is or becomes unwritable refuses advisor children at delegation and at start, until it is fixed', async (t) => {
  const dataDir = path.join(TMP, 'becomes-unwritable')
  const h = harness({ ledgerMode: 'real', dataDir })
  t.after(h.dispose)
  t.after(() => { if (existsSync(dataDir) && statSync(dataDir).isDirectory()) chmodSync(dataDir, 0o700) })
  const refusal = (problem) => `Advisor data directory is ${problem}. Fix it or set another dataDir in the advisor plugin config.`
  assert.equal(h.delegate(), undefined, 'the missing folder can be created under TMP')

  writeFileSync(dataDir, 'a regular file now')
  const notFolder = refusal(`not writable: ${dataDir} is not a directory`)
  assert.equal(h.delegate(), notFolder, 'probed again at the next delegation, even for the reserved name')
  assert.equal(h.delegate({ name: CONSULT_B }), notFolder)
  const c = h.child()
  h.start(c)
  assert.equal(c.agent.cancelled, 1, 'a child that starts anyway is stopped')
  assert.equal(h.boundary.livePlanners.size, 0)
  assert.match(h.run(c, 'read', { file_path: 'src/a.js' }), /failed closed/)
  assert.ok(h.logs.some((line) => line === `advisor planner: refusing ${PLANNER}: ${notFolder}`), h.logs.join('\n'))
  await until(() => h.logs.some((line) => line.startsWith(`advisor planner: ledger write failed for ${PLAN_ID}`)), 'the failed line attempt')
  h.end(c)

  rmSync(dataDir)
  assert.equal(h.delegate({ name: PLANNER_B }), undefined, 'fixed: allowed again without a restart')
  mkdirSync(dataDir, { mode: 0o700 })
  const linked = path.join(TMP, 'becomes-unwritable-target.jsonl')
  writeFileSync(linked, '')
  symlinkSync(linked, path.join(dataDir, 'sessions.jsonl'))
  assert.equal(h.delegate({ name: PLANNER_B }), refusal(`not writable: ${path.join(dataDir, 'sessions.jsonl')} is a symbolic link`))
  rmSync(path.join(dataDir, 'sessions.jsonl'))
  assert.equal(h.delegate({ name: PLANNER_B }), undefined)
  if (process.getuid) {
    chmodSync(dataDir, 0o777)
    assert.equal(h.delegate({ name: PLANNER_B }), refusal(`unsafe: ${dataDir} is writable by group or others (mode 0777)`))
  }
  if (process.getuid?.() !== 0) {
    chmodSync(dataDir, 0o500)
    assert.equal(h.delegate({ name: PLANNER_B }), refusal(`not writable: ${dataDir} denies writes (EACCES)`))
  }
  chmodSync(dataDir, 0o700)
  assert.equal(h.delegate({ name: PLANNER_B }), undefined)
  assert.equal(readFileSync(linked, 'utf8'), '', 'nothing was written through the symlink')
})

test('fail closed through apply(): advisor-verifier delegations are refused while the ledger is not ready, and allowed once it is', async (t) => {
  const verifier = { name: `advisor-verifier-${PLAN_ID}` }
  const unconfigured = await hostHarness(undefined)
  t.after(unconfigured.dispose)
  assert.equal(unconfigured.call('subagent', verifier), DATA_DIR_NOT_CONFIGURED)
  assert.equal(unconfigured.call('subagent_fork', verifier), DATA_DIR_NOT_CONFIGURED)
  assert.equal(unconfigured.call('subagent', { name: 'reviewer' }), undefined, 'other children are unaffected')
  const stray = unconfigured.child({ id: 'verifier-stray', self: `advisor-verifier-${PLAN_ID}` })
  unconfigured.start(stray)
  assert.equal(stray.agent.cancelled, 1, 'a verifier that starts anyway is stopped')
  assert.match(unconfigured.run(stray, 'read', { file_path: 'src/a.js' }), /^Advisor verifier failed closed: no tools are permitted\.$/)
  assert.ok(unconfigured.logs.includes(`advisor: stopping advisor-verifier-${PLAN_ID}: ${DATA_DIR_NOT_CONFIGURED}`), unconfigured.logs.join('\n'))

  const box = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'advisor-verifier-ready-')))
  t.after(() => rmSync(box, { recursive: true, force: true }))
  const dataDir = path.join(box, 'data')
  writeFileSync(dataDir, 'not a folder yet', { mode: 0o600 })
  const h = await hostHarness({ dataDir }, { dataDir })
  t.after(h.dispose)
  const refusal = `Advisor data directory is not writable: ${dataDir} is not a directory. Fix it or set another dataDir in the advisor plugin config.`
  assert.ok(h.logs.includes(`advisor: ${refusal} Advisor children are refused until then.`), h.logs.join('\n'))
  assert.equal(h.call('subagent', verifier), refusal)
  assert.equal(h.delegate(), refusal)
  assert.equal(h.delegate({ name: CONSULT }), refusal)
  const on = await h.command().handler({ agent: h.lead, rawInput: 'on' })
  assert.equal(on.text, `Advisor on. The in-process advisor and read-only verification are enabled.\n${refusal} Until then advisor runs and verification are refused.`)
  assert.equal(h.sections[0].text({ agent: h.lead }), unavailablePolicy(refusal))

  const early = h.child({ id: 'verifier-early', self: `advisor-verifier-${PLAN_ID}` })
  h.start(early)
  assert.equal(early.agent.cancelled, 1, 'stopped while the folder is not writable')
  assert.match(h.run(early, 'read', { file_path: 'src/a.js' }), /failed closed/)
  rmSync(dataDir)
  assert.equal(h.call('subagent', verifier), undefined, 'allowed once the folder is usable')
  const later = h.child({ id: 'verifier-later', self: `advisor-verifier-${PLAN_ID_B}` })
  h.start(later)
  assert.equal(later.agent.cancelled, 0, 'a verifier starting once the folder is usable keeps running')
  assert.equal(h.run(later, 'read', { file_path: 'src/a.js' }), undefined)
  assert.equal(h.delegate(), undefined)
  assert.ok(h.sections[0].text({ agent: h.lead }).includes(`the ledger \`${path.join(dataDir, 'sessions.jsonl')}\``))
  assert.match(h.call('subagent', { name: 'advisor-verifier-bad' }), /12-character/, 'the other verifier checks still apply')
})

/** The verifier's denial while an effort is stored and a delegation does not pass it with the exact route. */
const verifierEffortDenial = (route) => `Advisor verifier must use the selected route ${route.provider}/${route.model} with reasoning_effort "${route.effort}". Do not omit or change the effort; the user can reset it with /advisor verifier-model ${route.provider}/${route.model}.`
const VERIFIER_TEXTS = Object.freeze({
  mustOmit: VERIFIER_MUST_OMIT,
  inherit: 'Advisor verifier is set to Inherit; omit provider and model instead of overriding them.',
  wrongRoute: (route) => `Advisor verifier must use the selected route ${route.provider}/${route.model}.`,
  effortRequired: verifierEffortDenial,
  presetRequired: (route) => `Advisor verifier must omit agent_preset and use the selected route ${route.provider}/${route.model} with reasoning_effort "${route.effort}". Do not omit or change the effort; the user can reset it with /advisor verifier-model ${route.provider}/${route.model}.`,
})

test('prompt and guards through apply(): in every state the lead policy\'s spawn arguments pass both delegation guards, and each deviation is denied', async (t) => {
  for (const name of [PLANNER, CONSULT]) {
    const dataDir = path.join(TMP, `prompt-guard-${name}`)
    const h = await hostHarness({ dataDir }, { dataDir })
    t.after(h.dispose)
    h.state.routes = [...SETTING_ROUTES]
    for (const advisorModel of SETTINGS) {
      for (const verifierModel of SETTINGS) {
        const label = `${name} advisor ${JSON.stringify(advisorModel)} verifier ${JSON.stringify(verifierModel)}`
        h.state.settings = { active: true, advisorModel, verifierModel, pending: null }
        const lines = h.sections[0].text({ agent: h.lead }).split('\n')
        const advisorArgs = argsFromPolicy(lines.find((line) => line.startsWith('Advisor model: ')), 'Advisor model')
        const verifierArgs = argsFromPolicy(lines.find((line) => line.startsWith('Verifier model: ')), 'Verifier model')
        assert.deepEqual(advisorArgs, spawnArgs(advisorModel) ?? {}, label)
        assert.deepEqual(verifierArgs, spawnArgs(verifierModel) ?? {}, label)
        const verifier = `advisor-verifier-${PLAN_ID_B}`
        for (const [deviation, changed, denial] of spawnDeviations(verifierModel, VERIFIER_TEXTS)) {
          assert.equal(h.call('subagent', { name: verifier, ...changed }), denial, `${label}: verifier ${deviation}`)
        }
        assert.equal(h.call('subagent', { name: verifier, ...verifierArgs }), undefined, `${label}: the verifier policy's own arguments pass`)
        for (const [deviation, changed, denial] of spawnDeviations(advisorModel, ADVISOR_TEXTS)) {
          assert.equal(h.delegate({ name, ...changed }), denial, `${label}: advisor ${deviation}`)
        }
        // The same name each time: a retry of the reserved child stays allowed.
        assert.equal(h.delegate({ name, ...advisorArgs }), undefined, `${label}: the advisor policy's own arguments pass`)
      }
    }
  }
})
