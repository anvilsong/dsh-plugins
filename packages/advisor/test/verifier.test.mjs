// Adversarial tests for the read-only advisor verifier (src/verifier.js):
// workspace confinement of read, glob and grep, the workspace root taken at
// start, the zero-argument evidence tool, and the default-deny allowlist.
// Everything this file writes lives under TMP. The "~/.dsh-like" paths are
// fixtures under TMP, and "~" paths are refused lexically before any file
// access, so the real ~/.dsh and ~/.local/state are never read, listed or
// written.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs, { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { apply } from '../src/index.host.js'
import { createLedger, fileSha256Sync, sha256 } from '../src/ledger.js'
import { DATA_DIR_NOT_CONFIGURED, dataDirUnusable } from '../src/planner.js'
import { parseModelSetting, spawnArgs } from '../src/state.js'
import {
  EVIDENCE_PART_BYTES,
  EVIDENCE_TOOL,
  installVerifierBoundary,
  MAX_EVIDENCE_REPLY_BYTES,
  VERIFIER_POLICY,
  VERIFIER_TOOLS,
  VERIFIER_WORKFLOW,
  verifierDelegationDenial,
  verifierModelPolicy,
  verifierToolDenial,
} from '../src/verifier.js'

const TMP = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'advisor-verifier-test-')))
after(() => rmSync(TMP, { recursive: true, force: true }))

const ID = 'abcdef012345'
const OTHER_ID = '0123456789ab'
const VERIFIER = `advisor-verifier-${ID}`
const OTHER_VERIFIER = `advisor-verifier-${OTHER_ID}`
const README = fileURLToPath(new URL('../README.md', import.meta.url))

// ---------------------------------------------------------------------------
// Fixtures: a workspace with ordinary and protected files, symlinks that leave
// it, an outside canary, a home-like folder with a decoy DSH ledger, and a
// data directory (outside the workspace, like <DSH home>/advisor) that the
// workspace links into.

const WS = path.join(TMP, 'ws')
const OUT = path.join(TMP, 'outside')
const HOME_LIKE = path.join(TMP, 'home') // stands in for ~; never the real home
const DSH_LIKE_LEDGER = path.join(HOME_LIKE, '.dsh', 'advisor', 'sessions.jsonl')
const DSH_LIKE_STATE = path.join(HOME_LIKE, '.local', 'state', 'advisor', 'replies', `${ID}.md`)
function put(file, text = 'x\n') {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}
put(path.join(WS, 'src/a.js'), 'export const a = 1\n')
for (const file of ['src/sub/b.js', 'docs/readme.md', '.env.example']) put(path.join(WS, file))
const PROTECTED = {
  '.env': 'FAKE_SECRET_ENV=1\n',
  id_rsa: 'FAKE_SECRET_KEY\n',
  'x.pem': 'FAKE_SECRET_PEM\n',
  '.git/config': 'FAKE_SECRET_GIT\n',
  'nested/.ssh/known_hosts': 'FAKE_SECRET_SSH\n',
  'config/credentials.json': '{"token":"FAKE_SECRET_CRED"}\n',
}
for (const [file, text] of Object.entries(PROTECTED)) put(path.join(WS, file), text)
put(path.join(OUT, 'canary.txt'), 'FAKE_OUTSIDE_CANARY\n')
mkdirSync(path.join(OUT, 'inner'), { recursive: true })
put(DSH_LIKE_LEDGER, `{"consult_id":"${ID}","topic":"FAKE_HOME_LEDGER"}\n`)
put(DSH_LIKE_STATE, 'FAKE_HOME_REPLY\n')
const FIXED_DATA = path.join(TMP, 'fixed-data')
const FIXED_LEDGER = createLedger(FIXED_DATA)
put(FIXED_LEDGER.ledgerPath, `{"consult_id":"${ID}","topic":"FAKE_FIXED_LEDGER"}\n`)
put(FIXED_LEDGER.replyPath(ID), 'FAKE_FIXED_REPLY\n')
mkdirSync(path.join(WS, 'a'), { recursive: true })
symlinkSync(OUT, path.join(WS, 'link-out')) // directory symlink out of the workspace
symlinkSync(path.join(OUT, 'canary.txt'), path.join(WS, 'link-file-out')) // file symlink out
symlinkSync(OUT, path.join(WS, 'src', 'out-link')) // escapes only when resolved relative to src/
symlinkSync(path.join(WS, '.env'), path.join(WS, 'link-env')) // symlink to a protected file inside
symlinkSync(path.join(OUT, 'inner'), path.join(WS, 'a', 'L')) // a/L/.. is OUT physically, a/ lexically
symlinkSync(FIXED_DATA, path.join(WS, 'link-data')) // the data directory, linked into the workspace
symlinkSync(HOME_LIKE, path.join(WS, 'link-home'))

// A home-directory workspace that contains the default <DSH home>/advisor data
// directory, with symlinks into it from inside the workspace.
const HOME_WS = path.join(TMP, 'home-ws')
const HOME_DATA = path.join(HOME_WS, '.dsh', 'advisor')
const HOME_LEDGER = createLedger(HOME_DATA)
mkdirSync(HOME_LEDGER.repliesDir, { recursive: true, mode: 0o700 })
fs.chmodSync(HOME_DATA, 0o700) // explicit, whatever the umask
fs.chmodSync(HOME_LEDGER.repliesDir, 0o700)
writeFileSync(HOME_LEDGER.ledgerPath, `${JSON.stringify({ consult_id: ID, kind: 'advice', advisor: 'dsh', status: 'ok', reply_file: HOME_LEDGER.replyPath(ID), topic: 'FAKE_HOME_DATA_LEDGER' })}\n`, { mode: 0o600 })
writeFileSync(HOME_LEDGER.replyPath(ID), 'FAKE_HOME_DATA_REPLY\n', { mode: 0o600 })
put(path.join(HOME_WS, 'src/a.js'), 'export const a = 1\n')
put(path.join(HOME_WS, '.dsh/other.txt'), 'sibling of the data directory\n')
symlinkSync(HOME_DATA, path.join(HOME_WS, 'link-data'))
symlinkSync(HOME_LEDGER.ledgerPath, path.join(HOME_WS, 'link-ledger'))
symlinkSync(HOME_LEDGER.repliesDir, path.join(HOME_WS, 'link-replies'))
symlinkSync(path.join(HOME_WS, '.dsh'), path.join(HOME_WS, 'link-dsh'))
// Whether this filesystem folds case (macOS and Windows defaults do).
const FOLDS_CASE = fs.existsSync(path.join(HOME_WS, '.DSH', 'ADVISOR'))

const MKFIFO = spawnSync('mkfifo', ['--version'], { stdio: 'ignore' }).error === undefined

/** A fresh, unshared data directory (mkdtemp creates it 0700). */
function freshLedger() {
  return createLedger(mkdtempSync(path.join(TMP, 'data-')))
}
function writeLedger(ledger, lines) {
  mkdirSync(ledger.dir, { recursive: true, mode: 0o700 })
  writeFileSync(ledger.ledgerPath, lines.join('\n'), { mode: 0o600 })
}
function writeReplyFile(ledger, id, text) {
  mkdirSync(ledger.repliesDir, { recursive: true, mode: 0o700 })
  writeFileSync(ledger.replyPath(id), text, { mode: 0o600 })
}
const line = (value) => JSON.stringify(value)
const okLine = (ledger, id = ID, extra = {}) => line({
  consult_id: id, kind: 'advice', advisor: 'dsh', status: 'ok', reply_file: ledger.replyPath(id), reply_sha256: 'recorded', ...extra,
})

// ---------------------------------------------------------------------------
// Boundary harness: a fake Host ctx and fake child agents. A child's
// tools.get models scoped registrations, shadows and an explicit toolSet; its
// register refuses duplicates in one scope, as the DSH registry does.

function harness(options = {}) {
  // selectedRoute: () => the saved Verifier model (undefined: the boundary's default, Inherit).
  const { depsArg = 'default', ledger = freshLedger(), noGrep = false, dataDirProblem, workspace = WS, selectedRoute } = options
  const state = { workspace, grepMatches: [], grepCalls: [] }
  const listeners = new Map()
  const hostGuards = []
  const agents = new Map()
  const logs = []
  const hostGrep = {
    name: 'grep',
    description: 'Search file contents.',
    parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: value.matches.map((match) => `${match.path}:${match.line}`).join('\n') }] },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      state.grepCalls.push({ args, exec })
      return { matches: state.grepMatches.map((match) => ({ ...match })) }
    },
  }
  const globalDefs = Object.fromEntries([
    'glob', 'read', 'team_task_get', 'bash', 'write', 'edit', 'run_code', 'team_task_update', 'team_task_create',
    'send_message', 'subagent', 'web_fetch', 'working_directory',
  ].map((name) => [name, { name }]))
  if (!noGrep) globalDefs.grep = hostGrep
  const lead = { id: 'lead', names: { self: 'lead', parent: undefined }, session: { id: 'lead-session' } }
  lead.root = lead
  agents.set(lead.id, lead)
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
  const workspaceOf = (agent) => (agent === lead ? state.workspace : (Object.hasOwn(agent, 'cwd') ? agent.cwd : state.workspace))
  const defaults = { workspaceOf, ledger }
  const deps = typeof depsArg === 'function' ? depsArg(defaults) : defaults
  const install = options.install ?? true
  const dispose = !install ? () => {}
    : depsArg === 'none'
      ? installVerifierBoundary(ctx, undefined, selectedRoute, dataDirProblem)
      : installVerifierBoundary(ctx, undefined, selectedRoute, dataDirProblem, deps)

  function child({ id = 'verifier-1', self = VERIFIER, parent = 'lead', refuse = [], guardThrows = false, ...extra } = {}) {
    const handle = { registered: new Map(), shadows: new Map(), guards: [], sections: [], sequence: [], refuse: new Set(refuse), guardThrows }
    const agent = {
      id,
      names: { self, parent },
      root: lead,
      session: { id: `${id}-session` },
      cancelled: 0,
      cancel() { this.cancelled++ },
      ctx: {
        tools: {
          get(name, scope, toolSet) {
            if (toolSet !== undefined) return toolSet.view(scope).get(name)
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
            if (handle.registered.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered in this scope`)
            handle.registered.set(definition.name, definition)
            return () => {
              if (handle.registered.get(definition.name) === definition) handle.registered.delete(definition.name)
              handle.sequence.push(`unregister:${definition.name}`)
            }
          },
          restrict() {
            handle.sequence.push('restrict')
            return () => {}
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
      },
      ...extra,
    }
    handle.agent = agent
    agents.set(id, agent)
    return handle
  }

  const emit = (name, payload) => { for (const fn of [...(listeners.get(name) ?? [])]) fn(payload) }
  const start = (c, info = {}) => emit('subagent/start', { id: c.agent.id, local: true, provider: 'spawn', ...info })
  const end = (c) => emit('subagent/end', { id: c.agent.id })
  /** Every guard a call meets: the Host guards, then the child's own guards. */
  function run(c, name, args, opts = {}) {
    const exec = { name, arguments: args, agent: Object.hasOwn(opts, 'agent') ? opts.agent : c.agent, toolSet: opts.toolSet }
    for (const guard of [...hostGuards, ...c.guards]) {
      const denial = guard(exec)
      if (denial !== undefined) return denial
    }
    return undefined
  }
  const hostCall = (name, args, agent) => {
    for (const guard of [...hostGuards]) {
      const denial = guard({ name, arguments: args, agent })
      if (denial !== undefined) return denial
    }
    return undefined
  }
  function startChild(childOptions, info) {
    const c = child(childOptions)
    start(c, info)
    return c
  }
  return { state, ctx, lead, ledger, logs, hostGrep, hostGuards, listeners, globalDefs, dispose, child, start, end, emit, run, hostCall, startChild }
}

/** Call the child's own evidence tool the way the Host executes it. */
function evidence(c, args = {}, agent = c.agent) {
  const tool = c.registered.get(EVIDENCE_TOOL)
  assert.ok(tool !== undefined, 'the evidence tool is registered on the child')
  return tool.execute(args, { name: EVIDENCE_TOOL, arguments: args, agent })
}
const render = (c, value) => c.registered.get(EVIDENCE_TOOL).output.render({}, value).map((block) => block.text).join('\n')

/**
 * Record every path opened or read through node:fs while fn runs. Named
 * imports of node:fs are live bindings, so syncBuiltinESMExports() routes the
 * code under test through these wrappers too.
 */
async function recordOpens(fn) {
  const opened = []
  const originals = { openSync: fs.openSync, readFileSync: fs.readFileSync }
  fs.openSync = function openSync(file, ...rest) {
    opened.push(String(file))
    return originals.openSync.call(this, file, ...rest)
  }
  fs.readFileSync = function readFileSync(file, ...rest) {
    if (typeof file !== 'number') opened.push(String(file))
    return originals.readFileSync.call(this, file, ...rest)
  }
  syncBuiltinESMExports()
  try {
    return { value: await fn(), opened }
  } finally {
    Object.assign(fs, originals)
    syncBuiltinESMExports()
  }
}

// The enforced JSON Schema subset the Host applies to tool outputs: one scalar
// type, object properties/required/additionalProperties, array items, scalar
// enum/const, and exact-one oneOf (at least two branches, no siblings).
const SCHEMA_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title'])
function schemaErrors(schema, value, at = '$') {
  for (const keyword of Object.keys(schema)) {
    if (!SCHEMA_KEYWORDS.has(keyword)) throw new Error(`schema uses ${keyword} at ${at}, outside the enforced subset`)
  }
  if (schema.oneOf !== undefined) {
    assert.ok(schema.oneOf.length >= 2 && schema.type === undefined && schema.properties === undefined, `${at}: oneOf needs two branches and no siblings`)
    const matching = schema.oneOf.filter((branch) => schemaErrors(branch, value, at).length === 0).length
    return matching === 1 ? [] : [`${at}: ${matching} oneOf branches match`]
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
  if (schema.type === 'object') {
    for (const key of schema.required ?? []) {
      assert.ok(Object.hasOwn(schema.properties ?? {}, key), `${at}: required ${key} is declared`)
      if (!Object.hasOwn(value, key)) errors.push(`${at}.${key}: required`)
    }
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) errors.push(...schemaErrors(schema.properties[key], item, `${at}.${key}`))
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: additional property`)
    }
  }
  if (schema.type === 'array' && schema.items !== undefined) value.forEach((item, index) => errors.push(...schemaErrors(schema.items, item, `${at}[${index}]`)))
  return errors
}

// Arguments each allowed tool accepts in the workspace.
const ALLOWED_CALLS = [
  ['glob', { pattern: '**/*.js' }],
  ['grep', { pattern: 'export' }],
  ['read', { file_path: 'src/a.js' }],
  ['team_task_get', { id: 'task-1' }],
  [EVIDENCE_TOOL, {}],
]

// ===========================================================================
// Requirement 5: the allowlist and default deny

test('allowlist: exactly glob, grep, read, team_task_get and advisor_evidence_get; everything else is denied', () => {
  assert.equal(EVIDENCE_TOOL, 'advisor_evidence_get')
  assert.deepEqual(VERIFIER_TOOLS, ['glob', 'grep', 'read', 'team_task_get', 'advisor_evidence_get'])
  assert.equal(Object.isFrozen(VERIFIER_TOOLS), true)
  const h = harness()
  const c = h.startChild()
  assert.equal(c.agent.cancelled, 0)
  for (const [name, args] of ALLOWED_CALLS) assert.equal(h.run(c, name, args), undefined, name)
  for (const name of ['bash', 'write', 'edit', 'run_code', 'team_task_update', 'team_task_create', 'send_message', 'subagent', 'web_fetch', 'working_directory', 'Read', 'read_image']) {
    assert.match(h.run(c, name, {}), /^Advisor verifier is read-only: this tool is not permitted\.$/, name)
  }
  // A tool registered on the child after start is not on the allowlist.
  c.registered.set('late_scoped', { name: 'late_scoped' })
  assert.match(h.run(c, 'late_scoped', {}), /read-only/)
  h.dispose()
})

test('allowlist: scoped or toolSet replacements of every allowed tool are shadows; a toolSet without the tool is unavailable', () => {
  const h = harness()
  const c = h.startChild()
  for (const [name, args] of ALLOWED_CALLS) {
    c.shadows.set(name, { name, execute() {} })
    assert.match(h.run(c, name, args), /^Advisor verifier tool is unavailable or shadowed\.$/, `scoped shadow of ${name}`)
    c.shadows.delete(name)
    const replaced = { view: () => new Map([[name, { name }]]) }
    assert.match(h.run(c, name, args, { toolSet: replaced }), /unavailable or shadowed/, `toolSet replacement of ${name}`)
    const empty = { view: () => new Map() }
    assert.match(h.run(c, name, args, { toolSet: empty }), /unavailable or shadowed/, `toolSet without ${name}`)
    const same = { view: (scope) => new Map([[name, c.agent.ctx.tools.get(name, scope)]]) }
    assert.equal(h.run(c, name, args, { toolSet: same }), undefined, `toolSet admitting the captured ${name}`)
  }
  h.dispose()
})

test('dataDir gate: a verifier that starts while the data directory is unusable is stopped and denied, and delegations are refused', () => {
  const refusal = dataDirUnusable('not writable: /x is not a directory')
  for (const problem of [() => DATA_DIR_NOT_CONFIGURED, () => refusal, () => { throw new Error('probe exploded') }]) {
    const h = harness({ dataDirProblem: problem })
    const c = h.startChild()
    assert.equal(c.agent.cancelled, 1)
    assert.equal(c.registered.size, 0, 'no evidence tool or grep is registered')
    assert.equal(c.sections.length, 0)
    for (const [name, args] of ALLOWED_CALLS) assert.match(h.run(c, name, args), /failed closed/, name)
    assert.ok(h.logs.some((entry) => entry.startsWith(`advisor: stopping ${VERIFIER}: `)), h.logs.join('\n'))
    assert.match(h.hostCall('subagent', { name: VERIFIER }, h.lead), /Advisor data directory|failed closed: probe exploded/)
    h.dispose()
  }
})

// ===========================================================================
// Requirement 1: read, glob and grep are confined like advisor children

test('confinement: read stays inside the workspace; outside, "..", "~", symlinked, data-directory and ~/.dsh-like paths are denied', () => {
  const h = harness({ ledger: FIXED_LEDGER })
  const c = h.startChild()
  for (const file of ['src/a.js', './src/a.js', path.join(WS, 'src/a.js'), 'docs/readme.md', '.env.example', 'src/new-file.js']) {
    assert.equal(h.run(c, 'read', { file_path: file }), undefined, file)
  }
  const outside = [
    path.join(OUT, 'canary.txt'), '/etc/hosts', 'link-out/canary.txt', 'link-out', 'link-file-out',
    FIXED_LEDGER.ledgerPath, FIXED_LEDGER.replyPath(ID), FIXED_LEDGER.repliesDir, FIXED_DATA,
    'link-data/sessions.jsonl', `link-data/replies/${ID}.md`, DSH_LIKE_LEDGER, DSH_LIKE_STATE, 'link-home/.dsh/advisor/sessions.jsonl',
  ]
  for (const file of outside) assert.match(h.run(c, 'read', { file_path: file }), /^file_path must stay inside the workspace\.$/, file)
  const traversal = [
    '..', '../outside/canary.txt', 'a/L/../canary.txt', `${WS}/a/L/../canary.txt`, 'src/../src/a.js', 'src/..',
    '~', '~/.dsh/advisor/sessions.jsonl', '~/.local/state/advisor/sessions.jsonl', '~root/x', `${WS}/../fixed-data/sessions.jsonl`,
  ]
  for (const file of traversal) assert.match(h.run(c, 'read', { file_path: file }), /^file_path must stay inside the workspace without "\.\."\.$/, file)
  for (const args of [{}, { file_path: '' }, { file_path: 42 }, { file_path: 'src/a\u0000.js' }]) {
    assert.match(h.run(c, 'read', args), /file_path is required|file_path must be a path string/, JSON.stringify(args))
  }
  for (const args of [null, [], 'src/a.js', undefined]) assert.match(h.run(c, 'read', args), /arguments must be an object/, JSON.stringify(args))
  h.dispose()
})

test('confinement: protected files are denied, including through symlinks; env templates are not', () => {
  const h = harness()
  const c = h.startChild()
  for (const file of [...Object.keys(PROTECTED), 'link-env', '.git', 'nested/.ssh', path.join(WS, '.env')]) {
    assert.match(h.run(c, 'read', { file_path: file }), /reaches a protected file or directory/, file)
  }
  assert.equal(h.run(c, 'read', { file_path: '.env.example' }), undefined)
  h.dispose()
})

test('confinement: glob and grep paths, glob patterns and grep includes cannot leave the workspace or reach .git', () => {
  const h = harness({ ledger: FIXED_LEDGER })
  const c = h.startChild()
  for (const dir of [OUT, 'link-out', FIXED_DATA, FIXED_LEDGER.repliesDir, 'link-data', path.dirname(DSH_LIKE_LEDGER), '/etc']) {
    assert.match(h.run(c, 'glob', { pattern: '*', path: dir }), /^path must stay inside the workspace\.$/, `glob ${dir}`)
    assert.match(h.run(c, 'grep', { pattern: 'x', path: dir }), /^path must stay inside the workspace\.$/, `grep ${dir}`)
  }
  for (const dir of ['..', 'a/L/..', '~', '~/.dsh']) {
    assert.match(h.run(c, 'glob', { pattern: '*', path: dir }), /without "\.\."/, `glob ${dir}`)
    assert.match(h.run(c, 'grep', { pattern: 'x', path: dir }), /without "\.\."/, `grep ${dir}`)
  }
  for (const value of ['../**', '/etc/*', '~/.dsh/**', '{..,src}/*.js']) {
    assert.match(h.run(c, 'glob', { pattern: value }), /^pattern must stay inside the workspace\.$/, `glob pattern ${value}`)
    assert.match(h.run(c, 'grep', { pattern: 'x', include: value }), /^include must stay inside the workspace\.$/, `grep include ${value}`)
  }
  assert.match(h.run(c, 'glob', { pattern: '.git/**' }), /must not reach \.git/)
  assert.match(h.run(c, 'grep', { pattern: 'x', include: '.git/*' }), /must not reach \.git/)
  assert.match(h.run(c, 'grep', { pattern: 'x', path: '.env' }), /protected/)
  assert.equal(h.run(c, 'glob', { pattern: '*.js', path: 'src' }), undefined)
  assert.equal(h.run(c, 'grep', { pattern: 'x', path: 'src', include: '*.js' }), undefined)
  h.dispose()
})

test('confinement: paths resolve against the verifier\'s own working directory inside the workspace', () => {
  const h = harness()
  const c = h.startChild({ cwd: path.join(WS, 'src') })
  assert.equal(c.agent.cancelled, 0)
  assert.equal(h.run(c, 'read', { file_path: 'sub/b.js' }), undefined)
  assert.equal(h.run(c, 'read', { file_path: 'a.js' }), undefined)
  assert.match(h.run(c, 'read', { file_path: 'out-link/canary.txt' }), /inside the workspace/, 'src/out-link leaves the workspace')
  assert.match(h.run(c, 'read', { file_path: path.join(WS, '.env') }), /protected/)
  h.dispose()
})

test('confinement: team_task_get and the evidence tool carry no path and bypass path confinement', () => {
  const h = harness()
  const c = h.startChild()
  for (const args of [{ id: 'task-1' }, { id: '../../etc/passwd' }, { file_path: '/etc/hosts' }, {}]) {
    assert.equal(h.run(c, 'team_task_get', args), undefined, JSON.stringify(args))
  }
  assert.equal(h.run(c, EVIDENCE_TOOL, {}), undefined)
  h.dispose()
})

test('confinement: verifierToolDenial applies identity checks before the path check, and denies file tools without a root or data directory', () => {
  const agent = {}
  const read = { name: 'read' }
  const tools = { get: () => read }
  const expected = new Map([['read', read], ['team_task_get', read]])
  const exec = (name, args) => ({ name, arguments: args, agent })
  assert.equal(verifierToolDenial(exec('read', { file_path: 'src/a.js' }), tools, agent, expected, WS, WS, FIXED_DATA), undefined)
  assert.match(verifierToolDenial(exec('read', { file_path: '/etc/hosts' }), tools, agent, expected, WS, WS, FIXED_DATA), /inside the workspace/)
  assert.match(verifierToolDenial(exec('read', { file_path: '/etc/hosts' }), tools, {}, expected, WS, WS, FIXED_DATA), /no exact agent scope/)
  assert.match(verifierToolDenial(exec('read', { file_path: 'src/a.js' }), { get: () => ({ name: 'read' }) }, agent, expected, WS, WS, FIXED_DATA), /shadowed/)
  assert.match(verifierToolDenial(exec('read', { file_path: 'src/a.js' }), tools, agent, expected), /no workspace root/)
  for (const dataDir of [undefined, '', 'relative/data', 42]) {
    assert.match(verifierToolDenial(exec('read', { file_path: 'src/a.js' }), tools, agent, expected, WS, WS, dataDir), /no data directory/, String(dataDir))
  }
  assert.equal(verifierToolDenial(exec('team_task_get', { id: 'x' }), tools, agent, expected), undefined, 'no root needed for team_task_get')
})

test('grep: the child\'s grep is the confined wrapper and drops outside, protected and data-directory matches', async () => {
  const h = harness({ ledger: FIXED_LEDGER })
  const c = h.startChild()
  const grep = c.registered.get('grep')
  assert.ok(grep !== undefined && grep !== h.hostGrep, 'a confined grep is registered on the child')
  assert.equal(h.ctx.tools.get('grep'), h.hostGrep, 'the Host grep itself is untouched')
  for (const key of ['name', 'parameters', 'output', 'timeoutMs', 'isConcurrencySafe']) assert.equal(grep[key], h.hostGrep[key], key)
  h.state.grepMatches = [
    { path: 'src/a.js', line: 'export const a = 1' },
    { path: '.env', line: 'FAKE_SECRET_ENV=1' },
    { path: 'link-env', line: 'FAKE_SECRET_ENV=1' },
    { path: '.git/config', line: 'FAKE_SECRET_GIT' },
    { path: 'link-out/canary.txt', line: 'FAKE_OUTSIDE_CANARY' },
    { path: path.join(OUT, 'canary.txt'), line: 'FAKE_OUTSIDE_CANARY' },
    { path: 'link-data/sessions.jsonl', line: 'FAKE_FIXED_LEDGER' },
    { path: FIXED_LEDGER.ledgerPath, line: 'FAKE_FIXED_LEDGER' },
    { path: DSH_LIKE_LEDGER, line: 'FAKE_HOME_LEDGER' },
    { path: 'a/L/../canary.txt', line: 'FAKE_OUTSIDE_CANARY' },
    { path: 'docs/readme.md', line: 'x' },
  ]
  const args = { pattern: 'FAKE|export|x', include: '*' }
  assert.equal(h.run(c, 'grep', args), undefined, 'any include inside the workspace passes the guard')
  const value = await grep.execute(args, { name: 'grep', arguments: args, agent: c.agent })
  assert.deepEqual(value.matches.map((match) => match.path), ['src/a.js', 'docs/readme.md'])
  assert.doesNotMatch(grep.output.render(args, value)[0].text, /FAKE_/)
  h.dispose()
})

test('grep: a registration that does not shadow the Host grep fails closed; without a Host grep there is no grep', () => {
  const refused = harness()
  const c = refused.startChild({ refuse: ['grep'] })
  assert.equal(c.agent.cancelled, 1)
  for (const [name, args] of ALLOWED_CALLS) assert.match(refused.run(c, name, args), /failed closed/, name)
  assert.ok(refused.logs.some((entry) => entry.includes('confined grep did not register')), refused.logs.join('\n'))
  refused.dispose()

  const none = harness({ noGrep: true })
  const n = none.startChild()
  assert.equal(n.agent.cancelled, 0)
  assert.equal(n.registered.has('grep'), false)
  assert.match(none.run(n, 'grep', { pattern: 'x' }), /unavailable or shadowed/)
  assert.equal(none.run(n, 'read', { file_path: 'src/a.js' }), undefined)
  none.dispose()
})

test('start: guard first, then the evidence tool and confined grep, then the capture and the policy', () => {
  const h = harness()
  const c = h.child()
  h.start(c)
  assert.deepEqual(c.sequence, ['guard', `register:${EVIDENCE_TOOL}`, 'register:grep', 'section'])
  assert.equal(c.guards.length, 1)
  assert.equal(h.ctx.tools.get(EVIDENCE_TOOL), undefined, 'the evidence tool is registered on the child only')
  assert.equal(c.sections.length, 1)
  assert.equal(c.sections[0].text, VERIFIER_POLICY)
  h.dispose()
})

test('start: a refused evidence tool or a guard that cannot be installed fails closed and stops the verifier', () => {
  const refused = harness()
  const c = refused.startChild({ refuse: [EVIDENCE_TOOL] })
  assert.equal(c.agent.cancelled, 1)
  for (const [name, args] of ALLOWED_CALLS) assert.match(refused.run(c, name, args), /failed closed/, name)
  assert.ok(refused.logs.some((entry) => entry.includes('evidence tool did not register')), refused.logs.join('\n'))
  assert.equal(c.registered.size, 0, 'partial registrations are disposed')
  refused.dispose()

  const closed = harness()
  const g = closed.startChild({ guardThrows: true })
  assert.equal(g.agent.cancelled, 1)
  assert.match(closed.run(g, 'read', { file_path: 'src/a.js' }), /failed closed/, 'the Host guard denies a verifier without a child guard')
  closed.dispose()
})

test('start: a later epoch on the same Agent object refreshes the registrations under one guard; a new Agent object shuts the old one out', async () => {
  const h = harness()
  const c = h.startChild()
  h.start(c)
  assert.equal(c.agent.cancelled, 0)
  assert.equal(c.guards.length, 1)
  assert.equal(c.sections.length, 1)
  for (const step of [`unregister:${EVIDENCE_TOOL}`, 'unregister:grep', 'unsection']) assert.ok(c.sequence.includes(step), step)
  for (const [name, args] of ALLOWED_CALLS) assert.equal(h.run(c, name, args), undefined, name)
  assert.equal((await evidence(c)).ledger_path, h.ledger.ledgerPath)

  const replacement = h.child() // same id, new Agent object and ctx
  h.start(replacement)
  assert.equal(c.registered.size, 0, 'registrations on the old ctx were disposed')
  assert.match(h.run(c, 'read', { file_path: 'src/a.js' }), /failed closed|no exact agent scope/)
  for (const [name, args] of ALLOWED_CALLS) assert.equal(h.run(replacement, name, args), undefined, name)
  h.dispose()
})

test('lifecycle: end and dispose remove the scoped registrations; guards keep denying', () => {
  const h = harness()
  const c = h.startChild()
  h.end(c)
  assert.equal(c.registered.size, 0)
  assert.equal(c.sections.length, 0)
  assert.match(h.hostCall('read', { file_path: 'src/a.js' }, c.agent), /failed closed/, 'the Host guard re-derives a reserved name without a record')
  // A new turn of the same Agent object after its end registers afresh under its one guard.
  h.start(c)
  assert.equal(c.agent.cancelled, 0, h.logs.join('\n'))
  assert.equal(c.guards.length, 1)
  for (const [name, args] of ALLOWED_CALLS) assert.equal(h.run(c, name, args), undefined, `after restart: ${name}`)
  h.dispose()

  const d = harness()
  const v = d.startChild()
  d.dispose()
  assert.equal(v.agent.cancelled, 1)
  assert.equal(v.registered.size, 0)
  assert.equal(d.hostGuards.length, 0)
  for (const [name, list] of d.listeners) assert.equal(list.length, 0, name)
  assert.match(v.guards[0]({ name: 'bash', arguments: {}, agent: v.agent }), /read-only/, 'the child guard outlives the plugin')
  assert.match(v.guards[0]({ name: EVIDENCE_TOOL, arguments: {}, agent: v.agent }), /unavailable or shadowed/)
})

// ===========================================================================
// Requirement 2: the workspace root at start

test('root: an unknown or unusable root or working directory denies every tool and stops the verifier', () => {
  const missing = path.join(TMP, 'missing-workspace')
  const cases = [
    ['no deps argument', { depsArg: 'none' }],
    ['deps without workspaceOf', { depsArg: ({ ledger }) => ({ ledger }) }],
    ['deps without ledger', { depsArg: ({ workspaceOf }) => ({ workspaceOf }) }],
    ['workspaceOf undefined for the lead', { depsArg: ({ ledger }) => ({ ledger, workspaceOf: (agent) => (agent.id === 'lead' ? undefined : WS) }) }],
    ['workspaceOf throws', { depsArg: ({ ledger }) => ({ ledger, workspaceOf: () => { throw new Error('no working directory') } }) }],
    ['relative workspace', { workspace: 'ws' }],
    ['lead workspace missing', { workspace: missing }],
    ['child cwd unknown', {}, { cwd: undefined }],
    ['child cwd missing', {}, { cwd: path.join(WS, 'no-such-dir') }],
    ['cwd outside the workspace', {}, { cwd: OUT }],
    ['cwd symlinked outside', {}, { cwd: path.join(WS, 'link-out') }],
    ['cwd in the data directory', {}, { cwd: FIXED_DATA }],
    ['cwd in a protected directory', {}, { cwd: path.join(WS, '.git') }],
    ['rootOf throws', {}, { rootThrows: true }],
  ]
  for (const [label, options, childOptions = {}] of cases) {
    const h = harness(options)
    const c = h.startChild(childOptions)
    assert.equal(c.agent.cancelled, 1, `${label}: stopped`)
    assert.equal(c.registered.size, 0, `${label}: nothing registered`)
    assert.equal(c.sections.length, 0, `${label}: no policy`)
    for (const [name, args] of ALLOWED_CALLS) {
      assert.match(h.run(c, name, args), /failed closed/, `${label}: ${name}`)
      assert.match(h.hostCall(name, args, c.agent), /failed closed/, `${label}: host guard ${name}`)
    }
    assert.ok(h.logs.some((entry) => entry.startsWith(`advisor: stopping ${VERIFIER}: Advisor verifier`)), `${label}: ${h.logs.join('\n')}`)
    h.dispose()
  }
})

test('root: the root is the realpath of the lead workspace; a symlinked workspace path still confines to its target', () => {
  const linked = path.join(TMP, 'ws-link')
  symlinkSync(WS, linked)
  const h = harness({ workspace: linked })
  const c = h.startChild({ cwd: path.join(linked, 'src') })
  assert.equal(c.agent.cancelled, 0)
  assert.equal(h.run(c, 'read', { file_path: path.join(WS, 'src/a.js') }), undefined)
  assert.equal(h.run(c, 'read', { file_path: 'sub/b.js' }), undefined)
  assert.match(h.run(c, 'read', { file_path: path.join(OUT, 'canary.txt') }), /inside the workspace/)
  h.dispose()
})

// ===========================================================================
// Requirement 3: the evidence tool

test('evidence: child-scoped definition with one optional part argument and an output schema in the enforced subset', () => {
  const h = harness()
  const c = h.startChild()
  const tool = c.registered.get(EVIDENCE_TOOL)
  assert.equal(tool.name, EVIDENCE_TOOL)
  assert.deepEqual(tool.parameters, {
    type: 'object',
    properties: { part: { type: 'integer', minimum: 1, description: 'Reply part to return, from 1 (the default) to reply_parts.' } },
    additionalProperties: false,
  })
  assert.equal(tool.parameters.required, undefined, 'part is optional')
  assert.equal(typeof tool.description, 'string')
  assert.equal(typeof tool.output.render, 'function')
  assert.deepEqual(schemaErrors(tool.output.schema, {
    ledger_path: '/x', entries: [{ line: 1, text: '{}', torn: false }], reply_path: '/r', reply_sha256: 'a', reply_total_lines: 1,
    reply_part: 1, reply_parts: 1, reply_text: '1: x', reply_reason: null,
  }), [])
  assert.deepEqual(schemaErrors(tool.output.schema, {
    ledger_path: '/x', entries: [], reply_path: '/r', reply_sha256: null, reply_total_lines: null,
    reply_part: null, reply_parts: null, reply_text: null, reply_reason: 'Reply withheld: x.',
  }), [])
  h.dispose()
})

test('evidence: exactly this consult_id\'s ledger lines with 1-based physical line numbers and raw text, and the numbered reply', async () => {
  const ledger = freshLedger()
  const ownGlued = line({ consult_id: ID, kind: 'advice', advisor: 'dsh', status: 'started', topic: 'glued' })
  const glued = `{"consult_id":"torn-a","pad":"FAKE_TORN_FRAGMENT${'x'.repeat(40)}${ownGlued}`
  const lines = [
    line({ consult_id: OTHER_ID, status: 'started', cwd: '/elsewhere/FAKE_OTHER_CWD' }), // 1 another id
    line({ consult_id: ID, kind: 'advice', advisor: 'dsh', status: 'started', cwd: WS }), // 2 own
    line({ consult_id: 'other', topic: `mentions ${ID}`, cwd: '/elsewhere/FAKE_FOREIGN_CWD' }), // 3 foreign line naming the id
    line({ consult_id: `${ID}6`, status: 'ok', topic: 'FAKE_LONGER_ID' }), // 4 a longer id
    glued, // 5 own whole line glued behind a torn fragment
    `{"consult_id":"${ID}","status":"ok"`, // 6 own fragment alone: unparseable, skipped
    `not json ${ID}`, // 7
    '', // 8
    line({ consult_id: OTHER_ID, status: 'ok', reply_file: ledger.replyPath(OTHER_ID), topic: 'FAKE_OTHER_TOPIC' }), // 9
    okLine(ledger), // 10 own terminal line
    '', // trailing newline
  ]
  writeLedger(ledger, lines)
  const reply = '{\n  "schema": "advisor-advice/1",\n  "claims": []\n}\n'
  writeReplyFile(ledger, ID, reply)
  writeReplyFile(ledger, OTHER_ID, 'FAKE_OTHER_REPLY\n')
  const h = harness({ ledger })
  const c = h.startChild()
  const { value, opened } = await recordOpens(() => evidence(c))
  assert.deepEqual(value, {
    ledger_path: ledger.ledgerPath,
    entries: [{ line: 2, text: lines[1], torn: false }, { line: 5, text: ownGlued, torn: true }, { line: 10, text: lines[9], torn: false }],
    reply_path: ledger.replyPath(ID),
    reply_sha256: fileSha256Sync(ledger.replyPath(ID)),
    reply_total_lines: 4,
    reply_part: 1,
    reply_parts: 1,
    reply_text: '1: {\n2:   "schema": "advisor-advice/1",\n3:   "claims": []\n4: }',
    reply_reason: null,
  })
  assert.equal(value.reply_sha256, sha256(Buffer.from(reply, 'utf8')))
  assert.deepEqual(schemaErrors(c.registered.get(EVIDENCE_TOOL).output.schema, value), [])
  const fileLines = readFileSync(ledger.ledgerPath, 'utf8').split('\n')
  for (const entry of value.entries) {
    if (entry.torn) assert.ok(fileLines[entry.line - 1].endsWith(entry.text) && fileLines[entry.line - 1] !== entry.text, `line ${entry.line} ends with the entry`)
    else assert.equal(fileLines[entry.line - 1], entry.text, `line ${entry.line} is the physical line`)
  }
  assert.doesNotMatch(JSON.stringify(value), /FAKE_OTHER|FAKE_FOREIGN|FAKE_LONGER|FAKE_TORN_FRAGMENT|torn-a/)
  assert.deepEqual([...new Set(opened)].sort(), [ledger.ledgerPath, ledger.replyPath(ID)].sort(), 'only the ledger and this id\'s reply are opened')
  // The same fragment-tolerant parse as ledgerEntriesFor.
  assert.deepEqual(ledger.ledgerLinesFor(ID).map((entry) => entry.entry), ledger.ledgerEntriesFor(ID))
  const text = render(c, value)
  assert.ok(text.includes(`sessions.jsonl:10: ${lines[9]}`), text)
  assert.ok(text.includes(`sessions.jsonl:5: (torn: only this consult_id's entry, after a fragment of another write) ${ownGlued}`), text)
  assert.doesNotMatch(text, /FAKE_TORN_FRAGMENT|torn-a/, 'the fragment of the other write is never rendered')
  assert.ok(text.includes('2:   "schema": "advisor-advice/1",'), text)
  assert.ok(text.includes('reply_part: 1 of 1.'), text)
  assert.ok(text.includes(ledger.replyPath(ID)) && text.includes(value.reply_sha256), text)
  h.dispose()
})

test('evidence: line numbering matches the file: no trailing empty line, an empty reply has none, CRLF bytes are kept', async () => {
  for (const [reply, total, numbered] of [
    ['a\nb', 2, '1: a\n2: b'],
    ['a\n\n', 2, '1: a\n2: '],
    ['\n', 1, '1: '],
    ['', 0, ''],
    ['a\r\nb\r\n', 2, '1: a\r\n2: b\r'],
  ]) {
    const ledger = freshLedger()
    writeLedger(ledger, [okLine(ledger)])
    writeReplyFile(ledger, ID, reply)
    const h = harness({ ledger })
    const value = await evidence(h.startChild())
    assert.equal(value.reply_total_lines, total, JSON.stringify(reply))
    assert.equal(value.reply_text, numbered, JSON.stringify(reply))
    assert.equal(value.reply_sha256, sha256(Buffer.from(reply, 'utf8')))
    h.dispose()
  }
})

test('evidence: the reply is withheld unless the last terminal entry names replyPath(id); a ledger reply_file is never opened', async () => {
  const cases = [
    ['reply_file is /etc/hosts', (ledger) => [okLine(ledger, ID, { reply_file: '/etc/hosts' })], '/etc/hosts'],
    ['reply_file is an outside canary', () => [line({ consult_id: ID, status: 'ok', reply_file: path.join(OUT, 'canary.txt') })], path.join(OUT, 'canary.txt')],
    ['reply_file is another id\'s reply', (ledger) => [okLine(ledger, ID, { reply_file: ledger.replyPath(OTHER_ID) })], 'other-reply'],
    ['reply_file is relative', () => [line({ consult_id: ID, status: 'ok', reply_file: `replies/${ID}.md` })], undefined],
    ['reply_file is not a string', () => [line({ consult_id: ID, status: 'ok', reply_file: 42 })], undefined],
    ['only a started line', () => [line({ consult_id: ID, status: 'started' })], undefined],
    ['a failed terminal line', () => [line({ consult_id: ID, status: 'started' }), line({ consult_id: ID, status: 'failed', failure_reason: 'x' })], undefined],
    ['an earlier ok line, then a failed one', (ledger) => [okLine(ledger), line({ consult_id: ID, status: 'failed' })], undefined],
    ['no line for this id', () => [line({ consult_id: OTHER_ID, status: 'ok' })], undefined],
  ]
  for (const [label, makeLines, forbidden] of cases) {
    const ledger = freshLedger()
    writeLedger(ledger, makeLines(ledger))
    writeReplyFile(ledger, ID, 'THIS_ID_REPLY\n')
    writeReplyFile(ledger, OTHER_ID, 'FAKE_OTHER_REPLY\n')
    const h = harness({ ledger })
    const c = h.startChild()
    const { value, opened } = await recordOpens(() => evidence(c))
    assert.equal(value.reply_text, null, label)
    assert.equal(value.reply_sha256, null, label)
    assert.equal(value.reply_total_lines, null, label)
    assert.match(value.reply_reason, /withheld/, label)
    assert.equal(value.reply_path, ledger.replyPath(ID), label)
    assert.deepEqual(schemaErrors(c.registered.get(EVIDENCE_TOOL).output.schema, value), [], label)
    assert.doesNotMatch(JSON.stringify(value), /THIS_ID_REPLY|FAKE_OUTSIDE_CANARY|FAKE_OTHER_REPLY/, label)
    assert.deepEqual([...new Set(opened)], [ledger.ledgerPath], `${label}: no reply file is opened`)
    if (forbidden === '/etc/hosts' || forbidden === path.join(OUT, 'canary.txt')) assert.ok(!opened.includes(forbidden), label)
    assert.match(render(c, value), /withheld/, label)
    h.dispose()
  }
})

test('evidence: a symlinked, non-regular, oversized or missing reply is refused without following it', async () => {
  // The FIFO case runs in a child process with a timeout (below): a blocking open would hang this process.
  const setups = [
    ['symlink to an outside canary', (ledger) => {
      mkdirSync(ledger.repliesDir, { recursive: true, mode: 0o700 })
      symlinkSync(path.join(OUT, 'canary.txt'), ledger.replyPath(ID))
    }, /symbolic link/],
    ['symlink to a regular reply inside the data directory', (ledger) => {
      writeReplyFile(ledger, OTHER_ID, 'FAKE_OTHER_REPLY\n')
      symlinkSync(ledger.replyPath(OTHER_ID), ledger.replyPath(ID))
    }, /symbolic link/],
    ['a directory', (ledger) => mkdirSync(ledger.replyPath(ID), { recursive: true, mode: 0o700 }), /not a regular file/],
    ['over the cap', (ledger) => writeReplyFile(ledger, ID, 'y'.repeat(MAX_EVIDENCE_REPLY_BYTES + 1)), /^Reply withheld: the reply file is over the 262144-byte cap: reply too large to verify; cite as unverifiable\.$/],
    ['missing', (ledger) => mkdirSync(ledger.repliesDir, { recursive: true, mode: 0o700 }), /does not exist/],
    ['a dangling symlink', (ledger) => {
      mkdirSync(ledger.repliesDir, { recursive: true, mode: 0o700 })
      symlinkSync(path.join(OUT, 'missing.md'), ledger.replyPath(ID))
    }, /symbolic link/],
  ]
  for (const [label, setup, reason] of setups) {
    const ledger = freshLedger()
    writeLedger(ledger, [okLine(ledger)])
    setup(ledger)
    const h = harness({ ledger })
    const c = h.startChild()
    const value = await evidence(c)
    assert.equal(value.reply_text, null, label)
    assert.equal(value.reply_sha256, null, label)
    assert.equal(value.reply_total_lines, null, label)
    assert.equal(value.reply_part, null, label)
    assert.equal(value.reply_parts, null, label)
    assert.match(value.reply_reason, reason, label)
    assert.deepEqual(value.entries.map((entry) => entry.line), [1], `${label}: the ledger lines are still returned`)
    assert.doesNotMatch(JSON.stringify(value), /FAKE_OUTSIDE_CANARY|FAKE_OTHER_REPLY|yyyy/, label)
    h.dispose()
  }
  const exact = freshLedger()
  writeLedger(exact, [okLine(exact)])
  writeReplyFile(exact, ID, 'z'.repeat(MAX_EVIDENCE_REPLY_BYTES))
  const h = harness({ ledger: exact })
  const value = await evidence(h.startChild())
  assert.equal(MAX_EVIDENCE_REPLY_BYTES, 256 * 1024)
  assert.equal(value.reply_total_lines, 1, 'a reply of exactly the cap is served')
  assert.equal(value.reply_sha256, fileSha256Sync(exact.replyPath(ID)))
  h.dispose()
})

test('evidence: a missing ledger returns no entries and withholds the reply without throwing', async () => {
  const ledger = createLedger(path.join(TMP, 'never-created', 'data'))
  const h = harness({ ledger })
  const value = await evidence(h.startChild())
  assert.deepEqual(value.entries, [])
  assert.equal(value.reply_text, null)
  assert.match(value.reply_reason, /withheld/)
  h.dispose()
})

test('evidence: the verifier cannot pass an id or a path; every argument but part is refused and other ids are never read', async () => {
  const ledger = freshLedger()
  writeLedger(ledger, [okLine(ledger, OTHER_ID), okLine(ledger)])
  writeReplyFile(ledger, ID, 'OWN_REPLY\n')
  writeReplyFile(ledger, OTHER_ID, 'FAKE_OTHER_REPLY\n')
  const h = harness({ ledger })
  const c = h.startChild()
  const refused = [
    { consult_id: OTHER_ID }, { id: OTHER_ID }, { path: ledger.replyPath(OTHER_ID) }, { offset: 1 }, { limit: 1 }, 'x', [], [OTHER_ID], 7,
    { part: 1, id: OTHER_ID }, { part: 1, path: ledger.replyPath(OTHER_ID) }, { part: 1, offset: 2 }, { part: 1, limit: 1 },
    { part: 0 }, { part: -1 }, { part: 1.5 }, { part: '1' }, { part: '2' }, { part: null }, { part: true }, { part: [1] }, { part: {} },
    { part: Number.NaN }, { part: Number.POSITIVE_INFINITY }, { part: 2 ** 53 },
  ]
  for (const args of refused) {
    const { value, opened } = await recordOpens(() => evidence(c, args).then(() => 'served', (error) => error))
    assert.ok(value instanceof Error, `${JSON.stringify(args)} is refused`)
    assert.match(value.message, /^advisor_evidence_get takes one optional argument, part: an integer from 1 \(the default\)/, JSON.stringify(args))
    assert.deepEqual(opened, [], `${JSON.stringify(args)}: nothing is read before the arguments are checked`)
  }
  for (const args of [{}, undefined, null, { part: 1 }, { part: undefined }]) {
    const { value, opened } = await recordOpens(() => evidence(c, args))
    assert.deepEqual(value.entries.map((entry) => entry.line), [2], JSON.stringify(args))
    assert.equal(value.reply_text, '1: OWN_REPLY')
    assert.ok(!opened.includes(ledger.replyPath(OTHER_ID)), 'another id\'s reply is never opened')
  }
  // The id is the verifier's own name; another verifier sees only its own run.
  const other = h.startChild({ id: 'verifier-2', self: OTHER_VERIFIER })
  const otherValue = await evidence(other)
  assert.deepEqual(otherValue.entries.map((entry) => entry.line), [1])
  assert.equal(otherValue.reply_text, '1: FAKE_OTHER_REPLY')
  h.dispose()
})

test('evidence: the tool is bound to its own verifier agent', async () => {
  const ledger = freshLedger()
  writeLedger(ledger, [okLine(ledger)])
  writeReplyFile(ledger, ID, 'OWN_REPLY\n')
  const h = harness({ ledger })
  const c = h.startChild()
  const other = h.startChild({ id: 'verifier-2', self: OTHER_VERIFIER })
  await assert.rejects(evidence(c, {}, other.agent), /bound to another advisor verifier/)
  await assert.rejects(evidence(c, {}, h.lead), /bound to another advisor verifier/)
  for (const args of [{ part: 1 }, { part: 2 }, { part: 0 }, { id: OTHER_ID }]) {
    await assert.rejects(evidence(c, args, other.agent), /bound to another advisor verifier/, `another verifier with ${JSON.stringify(args)}`)
    await assert.rejects(evidence(c, args, h.lead), /bound to another advisor verifier/, `the lead with ${JSON.stringify(args)}`)
    assert.match(h.hostCall(EVIDENCE_TOOL, args, h.lead), /only available to its advisor verifier/)
  }
  const tool = c.registered.get(EVIDENCE_TOOL)
  await assert.rejects(tool.execute({}, { name: EVIDENCE_TOOL, arguments: {} }), /bound to another advisor verifier/, 'a call without an agent')
  await assert.rejects(tool.execute({}, undefined), /bound to another advisor verifier/, 'a call without an execution context')
  assert.match(h.run(c, EVIDENCE_TOOL, {}, { agent: other.agent }), /no exact agent scope/, 'the child guard refuses another agent')
  assert.match(h.hostCall(EVIDENCE_TOOL, {}, h.lead), /only available to its advisor verifier/, 'the Host guard refuses the lead')
  assert.match(h.hostCall(EVIDENCE_TOOL, {}, undefined), /only available to its advisor verifier/)
  const mate = { id: 'mate', names: { self: 'mate', parent: 'lead' }, root: h.lead }
  assert.match(h.hostCall(EVIDENCE_TOOL, {}, mate), /only available to its advisor verifier/)
  assert.notEqual(c.registered.get(EVIDENCE_TOOL), other.registered.get(EVIDENCE_TOOL), 'one definition per verifier')
  assert.equal((await evidence(c)).reply_text, '1: OWN_REPLY')
  h.dispose()
})

// ===========================================================================
// Requirement 2 through apply(): the working-directory service is optional

/**
 * Install the plugin through index.host.js apply(); `services` lists the
 * Host services ctx.inject finds, so a missing one skips its callback.
 */
async function hostApply(dataDir, { services = ['agents', 'subagents', 'tools', 'workingDirectory', 'agentTeams', 'commands'], getWorkspace } = {}) {
  const h = harness({ install: false })
  const effects = new Map()
  const settings = { active: true, verifierModel: null, advisorModel: null, pending: null }
  const hostCtx = {
    get: () => undefined,
    logger: h.ctx.logger,
    sessionProjections: {
      async register(definition) {
        return { stateOf: () => (definition.key === 'advisor' ? settings : null) }
      },
    },
    systemPrompt: { getSectionOrder: () => 500, section() { return () => {} } },
    inject(names, callback) {
      if (!names.every((name) => services.includes(name))) return
      callback({
        ...h.ctx,
        workingDirectory: { get: getWorkspace ?? (() => h.state.workspace) },
        agentTeams: { isEnabled: () => true },
        commands: { register() {} },
        effect(fn, label) { effects.set(label, fn()) },
      })
    },
  }
  await apply(hostCtx, { dataDir })
  return { ...h, effects, dispose: () => { for (const effect of effects.values()) effect?.() } }
}

function appDataDir(prefix) {
  const dataDir = path.join(mkdtempSync(path.join(TMP, prefix)), 'data')
  const ledger = createLedger(dataDir)
  mkdirSync(dataDir, { mode: 0o700 })
  fs.chmodSync(dataDir, 0o700) // explicit, whatever the umask
  writeLedger(ledger, [okLine(ledger), ''])
  fs.chmodSync(ledger.ledgerPath, 0o600)
  writeReplyFile(ledger, ID, 'APPLY_REPLY\n')
  fs.chmodSync(ledger.repliesDir, 0o700)
  return { dataDir, ledger }
}

test('apply(): the verifier gets the workspace root from the working-directory service and the plugin ledger', async () => {
  const { dataDir, ledger } = appDataDir('apply-ok-')
  const h = await hostApply(dataDir)
  assert.equal(typeof h.effects.get('advisor: verifier boundary'), 'function')
  const c = h.startChild()
  assert.equal(c.agent.cancelled, 0, h.logs.join('\n'))
  assert.equal(h.run(c, 'read', { file_path: 'src/a.js' }), undefined)
  assert.match(h.run(c, 'read', { file_path: ledger.ledgerPath }), /inside the workspace/)
  assert.match(h.run(c, 'read', { file_path: path.join(OUT, 'canary.txt') }), /inside the workspace/)
  const value = await evidence(c)
  assert.equal(value.ledger_path, path.join(dataDir, 'sessions.jsonl'))
  assert.deepEqual(value.entries.map((entry) => entry.line), [1])
  assert.equal(value.reply_text, '1: APPLY_REPLY')

  // Unbinding the service (its effect disposed) denies the next verifier.
  h.effects.get('advisor: verifier working directory')()
  const later = h.startChild({ id: 'verifier-later', self: OTHER_VERIFIER })
  assert.equal(later.agent.cancelled, 1)
  assert.match(h.run(later, 'read', { file_path: 'src/a.js' }), /failed closed/)
  h.dispose()
})

test('apply(): without the working-directory service the verifier boundary stays installed and denies verifiers', async () => {
  const { dataDir } = appDataDir('apply-no-wd-')
  const h = await hostApply(dataDir, { services: ['agents', 'subagents', 'tools', 'agentTeams', 'commands'] })
  assert.equal(typeof h.effects.get('advisor: verifier boundary'), 'function', 'the boundary is installed')
  assert.equal(h.effects.has('advisor: verifier working directory'), false)
  assert.match(h.hostCall('subagent', { name: 'advisor-verifier-bad' }, h.lead), /12-character/, 'the delegation guard still applies')
  const c = h.startChild()
  assert.equal(c.agent.cancelled, 1)
  for (const [name, args] of ALLOWED_CALLS) assert.match(h.run(c, name, args), /failed closed/, name)
  assert.ok(h.logs.some((entry) => entry.startsWith(`advisor: stopping ${VERIFIER}: Advisor verifier`)), h.logs.join('\n'))
  h.dispose()

  const throwing = await hostApply(appDataDir('apply-wd-throws-').dataDir, { getWorkspace: () => { throw new Error('no session directory') } })
  const t = throwing.startChild()
  assert.equal(t.agent.cancelled, 1)
  throwing.dispose()
})

// ===========================================================================
// Requirement 4: the policy and workflow text

test('text: the verifier policy and the lead workflow describe the evidence tool, its parts, confinement and citations', () => {
  assert.match(VERIFIER_POLICY, /Only read, grep, glob, team_task_get, and advisor_evidence_get are permitted\./)
  assert.doesNotMatch(VERIFIER_POLICY, /Only read, grep, glob, and team_task_get are permitted/)
  assert.doesNotMatch(VERIFIER_POLICY, /takes no arguments/)
  assert.match(VERIFIER_POLICY, /Its only argument is part, an integer from 1 \(the default\)/)
  assert.match(VERIFIER_POLICY, /parts of at most 32 KB/)
  assert.match(VERIFIER_POLICY, /read every part before you report, and check each material claim against the whole reply/)
  assert.match(VERIFIER_POLICY, /Every part must show the same reply_sha256 and reply_parts/)
  assert.match(VERIFIER_POLICY, /physical reply line numbers of reply_text; a line labelled <n>\+: continues physical line <n>/)
  assert.match(VERIFIER_POLICY, /An entry marked torn/)
  assert.match(VERIFIER_POLICY, /too large to verify leaves its claims unverifiable/)
  assert.match(VERIFIER_POLICY, /Advisor data directory, which read, grep, and glob are denied even inside the workspace/)
  assert.match(VERIFIER_POLICY, /confined to the workspace and must not use "\.\."/)
  assert.match(VERIFIER_POLICY, /sessions\.jsonl:<line>/)
  assert.match(VERIFIER_POLICY, /REPLY <reply_path>:<line>/)
  assert.match(VERIFIER_POLICY, /cannot hash the reply independently/)
  assert.match(VERIFIER_POLICY, /outside the workspace, such as the DSH harness or other repositories, cannot be read; claims about them are unverifiable/)
  assert.match(VERIFIER_WORKFLOW, /advisor_evidence_get, whose only argument is the reply part, and it reads every part before it reports/)
  assert.doesNotMatch(VERIFIER_WORKFLOW, /a tool without arguments/)
  assert.match(VERIFIER_WORKFLOW, /confined to the workspace without "\.\." and outside the Advisor data directory/)
  assert.match(VERIFIER_WORKFLOW, /checked against the whole reply/)
  assert.match(VERIFIER_WORKFLOW, /sessions\.jsonl:<line>/)
  assert.match(VERIFIER_WORKFLOW, /<reply_path>:<line> with physical line numbers/)
  assert.match(VERIFIER_WORKFLOW, /the lead keeps both hash checks/)
  assert.match(VERIFIER_WORKFLOW, /unverifiable/)
})

test('text: the README evidence section documents the evidence tool, its parts and reasons, and the confinement', () => {
  const text = readFileSync(README, 'utf8')
  // Markdown wraps lines anywhere: compare with whitespace collapsed.
  const section = text.slice(text.indexOf('## Evidence verification'), text.indexOf('## License')).replace(/\s+/g, ' ')
  assert.ok(section.length > 0)
  assert.doesNotMatch(section, /no workspace path confinement/)
  for (const stale of ['takes no arguments', 'No other line of the shared ledger is shown', 'exposes the whole ledger and every reply to `read` and `grep`; advisor children have the same limit']) {
    assert.ok(!section.includes(stale), `stale: ${stale}`)
  }
  for (const phrase of [
    '`advisor_evidence_get`', 'It takes one optional argument, `part`: an integer from 1, the default.', '`sessions.jsonl:<line>`', '`<reply_path>:<line>`',
    '256 KB', 'never opens the `reply_file`', 'unverifiable', 'parts of at most 32 KB', 'labelled `<n>+: `', 'reads all of them before it reports',
    'A part beyond the last is refused with the valid range.', '`torn: true`', 'the fragment itself is never shown',
    '**No terminal entry:**', '**Unsafe folder:**', '**Missing:**', '**Unreadable:**', '**Too large:**', 'reply too large to verify; cite as unverifiable',
    'its last path component is never followed', 'which run again at every call', '`<real path of dataDir>/replies/<id>.md`',
    'The data directory is denied to `read`, `grep`, and `glob`, also when the workspace contains it', 'A filesystem root such as `/` is never a workspace.',
    'including the DSH harness sources', 'The data-directory and filesystem-root rules apply to the verifier only.',
  ]) {
    assert.ok(section.includes(phrase), phrase)
  }
  const data = text.slice(text.indexOf('### Data directory'), text.indexOf('### Comparing with the advisor skill')).replace(/\s+/g, ' ')
  assert.ok(data.includes('at most 64 offsets per line') && data.includes('lines of at most 1 MB'), 'the torn-line caps are documented')
})

// ===========================================================================
// Evidence parts: the rendered reply is served in parts of at most 32 KB so
// that no result reaches the Host's spill truncation.

const utf8 = (text) => Buffer.byteLength(text, 'utf8')

/** Every part of the evidence, fetched the way a verifier reads them. */
async function allParts(c) {
  const first = await evidence(c)
  const parts = [first]
  for (let part = 2; part <= first.reply_parts; part++) parts.push(await evidence(c, { part }))
  return parts
}

/**
 * Rebuild the physical reply lines from the parts: "<n>: " starts physical
 * line n and "<n>+: " continues it. Asserts that the numbering is contiguous
 * across parts.
 */
function reassemble(parts) {
  const lines = []
  for (const value of parts) {
    if (value.reply_text === '') continue
    for (const rendered of value.reply_text.split('\n')) {
      const match = /^(\d+)(\+?): /.exec(rendered)
      assert.ok(match !== null, `numbered: ${rendered.slice(0, 40)}`)
      const body = rendered.slice(match[0].length)
      if (match[2] === '+') {
        assert.equal(Number(match[1]), lines.length, 'a continuation belongs to the line before it')
        lines[lines.length - 1] += body
      } else {
        assert.equal(Number(match[1]), lines.length + 1, 'line numbers are contiguous across parts')
        lines.push(body)
      }
    }
  }
  return lines
}

test('evidence parts: a reply larger than one part is split on whole lines and all parts reassemble to the exact file', async () => {
  assert.equal(EVIDENCE_PART_BYTES, 32 * 1024)
  const ledger = freshLedger()
  writeLedger(ledger, [line({ consult_id: ID, status: 'started' }), okLine(ledger), ''])
  const fileLines = []
  for (let i = 0; i < 3000; i++) {
    fileLines.push([`  "claim ${i}": "${'x'.repeat(i % 97)}",`, `é漢字🙂 ${'ü'.repeat(i % 41)}`, '', `crlf ${i}\r`][i % 4])
  }
  const reply = `${fileLines.join('\n')}\n`
  assert.ok(utf8(reply) > 3 * EVIDENCE_PART_BYTES && utf8(reply) <= MAX_EVIDENCE_REPLY_BYTES, `${utf8(reply)} bytes`)
  writeReplyFile(ledger, ID, reply)
  const h = harness({ ledger })
  const c = h.startChild()
  const parts = await allParts(c)
  assert.ok(parts.length >= 4, `${parts.length} parts`)
  for (const [index, value] of parts.entries()) {
    assert.equal(value.reply_part, index + 1)
    assert.equal(value.reply_parts, parts.length)
    assert.equal(value.reply_total_lines, fileLines.length)
    assert.equal(value.reply_sha256, sha256(Buffer.from(reply, 'utf8')), 'every part hashes the whole file')
    assert.deepEqual(value.entries, parts[0].entries, 'every part carries the ledger lines')
    assert.deepEqual(value.entries.map((entry) => entry.line), [1, 2])
    assert.equal(value.reply_path, ledger.replyPath(ID))
    assert.equal(value.reply_reason, null)
    assert.ok(utf8(value.reply_text) <= EVIDENCE_PART_BYTES, `part ${index + 1} has ${utf8(value.reply_text)} bytes`)
    assert.doesNotMatch(value.reply_text, /^\d+\+: /m, 'no line here is long enough to be cut')
    assert.deepEqual(schemaErrors(c.registered.get(EVIDENCE_TOOL).output.schema, value), [])
    const text = render(c, value)
    assert.ok(utf8(text) <= EVIDENCE_PART_BYTES + 2048, `rendered part ${index + 1} has ${utf8(text)} bytes`)
    assert.ok(text.includes(`reply_part: ${index + 1} of ${parts.length}.`), text.slice(0, 600))
    assert.equal(text.includes(`Call advisor_evidence_get with part ${index + 2} next`), index + 1 < parts.length)
  }
  // Greedy on whole lines: every part but the last is full up to its next line.
  for (let i = 0; i + 1 < parts.length; i++) {
    const next = parts[i + 1].reply_text.split('\n')[0]
    assert.ok(utf8(parts[i].reply_text) + 1 + utf8(next) > EVIDENCE_PART_BYTES, `part ${i + 1} could not take its next line`)
  }
  assert.equal(`${reassemble(parts).join('\n')}\n`, reply, 'the parts reassemble to the exact file')
  h.dispose()
})

test('evidence parts: a line longer than a part is cut at character boundaries and continues on lines labelled <n>+:', async () => {
  const ledger = freshLedger()
  writeLedger(ledger, [okLine(ledger)])
  const long = `aaaaa${'é🙂漢'.repeat(12_000)}END` // ~108 KB of 2-, 3- and 4-byte characters
  const fileLines = [
    'first',
    long,
    'after',
    'x'.repeat(EVIDENCE_PART_BYTES - 3), // "4: " plus this is exactly one part
    'y'.repeat(EVIDENCE_PART_BYTES - 2), // one byte too long: cut once
    '🙂'.repeat(EVIDENCE_PART_BYTES / 4), // astral characters across the cut
    'last',
  ]
  const reply = fileLines.join('\n') // no final newline
  writeReplyFile(ledger, ID, reply)
  const h = harness({ ledger })
  const c = h.startChild()
  const parts = await allParts(c)
  for (const value of parts) {
    assert.ok(utf8(value.reply_text) <= EVIDENCE_PART_BYTES, `part ${value.reply_part} has ${utf8(value.reply_text)} bytes`)
    assert.equal(value.reply_total_lines, fileLines.length)
  }
  const rendered = parts.flatMap((value) => value.reply_text.split('\n'))
  for (const segment of rendered) {
    assert.ok(segment.isWellFormed(), 'no surrogate pair is split')
    assert.ok(!segment.includes('\ufffd'), 'no UTF-8 sequence is split')
  }
  assert.equal(rendered[0], '1: first')
  assert.ok(rendered[1].startsWith('2: aaaaa'))
  assert.ok(rendered.filter((segment) => segment.startsWith('2+: ')).length >= 3, 'line 2 continues as 2+:')
  assert.ok(rendered.includes('3: after'))
  assert.ok(rendered.includes(`4: ${'x'.repeat(EVIDENCE_PART_BYTES - 3)}`), 'a line of exactly one part is not cut')
  assert.ok(rendered.includes(`5: ${'y'.repeat(EVIDENCE_PART_BYTES - 3)}`) && rendered.includes('5+: y'), 'one byte over is cut once')
  assert.ok(rendered.some((segment) => segment.startsWith('6+: 🙂')))
  assert.equal(rendered.at(-1), '7: last')
  assert.equal(reassemble(parts).join('\n'), reply, 'the parts reassemble to the exact file')
  h.dispose()
})

test('evidence parts: a part beyond the last is refused with the valid range; a withheld reply gives its reason for any part', async () => {
  const single = freshLedger()
  writeLedger(single, [okLine(single)])
  writeReplyFile(single, ID, 'ONE\n')
  const h = harness({ ledger: single })
  const c = h.startChild()
  assert.equal((await evidence(c, { part: 1 })).reply_text, '1: ONE')
  for (const part of [2, 3, 1000]) await assert.rejects(evidence(c, { part }), new RegExp(`^Error: part ${part} is out of range: this reply has only part 1\\.$`))
  h.dispose()

  const multi = freshLedger()
  writeLedger(multi, [okLine(multi)])
  writeReplyFile(multi, ID, `${Array.from({ length: 3 }, (_, i) => `${i}`.repeat(EVIDENCE_PART_BYTES - 10)).join('\n')}\n`)
  const m = harness({ ledger: multi })
  const mc = m.startChild()
  assert.equal((await evidence(mc)).reply_parts, 3)
  assert.equal((await evidence(mc, { part: 3 })).reply_part, 3)
  await assert.rejects(evidence(mc, { part: 4 }), /^Error: part 4 is out of range: this reply has parts 1 to 3\.$/)
  m.dispose()

  const empty = freshLedger()
  writeLedger(empty, [okLine(empty)])
  writeReplyFile(empty, ID, '')
  const e = harness({ ledger: empty })
  const ec = e.startChild()
  assert.deepEqual(
    (({ reply_part: part, reply_parts: parts, reply_text: text, reply_total_lines: total }) => ({ part, parts, text, total }))(await evidence(ec)),
    { part: 1, parts: 1, text: '', total: 0 },
    'an empty reply is one empty part',
  )
  await assert.rejects(evidence(ec, { part: 2 }), /only part 1/)
  e.dispose()

  const withheld = freshLedger()
  writeLedger(withheld, [line({ consult_id: ID, status: 'started' })])
  writeReplyFile(withheld, ID, 'NOT_SERVED\n')
  const w = harness({ ledger: withheld })
  const wc = w.startChild()
  for (const part of [1, 2, 7]) {
    const value = await evidence(wc, { part })
    assert.equal(value.reply_text, null)
    assert.equal(value.reply_part, null)
    assert.equal(value.reply_parts, null)
    assert.match(value.reply_reason, /^Reply withheld: the ledger has no terminal entry/)
    assert.deepEqual(value.entries.map((entry) => entry.line), [1])
  }
  w.dispose()
})

// ===========================================================================
// The data directory is denied to read, glob and grep, also inside the
// workspace; a filesystem root is never a workspace.

const DATA_DENIAL = /reaches the Advisor data directory; take the ledger and reply only from advisor_evidence_get\.$/

test('data directory: a workspace that contains it denies read, glob and grep inside it, directly and through symlinks; the evidence tool still serves the run', async () => {
  const h = harness({ ledger: HOME_LEDGER, workspace: HOME_WS })
  const c = h.startChild()
  assert.equal(c.agent.cancelled, 0, h.logs.join('\n'))
  for (const file of ['src/a.js', '.dsh/other.txt', 'link-dsh/other.txt', path.join(HOME_WS, '.dsh/other.txt'), '.dsh', '.dsh/advisor-notes.txt']) {
    assert.equal(h.run(c, 'read', { file_path: file }), undefined, file)
  }
  for (const args of [{ pattern: '*', path: '.dsh' }, { pattern: '**/*' }, { pattern: '*', path: '.' }]) assert.equal(h.run(c, 'glob', args), undefined, JSON.stringify(args))
  for (const args of [{ pattern: 'x' }, { pattern: 'x', path: '.' }, { pattern: 'x', path: '.dsh' }, { pattern: 'x', include: '*.jsonl' }]) {
    assert.equal(h.run(c, 'grep', args), undefined, `${JSON.stringify(args)}: allowed, the matches are filtered`)
  }
  const inside = [
    '.dsh/advisor', '.dsh/advisor/', '.dsh/advisor/sessions.jsonl', '.dsh/advisor/replies', `.dsh/advisor/replies/${ID}.md`, '.dsh/advisor/not-yet.txt',
    './.dsh/advisor/sessions.jsonl', '.dsh//advisor/sessions.jsonl', HOME_DATA, HOME_LEDGER.ledgerPath, HOME_LEDGER.replyPath(ID),
    'link-data', 'link-data/sessions.jsonl', `link-data/replies/${ID}.md`, 'link-ledger', 'link-replies', `link-replies/${ID}.md`,
    'link-dsh/advisor/sessions.jsonl', path.join(HOME_WS, 'link-data', 'sessions.jsonl'),
  ]
  if (FOLDS_CASE) inside.push('.DSH/Advisor/SESSIONS.jsonl', `.dsh/ADVISOR/replies/${ID.toUpperCase()}.MD`)
  for (const file of inside) assert.match(h.run(c, 'read', { file_path: file }), new RegExp(`^file_path ${DATA_DENIAL.source}`), file)
  for (const dir of ['.dsh/advisor', 'link-data', 'link-replies', HOME_DATA, '.dsh/advisor/replies', 'link-dsh/advisor']) {
    assert.match(h.run(c, 'glob', { pattern: '*', path: dir }), new RegExp(`^path ${DATA_DENIAL.source}`), `glob ${dir}`)
    assert.match(h.run(c, 'grep', { pattern: 'x', path: dir }), new RegExp(`^path ${DATA_DENIAL.source}`), `grep ${dir}`)
  }
  for (const file of ['.dsh/advisor/../advisor/sessions.jsonl', 'src/../.dsh/advisor/sessions.jsonl', `${HOME_WS}/src/../.dsh/advisor/sessions.jsonl`, 'link-data/..']) {
    assert.match(h.run(c, 'read', { file_path: file }), /without "\.\."/, file)
  }
  // The direct API keeps the data directory out as well.
  const read = c.agent.ctx.tools.get('read', c.agent)
  const expected = new Map([['read', read]])
  assert.match(verifierToolDenial({ name: 'read', arguments: { file_path: '.dsh/advisor/sessions.jsonl' }, agent: c.agent }, c.agent.ctx.tools, c.agent, expected, HOME_WS, HOME_WS, HOME_DATA), DATA_DENIAL)
  assert.equal(verifierToolDenial({ name: 'read', arguments: { file_path: '.dsh/other.txt' }, agent: c.agent }, c.agent.ctx.tools, c.agent, expected, HOME_WS, HOME_WS, HOME_DATA), undefined)
  const value = await evidence(c)
  assert.equal(value.reply_text, '1: FAKE_HOME_DATA_REPLY', 'the run itself comes from the evidence tool')
  assert.deepEqual(value.entries.map((entry) => entry.line), [1])
  h.dispose()
})

test('data directory: grep drops matches inside it, by relative, absolute and symlinked paths, also from a subdirectory', async () => {
  const h = harness({ ledger: HOME_LEDGER, workspace: HOME_WS })
  const c = h.startChild()
  const grep = c.registered.get('grep')
  assert.match(grep.description, /Matches in protected files and in the Advisor data directory are withheld\.$/)
  h.state.grepMatches = [
    { path: 'src/a.js', lineNumber: 1, line: 'export const a = 1' },
    { path: '.dsh/advisor/sessions.jsonl', lineNumber: 1, line: 'FAKE_HOME_DATA_LEDGER' },
    { path: `.dsh/advisor/replies/${ID}.md`, lineNumber: 1, line: 'FAKE_HOME_DATA_REPLY' },
    { path: 'link-data/sessions.jsonl', lineNumber: 1, line: 'FAKE_HOME_DATA_LEDGER' },
    { path: `link-replies/${ID}.md`, lineNumber: 1, line: 'FAKE_HOME_DATA_REPLY' },
    { path: 'link-ledger', lineNumber: 1, line: 'FAKE_HOME_DATA_LEDGER' },
    { path: 'link-dsh/advisor/sessions.jsonl', lineNumber: 1, line: 'FAKE_HOME_DATA_LEDGER' },
    { path: HOME_LEDGER.ledgerPath, lineNumber: 1, line: 'FAKE_HOME_DATA_LEDGER' },
    { path: '.dsh/other.txt', lineNumber: 1, line: 'sibling of the data directory' },
  ]
  const args = { pattern: 'FAKE|export|sibling' }
  const value = await grep.execute(args, { name: 'grep', arguments: args, agent: c.agent })
  assert.deepEqual(value.matches.map((match) => match.path), ['src/a.js', '.dsh/other.txt'])
  assert.doesNotMatch(grep.output.render(args, value)[0].text, /FAKE_/)
  h.dispose()

  // From a working directory above the data directory, paths are relative to it.
  const sub = harness({ ledger: HOME_LEDGER, workspace: HOME_WS })
  const s = sub.startChild({ cwd: path.join(HOME_WS, '.dsh') })
  assert.equal(s.agent.cancelled, 0, sub.logs.join('\n'))
  sub.state.grepMatches = [{ path: 'advisor/sessions.jsonl', lineNumber: 1, line: 'FAKE_HOME_DATA_LEDGER' }, { path: 'other.txt', lineNumber: 1, line: 'sibling' }]
  const subValue = await s.registered.get('grep').execute(args, { name: 'grep', arguments: args, agent: s.agent })
  assert.deepEqual(subValue.matches.map((match) => match.path), ['other.txt'])
  assert.match(sub.run(s, 'read', { file_path: 'advisor/sessions.jsonl' }), DATA_DENIAL)
  assert.match(sub.run(s, 'glob', { pattern: '*', path: 'advisor' }), DATA_DENIAL)
  sub.dispose()
})

test('data directory: a working directory inside it fails closed; a symlinked data directory is denied by its target', () => {
  for (const cwd of [HOME_DATA, HOME_LEDGER.repliesDir, path.join(HOME_WS, 'link-data')]) {
    const h = harness({ ledger: HOME_LEDGER, workspace: HOME_WS })
    const c = h.startChild({ cwd })
    assert.equal(c.agent.cancelled, 1, cwd)
    assert.equal(c.registered.size, 0, cwd)
    for (const [name, args] of ALLOWED_CALLS) assert.match(h.run(c, name, args), /failed closed/, `${cwd}: ${name}`)
    assert.ok(h.logs.some((entry) => entry.includes('is in the Advisor data directory')), h.logs.join('\n'))
    h.dispose()
  }

  const ws = path.join(TMP, 'linked-data-ws')
  const realData = path.join(ws, 'real-data')
  mkdirSync(realData, { recursive: true, mode: 0o700 })
  put(path.join(ws, 'src/a.js'))
  symlinkSync(realData, path.join(ws, 'data-link'))
  const ledger = createLedger(path.join(ws, 'data-link'))
  writeFileSync(ledger.ledgerPath, `${okLine(ledger)}\n`, { mode: 0o600 })
  const h = harness({ ledger, workspace: ws })
  const c = h.startChild()
  assert.equal(c.agent.cancelled, 0, h.logs.join('\n'))
  assert.equal(h.run(c, 'read', { file_path: 'src/a.js' }), undefined)
  for (const file of ['real-data/sessions.jsonl', 'data-link/sessions.jsonl', 'real-data', 'data-link']) assert.match(h.run(c, 'read', { file_path: file }), DATA_DENIAL, file)
  h.dispose()
})

test('data directory: a second name for the folder that realpath keeps (a macOS firmlink path) is caught by its inode', {
  skip: !(() => {
    try {
      return fs.statSync(path.join('/System/Volumes/Data', HOME_DATA)).ino === fs.statSync(HOME_DATA).ino
    } catch {
      return false
    }
  })() && 'no /System/Volumes/Data firmlink to the temp directory',
}, () => {
  const firmlinked = path.join('/System/Volumes/Data', HOME_WS)
  assert.equal(realpathSync.native(firmlinked), firmlinked, 'realpath keeps the second name')
  const h = harness({ ledger: HOME_LEDGER, workspace: firmlinked })
  const c = h.startChild()
  assert.equal(c.agent.cancelled, 0, h.logs.join('\n'))
  assert.equal(h.run(c, 'read', { file_path: 'src/a.js' }), undefined)
  for (const file of ['.dsh/advisor/sessions.jsonl', `.dsh/advisor/replies/${ID}.md`, '.dsh/advisor', path.join(firmlinked, '.dsh/advisor/sessions.jsonl')]) {
    assert.match(h.run(c, 'read', { file_path: file }), DATA_DENIAL, file)
  }
  h.dispose()
})

test('root: a filesystem root as the lead workspace stops the verifier and denies every tool', () => {
  for (const workspace of ['/', path.parse(TMP).root]) {
    const h = harness({ workspace })
    const c = h.startChild()
    assert.equal(c.agent.cancelled, 1, workspace)
    assert.equal(c.registered.size, 0, workspace)
    assert.equal(c.sections.length, 0, workspace)
    for (const [name, args] of ALLOWED_CALLS) {
      assert.match(h.run(c, name, args), /failed closed/, `${workspace}: ${name}`)
      assert.match(h.hostCall(name, args, c.agent), /failed closed/, `${workspace}: host guard ${name}`)
    }
    assert.ok(h.logs.some((entry) => entry.includes(`the lead workspace ${workspace} is a filesystem root`)), h.logs.join('\n'))
    h.dispose()
  }
})

// ===========================================================================
// The reply folder is re-checked at every call.

test('evidence: a replies folder swapped for a symlink after start withholds the reply and names the problem', async () => {
  const ledger = freshLedger()
  writeLedger(ledger, [okLine(ledger)])
  writeReplyFile(ledger, ID, 'OWN_REPLY\n')
  const h = harness({ ledger })
  const c = h.startChild()
  assert.equal((await evidence(c)).reply_text, '1: OWN_REPLY')
  const decoy = mkdtempSync(path.join(TMP, 'decoy-'))
  writeFileSync(path.join(decoy, `${ID}.md`), 'FAKE_SWAPPED_REPLY\n', { mode: 0o600 })
  fs.renameSync(ledger.repliesDir, path.join(ledger.dir, 'replies-moved'))
  symlinkSync(decoy, ledger.repliesDir)
  const { value, opened } = await recordOpens(() => evidence(c))
  assert.equal(value.reply_text, null)
  assert.equal(value.reply_sha256, null)
  assert.equal(value.reply_reason, `Reply withheld: the Advisor data directory is not writable: ${ledger.repliesDir} is a symbolic link.`)
  assert.deepEqual(value.entries.map((entry) => entry.line), [1], 'the ledger lines are still returned')
  assert.deepEqual([...new Set(opened)], [ledger.ledgerPath], 'no reply is opened')
  assert.doesNotMatch(JSON.stringify(value), /FAKE_SWAPPED_REPLY|OWN_REPLY/)
  h.dispose()
})

test('evidence: the reply must resolve to <realpath of dataDir>/replies/<id>.md even when the folder probe misses a swap; every probe problem withholds', async () => {
  const real = freshLedger()
  writeLedger(real, [okLine(real)])
  const decoy = mkdtempSync(path.join(TMP, 'decoy-'))
  writeFileSync(path.join(decoy, `${ID}.md`), 'FAKE_SWAPPED_REPLY\n', { mode: 0o600 })
  symlinkSync(decoy, real.repliesDir)
  const blind = { ...real, writableProblem: () => undefined } // a probe that misses the swap
  const h = harness({ ledger: blind })
  const c = h.startChild()
  const { value, opened } = await recordOpens(() => evidence(c))
  assert.equal(value.reply_text, null)
  assert.equal(value.reply_reason, `Reply withheld: the reply path does not resolve to ${path.join(realpathSync(real.dir), 'replies', `${ID}.md`)}; a folder on its way was replaced.`)
  assert.ok(!opened.includes(real.replyPath(ID)), 'the swapped reply is never opened')
  assert.doesNotMatch(JSON.stringify(value), /FAKE_SWAPPED_REPLY/)
  h.dispose()

  const fine = freshLedger()
  writeLedger(fine, [okLine(fine)])
  writeReplyFile(fine, ID, 'OWN_REPLY\n')
  const probes = [
    [() => 'unsafe: /x is writable by group or others (mode 0775)', 'Reply withheld: the Advisor data directory is unsafe: /x is writable by group or others (mode 0775).'],
    [() => 'not writable: /x denies writes (EACCES)', 'Reply withheld: the Advisor data directory is not writable: /x denies writes (EACCES).'],
    [() => { throw new Error('probe exploded') }, 'Reply withheld: the Advisor data directory is not writable: probe exploded.'],
  ]
  for (const [writableProblem, reason] of probes) {
    const p = harness({ ledger: { ...fine, writableProblem } })
    const value = await evidence(p.startChild())
    assert.equal(value.reply_text, null, reason)
    assert.equal(value.reply_reason, reason)
    assert.deepEqual(value.entries.map((entry) => entry.line), [1])
    p.dispose()
  }
  if (typeof process.getuid === 'function') {
    fs.chmodSync(fine.ledgerPath, 0o620)
    const p = harness({ ledger: fine })
    const unsafe = await evidence(p.startChild())
    assert.match(unsafe.reply_reason, /^Reply withheld: the Advisor data directory is unsafe: .*sessions\.jsonl is writable by group or others \(mode 0620\)\.$/)
    p.dispose()
  }
  // A ledger object without the probe or its folder never gets a verifier going.
  for (const missing of ['writableProblem', 'dir']) {
    const { [missing]: _dropped, ...partial } = fine
    const p = harness({ ledger: partial })
    const pc = p.startChild()
    assert.equal(pc.agent.cancelled, 1, missing)
    assert.ok(p.logs.some((entry) => entry.includes('has no ledger to take its evidence from')), p.logs.join('\n'))
    p.dispose()
  }
})

// ===========================================================================
// Checks that earlier tests could pass without.

test('root: a relative workspace or working directory is refused even when it exists relative to the process', () => {
  const relativeWs = path.relative(process.cwd(), WS)
  assert.ok(!path.isAbsolute(relativeWs) && realpathSync(relativeWs) === WS, `${relativeWs} names the workspace from ${process.cwd()}`)
  const h = harness({ workspace: relativeWs })
  const c = h.startChild()
  assert.equal(c.agent.cancelled, 1)
  for (const [name, args] of ALLOWED_CALLS) assert.match(h.run(c, name, args), /failed closed/, name)
  assert.ok(h.logs.some((entry) => entry.includes('the lead workspace is unknown')), h.logs.join('\n'))
  h.dispose()

  const relativeCwd = path.relative(process.cwd(), path.join(WS, 'src'))
  assert.ok(!path.isAbsolute(relativeCwd) && realpathSync(relativeCwd) === path.join(WS, 'src'))
  const w = harness()
  const v = w.startChild({ cwd: relativeCwd })
  assert.equal(v.agent.cancelled, 1)
  for (const [name, args] of ALLOWED_CALLS) assert.match(w.run(v, name, args), /failed closed/, name)
  assert.ok(w.logs.some((entry) => entry.includes('the verifier working directory is unknown')), w.logs.join('\n'))
  w.dispose()
})

test('evidence: the tool of an Agent object replaced under the same id fails closed when it is still called', async () => {
  const ledger = freshLedger()
  writeLedger(ledger, [okLine(ledger)])
  writeReplyFile(ledger, ID, 'OWN_REPLY\n')
  const h = harness({ ledger })
  const c = h.startChild()
  const stale = c.registered.get(EVIDENCE_TOOL)
  const call = (tool, agent) => tool.execute({}, { name: EVIDENCE_TOOL, arguments: {}, agent })
  assert.equal((await call(stale, c.agent)).reply_text, '1: OWN_REPLY')
  const replacement = h.child() // same id, new Agent object
  h.start(replacement)
  assert.equal(c.registered.size, 0, 'the old registration is gone')
  await assert.rejects(call(stale, c.agent), /^Error: Advisor verifier failed closed: no tools are permitted\.$/)
  await assert.rejects(call(stale, replacement.agent), /bound to another advisor verifier/)
  assert.equal((await call(replacement.registered.get(EVIDENCE_TOOL), replacement.agent)).reply_text, '1: OWN_REPLY')
  h.dispose()
})

test('evidence: the last terminal entry decides; a started line after an ok line still serves the reply', async () => {
  const cases = [
    [(ledger) => [line({ consult_id: ID, status: 'started' }), okLine(ledger), line({ consult_id: ID, status: 'started', topic: 'later' })], '1: OWN_REPLY'],
    [(ledger) => [okLine(ledger), line({ consult_id: ID, status: 'started' }), line({ consult_id: ID, status: 'started' })], '1: OWN_REPLY'],
    [(ledger) => [okLine(ledger), line({ consult_id: ID, status: 'failed' }), line({ consult_id: ID, status: 'started' })], null],
  ]
  for (const [makeLines, expected] of cases) {
    const ledger = freshLedger()
    writeLedger(ledger, makeLines(ledger))
    writeReplyFile(ledger, ID, 'OWN_REPLY\n')
    const h = harness({ ledger })
    const value = await evidence(h.startChild())
    assert.equal(value.reply_text, expected, JSON.stringify(makeLines(ledger)))
    assert.deepEqual(value.entries.map((entry) => entry.line), [1, 2, 3])
    h.dispose()
  }
})

const FIFO_CHILD = path.join(TMP, 'fifo-child.mjs')
writeFileSync(FIFO_CHILD, `import { createLedger } from ${JSON.stringify(new URL('../src/ledger.js', import.meta.url).href)}
import { EVIDENCE_TOOL, installVerifierBoundary } from ${JSON.stringify(new URL('../src/verifier.js', import.meta.url).href)}

const [dataDir, workspace, id] = process.argv.slice(2)
const listeners = new Map()
const registered = new Map()
const lead = { id: 'lead', names: { self: 'lead' } }
const agent = {
  id: 'verifier',
  names: { self: 'advisor-verifier-' + id, parent: 'lead' },
  cancelled: 0,
  cancel() { this.cancelled++ },
  ctx: {
    tools: {
      get: (name) => registered.get(name) ?? (name === 'grep' ? undefined : { name }),
      guard: () => () => {},
      register(definition) { registered.set(definition.name, definition); return () => registered.delete(definition.name) },
    },
    systemPrompt: { getSectionOrder: () => 500, section: () => () => {} },
  },
}
const agents = new Map([[lead.id, lead], [agent.id, agent]])
installVerifierBoundary({
  agents: { get: (key) => agents.get(key) },
  subagents: { namesOf: (value) => value.names, rootOf: () => lead },
  tools: { get: () => undefined, guard: () => () => {} },
  on(name, listener) { listeners.set(name, listener); return () => {} },
  logger: { warn: (message) => process.stderr.write(message + '\\n') },
}, undefined, undefined, undefined, { workspaceOf: () => workspace, ledger: createLedger(dataDir) })
listeners.get('subagent/start')({ id: agent.id, local: true, provider: 'spawn' })
if (agent.cancelled !== 0) throw new Error('the verifier was stopped')
const value = await registered.get(EVIDENCE_TOOL).execute({}, { name: EVIDENCE_TOOL, arguments: {}, agent })
process.stdout.write(JSON.stringify(value))
`)

test('evidence: a FIFO planted as the reply is refused without blocking (in a child process with a timeout)', { skip: !MKFIFO && 'mkfifo is not available' }, () => {
  const ledger = freshLedger()
  writeLedger(ledger, [okLine(ledger)])
  mkdirSync(ledger.repliesDir, { recursive: true, mode: 0o700 })
  assert.equal(spawnSync('mkfifo', [ledger.replyPath(ID)]).status, 0)
  assert.ok(fs.lstatSync(ledger.replyPath(ID)).isFIFO())
  const child = spawnSync(process.execPath, [FIFO_CHILD, ledger.dir, WS, ID], { encoding: 'utf8', timeout: 15_000 })
  assert.equal(child.error, undefined, `the child finished in time (${child.error?.code})`)
  assert.equal(child.signal, null)
  assert.equal(child.status, 0, child.stderr)
  const value = JSON.parse(child.stdout)
  assert.equal(value.reply_text, null)
  assert.equal(value.reply_reason, 'Reply withheld: the reply file is not a regular file.')
  assert.deepEqual(value.entries.map((entry) => entry.line), [1])
})

/** Report `size` from fstat for the file descriptors opened on `file` while fn runs. */
async function withReplyFstatSize(file, size, fn) {
  const originals = { openSync: fs.openSync, fstatSync: fs.fstatSync }
  const fds = new Set()
  let faked = 0
  fs.openSync = function openSync(target, ...rest) {
    const fd = originals.openSync.call(this, target, ...rest)
    if (String(target) === file) fds.add(fd)
    return fd
  }
  fs.fstatSync = function fstatSync(fd, ...rest) {
    const stat = originals.fstatSync.call(this, fd, ...rest)
    if (fds.has(fd)) {
      stat.size = size
      faked++
    }
    return stat
  }
  syncBuiltinESMExports()
  try {
    return { value: await fn(), faked }
  } finally {
    Object.assign(fs, originals)
    syncBuiltinESMExports()
  }
}

test('evidence: the fstat size cap and the read cap each withhold an oversized reply on their own', async () => {
  const exact = freshLedger()
  writeLedger(exact, [okLine(exact)])
  writeReplyFile(exact, ID, 'z'.repeat(MAX_EVIDENCE_REPLY_BYTES))
  const h = harness({ ledger: exact })
  const c = h.startChild()
  assert.equal((await evidence(c)).reply_total_lines, 1, 'a reply of exactly the cap is served')
  const reported = await withReplyFstatSize(exact.replyPath(ID), MAX_EVIDENCE_REPLY_BYTES + 1, () => evidence(c))
  assert.ok(reported.faked >= 1, 'fstat reported the fake size')
  assert.equal(reported.value.reply_text, null, 'the fstat cap alone withholds it')
  assert.match(reported.value.reply_reason, /reply too large to verify/)
  h.dispose()

  const over = freshLedger()
  writeLedger(over, [okLine(over)])
  writeReplyFile(over, ID, 'y'.repeat(MAX_EVIDENCE_REPLY_BYTES + 1))
  const o = harness({ ledger: over })
  const oc = o.startChild()
  const understated = await withReplyFstatSize(over.replyPath(ID), 16, () => evidence(oc))
  assert.ok(understated.faked >= 1, 'fstat reported the fake size')
  assert.equal(understated.value.reply_text, null, 'the read cap alone withholds it')
  assert.match(understated.value.reply_reason, /reply too large to verify/)
  assert.doesNotMatch(JSON.stringify(understated.value), /yyyy/)
  o.dispose()
})

test('names: a 12-hex verifier name with a suffix, 13 hex digits or uppercase hex fails closed at start and is refused at delegation', () => {
  for (const name of [`${VERIFIER}-x`, `${VERIFIER}6`, `advisor-verifier-${ID.toUpperCase()}`, `advisor-verifier-A${ID.slice(1)}`, `advisor-verifier-${ID.slice(0, 11)}`, 'advisor-verifier-', 'advisor-verifier']) {
    const h = harness()
    const c = h.startChild({ self: name })
    assert.equal(c.agent.cancelled, 1, `${name}: stopped`)
    assert.equal(c.registered.size, 0, `${name}: nothing registered`)
    assert.equal(c.sections.length, 0, `${name}: no policy`)
    for (const [tool, args] of ALLOWED_CALLS) {
      assert.match(h.run(c, tool, args), /failed closed/, `${name}: ${tool}`)
      assert.match(h.hostCall(tool, args, c.agent), /failed closed/, `${name}: host guard ${tool}`)
    }
    assert.match(h.hostCall('subagent', { name }, h.lead), /^Advisor verifier name must be advisor-verifier-<full 12-character lowercase consult_id>\.$/, `${name}: delegation`)
    h.dispose()
  }
})

// ===========================================================================
// Verifier model and effort: the lead policy and the delegation guard agree

const ROUTE = Object.freeze({ provider: 'openrouter', model: '~deepseek/deepseek-flash-latest' })
const OTHER_ROUTE = Object.freeze({ provider: 'anthropic', model: 'claude-haiku-5-5' })
// The denials used before efforts existed, byte for byte.
const VERIFIER_MUST_OMIT = 'Advisor verifier must omit reasoning_effort and agent_preset so the selected model default applies.'
const VERIFIER_INHERIT = 'Advisor verifier is set to Inherit; omit provider and model instead of overriding them.'
const wrongRoute = (route) => `Advisor verifier must use the selected route ${route.provider}/${route.model}.`
const effortRequired = (route) => `Advisor verifier must use the selected route ${route.provider}/${route.model} with reasoning_effort "${route.effort}". Do not omit or change the effort; the user can reset it with /advisor verifier-model ${route.provider}/${route.model}.`
// With a stored effort the agent_preset denial must not say to omit reasoning_effort.
const presetRequired = (route) => `Advisor verifier must omit agent_preset and use the selected route ${route.provider}/${route.model} with reasoning_effort "${route.effort}". Do not omit or change the effort; the user can reset it with /advisor verifier-model ${route.provider}/${route.model}.`
const VERIFIER_SETTINGS = Object.freeze([null, ROUTE, Object.freeze({ ...ROUTE, effort: 'low' }), Object.freeze({ provider: 'p', model: 'my model', effort: 'HiGh' })])

test('text: the Inherit and no-effort Verifier model texts are unchanged; a stored effort is named literally with its reset', () => {
  assert.equal(verifierModelPolicy(null),
    'Verifier model: Inherit. Omit provider, model, reasoning_effort, and agent_preset so configured child defaults and compatible parent values apply.')
  assert.equal(verifierModelPolicy(undefined), verifierModelPolicy(null))
  assert.equal(verifierModelPolicy(ROUTE),
    `Verifier model: ${ROUTE.provider}/${ROUTE.model}. Pass exactly this provider and model to subagent, omit reasoning_effort and agent_preset so the selected model's default effort applies, and do not fall back to another route if spawning fails.`)
  assert.equal(verifierModelPolicy({ ...ROUTE, effort: 'low' }),
    `Verifier model: ${ROUTE.provider}/${ROUTE.model} effort=low. Pass exactly this provider and model to subagent, pass reasoning_effort "low", omit agent_preset, and do not fall back to another route if spawning fails. If the spawn is rejected for the effort, report it and do not retry without it; the user can reset the effort with /advisor verifier-model ${ROUTE.provider}/${ROUTE.model}.`)
})

/** The spawn arguments a lead takes from the Verifier model policy: none for Inherit, else the label's route plus a quoted reasoning_effort. */
function verifierArgsFromPolicy(policy) {
  const match = /^Verifier model: (.+?)\. (?:Pass exactly this provider and model|Omit provider)/.exec(policy)
  assert.ok(match !== null, policy)
  if (match[1] === 'Inherit') {
    assert.match(policy, /Omit provider, model, reasoning_effort, and agent_preset/)
    return {}
  }
  const label = parseModelSetting(match[1])
  const quoted = /pass reasoning_effort "([^"]*)"/.exec(policy)
  assert.equal(quoted?.[1], label.effort, policy)
  return quoted === null
    ? { provider: label.provider, model: label.model }
    : { provider: label.provider, model: label.model, reasoning_effort: quoted[1] }
}

test('delegation: in every Verifier model state the policy\'s own arguments pass the boundary and each deviation gets its denial', () => {
  for (const setting of VERIFIER_SETTINGS) {
    const label = JSON.stringify(setting)
    const h = harness({ selectedRoute: () => setting })
    const args = verifierArgsFromPolicy(verifierModelPolicy(setting))
    const expected = spawnArgs(setting) ?? {}
    assert.deepEqual(args, expected, label)
    const effort = setting?.effort
    const routeDenial = setting === null ? VERIFIER_INHERIT : effort === undefined ? wrongRoute(setting) : effortRequired(setting)
    const effortDenial = effort === undefined ? VERIFIER_MUST_OMIT : effortRequired(setting)
    const presetDenial = effort === undefined ? VERIFIER_MUST_OMIT : presetRequired(setting)
    const withoutEffort = Object.fromEntries(Object.entries(expected).filter(([key]) => key !== 'reasoning_effort'))
    const deviations = [
      ['agent_preset added', { ...expected, agent_preset: 'reviewer' }, presetDenial],
      ['agent_preset with another effort', { ...expected, agent_preset: 'reviewer', reasoning_effort: 'max' }, presetDenial],
      ['agent_preset without the route', { agent_preset: 'reviewer' }, presetDenial],
      ['reasoning_effort null', { ...expected, reasoning_effort: null }, effortDenial],
      ['reasoning_effort empty', { ...expected, reasoning_effort: '' }, effortDenial],
      ['reasoning_effort changed', { ...expected, reasoning_effort: 'max' }, effortDenial],
      ...(effort === undefined ? [] : [
        ['reasoning_effort removed', withoutEffort, effortDenial],
        ['reasoning_effort case-changed', { ...expected, reasoning_effort: effort.toUpperCase() }, effortDenial],
      ]),
      ...(setting === null
        ? [['provider added', { provider: ROUTE.provider }, routeDenial], ['model added', { model: ROUTE.model }, routeDenial]]
        : [
          ['provider changed', { ...expected, provider: OTHER_ROUTE.provider }, routeDenial],
          ['model changed', { ...expected, model: OTHER_ROUTE.model }, routeDenial],
          ['route omitted', {}, routeDenial],
        ]),
    ]
    for (const [deviation, changed, denial] of deviations) {
      assert.equal(h.hostCall('subagent', { name: VERIFIER, ...changed }, h.lead), denial, `${label}: ${deviation}`)
      assert.equal(verifierDelegationDenial({ name: 'subagent', arguments: { name: VERIFIER, ...changed } }, () => true, () => setting), denial, `${label}: ${deviation} (pure)`)
    }
    assert.equal(h.hostCall('subagent', { name: VERIFIER, ...args }, h.lead), undefined, `${label}: the policy's own arguments pass`)
    h.dispose()
  }
})

test('delegation: the name and data-directory checks come first; agent_preset next, with the old text only without a stored effort; Advisor off after the route and effort; a throwing setting fails closed', () => {
  const stored = { ...ROUTE, effort: 'low' }
  const call = (args, enabled = () => true, dataDirProblem = () => undefined) => verifierDelegationDenial({ name: 'subagent', arguments: { name: VERIFIER, ...args } }, enabled, () => stored, dataDirProblem)
  assert.match(verifierDelegationDenial({ name: 'subagent', arguments: { name: 'advisor-verifier-typo', ...ROUTE } }, () => true, () => stored), /12-character/)
  assert.equal(call(ROUTE, () => true, () => DATA_DIR_NOT_CONFIGURED), DATA_DIR_NOT_CONFIGURED)
  assert.equal(call(ROUTE, () => false), effortRequired(stored), 'a missing effort is reported before Advisor off')
  assert.equal(call(spawnArgs(stored), () => false), 'Advisor verifier is off for this session; enable Advisor before starting a reserved verifier.')
  assert.equal(call(spawnArgs(stored)), undefined)
  assert.equal(call({ ...spawnArgs(stored), agent_preset: 'x' }, () => false), presetRequired(stored), 'agent_preset before Advisor off')
  assert.doesNotMatch(presetRequired(stored), /omit reasoning_effort/)
  for (const route of [null, ROUTE]) {
    assert.equal(verifierDelegationDenial({ name: 'subagent', arguments: { name: VERIFIER, ...spawnArgs(route), agent_preset: 'x' } }, () => true, () => route), VERIFIER_MUST_OMIT,
      `${JSON.stringify(route)}: the old text, byte for byte`)
  }
  const throwing = harness({ selectedRoute: () => { throw new Error('state gone') } })
  assert.equal(throwing.hostCall('subagent', { name: VERIFIER, ...spawnArgs(stored) }, throwing.lead), 'Advisor verifier guard failed closed: state gone')
  throwing.dispose()
})
