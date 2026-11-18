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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { apply } from '../src/index.host.js'
import { createLedger, fileSha256Sync, MAX_VERIFICATION_BYTES, sha256 } from '../src/ledger.js'
import { DATA_DIR_NOT_CONFIGURED, dataDirUnusable, renderAdvice, renderPlan } from '../src/planner.js'
import { parseModelSetting, spawnArgs } from '../src/state.js'
import {
  EVIDENCE_PART_BYTES,
  EVIDENCE_TOOL,
  installVerifierBoundary,
  MAX_EVIDENCE_REPLY_BYTES,
  MAX_REPORT_ENTRIES,
  MAX_REPORT_FAILURES,
  REPORT_TOOL,
  UNRECORDED_REASONS,
  validateVerifierReport,
  VERIFICATION_SCHEMA_ID,
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
  // now: the boundary's clock (undefined: Date.now). installBoundary: the
  // installVerifierBoundary under test (a mutated copy in the mutation checks).
  const {
    depsArg = 'default', ledger = freshLedger(), noGrep = false, dataDirProblem, workspace = WS, selectedRoute, now,
    installBoundary = installVerifierBoundary,
  } = options
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
  const defaults = { workspaceOf, ledger, ...(now === undefined ? {} : { now }) }
  const deps = typeof depsArg === 'function' ? depsArg(defaults) : defaults
  const install = options.install ?? true
  const dispose = !install ? () => {}
    : depsArg === 'none'
      ? installBoundary(ctx, undefined, selectedRoute, dataDirProblem)
      : installBoundary(ctx, undefined, selectedRoute, dataDirProblem, deps)

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
  const agentDisposed = (c) => emit('agent/disposed', { agent: c.agent })
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
  return { state, ctx, lead, ledger, logs, hostGrep, hostGuards, listeners, globalDefs, dispose, child, start, end, agentDisposed, emit, run, hostCall, startChild }
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
  [REPORT_TOOL, { entries: [{ ref: '1', status: 'confirmed', reply_line: 1, evidence: ['src/a.js:1'] }] }],
]

// ===========================================================================
// Requirement 5: the allowlist and default deny

test('allowlist: exactly glob, grep, read, team_task_get, advisor_evidence_get and advisor_verifier_report; everything else is denied', () => {
  assert.equal(EVIDENCE_TOOL, 'advisor_evidence_get')
  assert.equal(REPORT_TOOL, 'advisor_verifier_report')
  assert.deepEqual(VERIFIER_TOOLS, ['glob', 'grep', 'read', 'team_task_get', 'advisor_evidence_get', 'advisor_verifier_report'])
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

test('confinement: the verifier shares the secret-name rules for read and grep paths, grep results and report evidence', async () => {
  const h = harness()
  const c = h.startChild()
  const secret = ['aws-credentials.json', 'client_secret_123.json', '.envrc', 'terraform.tfstate.backup', 'github-token.txt', 'k8s/secrets/db.yaml', '.htpasswd', 'prod.env']
  const ordinary = ['secretary.js', 'tokenizer.js', 'src/token-bucket.js', 'src/secrets-manager/index.js', 'credentialing-docs.md', 'tokens.json']
  for (const file of secret) {
    assert.match(h.run(c, 'read', { file_path: file }), /^file_path reaches a protected file or directory/, file)
    assert.match(h.run(c, 'grep', { pattern: 'x', path: file }), /^path reaches a protected file or directory/, file)
    assert.match(h.run(c, 'glob', { pattern: '*', path: file }), /^path reaches a protected file or directory/, file)
  }
  for (const file of ordinary) assert.equal(h.run(c, 'read', { file_path: file }), undefined, file)
  h.state.grepMatches = [...secret, ...ordinary].map((file, index) => ({ path: file, lineNumber: index + 1, line: 'FAKE_SECRET' }))
  const args = { pattern: 'FAKE' }
  const value = await c.registered.get('grep').execute(args, { name: 'grep', arguments: args, agent: c.agent })
  assert.deepEqual(value.matches.map((match) => match.path), ordinary)
  const entry = (evidence) => ({ entries: [{ ref: '1', status: 'confirmed', reply_line: 3, evidence }] })
  for (const file of secret) {
    const result = validateVerifierReport(entry([`${file}:1`]), { kind: 'advice', expected: 1 })
    assert.equal(result.ok, false, file)
    assert.match(result.issues.join('\n'), /^entries\.0\.evidence\.0: path reaches a protected file/m, file)
  }
  assert.equal(validateVerifierReport(entry(ordinary.map((file) => `${file}:1`).slice(0, 5)), { kind: 'advice', expected: 1 }).ok, true)
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

test('confinement: team_task_get, the evidence tool and the report tool carry no path and bypass path confinement', () => {
  const h = harness()
  const c = h.startChild()
  for (const args of [{ id: 'task-1' }, { id: '../../etc/passwd' }, { file_path: '/etc/hosts' }, {}]) {
    assert.equal(h.run(c, 'team_task_get', args), undefined, JSON.stringify(args))
  }
  assert.equal(h.run(c, EVIDENCE_TOOL, {}), undefined)
  // The report tool's own validation refuses any argument but entries.
  assert.equal(h.run(c, REPORT_TOOL, { file_path: '/etc/hosts' }), undefined)
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

test('start: guard first, then the evidence tool, the report tool and confined grep, then the capture and the policy', () => {
  const h = harness()
  const c = h.child()
  h.start(c)
  assert.deepEqual(c.sequence, ['guard', `register:${EVIDENCE_TOOL}`, `register:${REPORT_TOOL}`, 'register:grep', 'section'])
  assert.equal(c.guards.length, 1)
  assert.equal(h.ctx.tools.get(EVIDENCE_TOOL), undefined, 'the evidence tool is registered on the child only')
  assert.equal(h.ctx.tools.get(REPORT_TOOL), undefined, 'the report tool is registered on the child only')
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

  const noReport = harness()
  const r = noReport.startChild({ refuse: [REPORT_TOOL] })
  assert.equal(r.agent.cancelled, 1)
  for (const [name, args] of ALLOWED_CALLS) assert.match(noReport.run(r, name, args), /failed closed/, name)
  assert.ok(noReport.logs.some((entry) => entry.includes('report tool did not register')), noReport.logs.join('\n'))
  assert.equal(r.registered.size, 0, 'partial registrations are disposed')
  noReport.dispose()

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
  for (const step of [`unregister:${EVIDENCE_TOOL}`, `unregister:${REPORT_TOOL}`, 'unregister:grep', 'unsection']) assert.ok(c.sequence.includes(step), step)
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
  assert.match(VERIFIER_POLICY, /Only read, grep, glob, team_task_get, advisor_evidence_get, and advisor_verifier_report are permitted\./)
  assert.doesNotMatch(VERIFIER_POLICY, /Only read, grep, glob, and team_task_get are permitted/)
  assert.doesNotMatch(VERIFIER_POLICY, /Only read, grep, glob, team_task_get, and advisor_evidence_get are permitted/)
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
  const data = text.slice(text.indexOf('### Data directory'), text.indexOf('### What the lead does next')).replace(/\s+/g, ' ')
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

// ===========================================================================
// Verification records: advisor_verifier_report stores one status-only record
// per consult beside the reply, and the Host appends one flat verification
// line without a top-level consult_id, with counts the Host computes. An
// allowed verifier that ends without a record gets one unrecorded line.

const settle = () => new Promise((resolve) => setImmediate(resolve))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** Wait until a predicate holds (file appends complete off the event loop). */
async function until(predicate, label, ms = 5000) {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(5)
  }
}

/** Advice with `count` claims, rendered as the Host renders replies. */
function adviceReply(count, id = ID) {
  return renderAdvice(id, {
    question: 'Which writer?', recommendation: 'The exclusive one.', rationale: 'Once only.', options: [], risks: [], do_not_build: [],
    claims: Array.from({ length: count }, (_, index) => ({ claim: `claim ${index + 1}`, evidence: ['src/a.js:1'] })),
    open_questions: [],
  })
}
/** A plan with these task ids, rendered as the Host renders replies. */
function planReply(taskIds, id = ID) {
  const task = (taskId) => ({
    id: taskId, title: `Do ${taskId}`, level: 'ordinary', level_reason: 'r', write_scopes: [], acceptance: [{ criterion: 'c', verify: 'v' }],
    blocked_by: [], open_questions: [],
  })
  return renderPlan(id, { summary: 'S.', tasks: taskIds.map(task), open_questions: [] })
}

/**
 * Record a run as the planner boundary does: its reply through writeReply,
 * then a started line and a terminal ok line carrying the reply's hash and count.
 * @returns {Promise<{ file: string, sha256: string, text: string }>}
 */
async function recordRun(ledger, { id = ID, kind = 'advice', count = 3, taskIds, reply, ok = {} } = {}) {
  const ids = taskIds ?? Array.from({ length: count }, (_, index) => `T${index + 1}`)
  const text = reply ?? (kind === 'plan' ? planReply(ids, id) : adviceReply(count, id))
  const written = await ledger.writeReply(id, text)
  await ledger.appendLedger({ consult_id: id, kind, advisor: 'dsh', status: 'started', topic: 'unset' })
  const countField = kind === 'plan' ? { task_count: ids.length } : { claim_count: count }
  await ledger.appendLedger({ consult_id: id, kind, advisor: 'dsh', status: 'ok', topic: 'unset', reply_file: written.file, reply_sha256: written.sha256, ...countField, ...ok })
  return { ...written, text }
}

const sidePath = (ledger, id = ID) => path.join(ledger.repliesDir, `${id}.verification.json`)
const ledgerObjects = (ledger) => (fs.existsSync(ledger.ledgerPath)
  ? readFileSync(ledger.ledgerPath, 'utf8').split('\n').filter(Boolean).map((text) => JSON.parse(text))
  : [])
const verificationLines = (ledger) => ledgerObjects(ledger).filter((entry) => entry.kind === 'verification')
const reportEntry = (ref, status = 'confirmed', extra = {}) => ({
  ref, status, reply_line: 3, evidence: status === 'unverifiable' ? [] : ['src/a.js:1'], ...extra,
})
const VALID_REPORT = Object.freeze({ entries: [reportEntry('1')] })
// Unequal counts, so that a swap or an off-by-one in any count shows: for
// advice with 7 claims, 2 confirmed, 1 refuted and 3 unverifiable claim
// entries (claim 7 has none), and 4 "other" entries of mixed status.
const UNEQUAL_CLAIMS = 7
const UNEQUAL_ENTRIES = Object.freeze([
  reportEntry('1', 'confirmed', { reply_line: 12, evidence: ['src/a.js:1', 'docs/readme.md'] }),
  reportEntry('2', 'confirmed', { reply_line: 13 }),
  reportEntry('3', 'refuted', { reply_line: 14, note: 'the caller passes a path' }),
  reportEntry('4', 'unverifiable', { reply_line: 15 }),
  reportEntry('5', 'unverifiable', { reply_line: 16 }),
  reportEntry('6', 'unverifiable', { reply_line: 17 }),
  reportEntry('other', 'unverifiable', { reply_line: 4, note: 'the recommendation is opinion' }),
  reportEntry('other', 'confirmed', { reply_line: 6, evidence: ['src/sub/b.js:1'] }),
  reportEntry('other', 'refuted', { reply_line: 7 }),
  reportEntry('other', 'confirmed', { reply_line: 8 }),
])
const UNEQUAL_COUNTS = Object.freeze({ expected: 7, covered: 6, entries: 10, confirmed: 2, refuted: 1, unverifiable: 3, other: 4 })
/** The counts of a verification line, by name. */
const countsOf = (line) => Object.fromEntries(Object.keys(UNEQUAL_COUNTS).map((key) => [key, line[key]]))
/** The same counts recomputed from the entries of a side file. */
function countsFromRecord(record, expected) {
  const numbered = record.entries.filter((entry) => entry.ref !== 'other')
  const status = (name) => numbered.filter((entry) => entry.status === name).length
  return {
    expected, covered: new Set(numbered.map((entry) => entry.ref)).size, entries: record.entries.length,
    confirmed: status('confirmed'), refuted: status('refuted'), unverifiable: status('unverifiable'), other: record.entries.length - numbered.length,
  }
}
/** The ledger with counted appends and optional replacements, as a boundary dependency. */
function wrapLedger(base, overrides = {}) {
  const appended = []
  return { appended, ledger: { ...base, appendLedger: (entry) => { appended.push(entry); return base.appendLedger(entry) }, ...overrides } }
}

/** Call the child's own report tool the way the Host executes it. */
function report(c, args, agent = c.agent) {
  const tool = c.registered.get(REPORT_TOOL)
  assert.ok(tool !== undefined, 'the report tool is registered on the child')
  return tool.execute(args, { name: REPORT_TOOL, arguments: args, agent })
}
/** Every guard first, then the tool, as one model tool call. */
function guardedReport(h, c, args) {
  const denial = h.run(c, REPORT_TOOL, args)
  if (denial !== undefined) return Promise.reject(new Error(`denied: ${denial}`))
  return report(c, args)
}
const outcome = (promise) => promise.then(() => 'stored', (error) => error.message)
const renderReport = (c, value) => c.registered.get(REPORT_TOOL).output.render({}, value).map((block) => block.text).join('\n')

const RECORDED_KEYS = Object.freeze([
  'kind', 'schema', 'verifies', 'verified_kind', 'ts', 'status', 'session_id', 'verifier_session_id', 'backend', 'model', 'effort',
  'effort_requested', 'reply_sha256', 'report_file', 'report_sha256', 'expected', 'covered', 'entries', 'confirmed', 'refuted',
  'unverifiable', 'other', 'submit_attempts', 'tool_calls', 'duration_s',
])
const UNRECORDED_KEYS = Object.freeze([
  'kind', 'schema', 'verifies', 'verified_kind', 'ts', 'status', 'reason', 'session_id', 'verifier_session_id', 'backend', 'model', 'effort',
  'effort_requested', 'submit_attempts', 'tool_calls', 'duration_s',
])

test('report: a child-scoped definition with one entries argument and an output schema in the enforced subset', () => {
  const h = harness()
  const c = h.startChild()
  const tool = c.registered.get(REPORT_TOOL)
  assert.equal(tool.name, REPORT_TOOL)
  assert.equal(typeof tool.description, 'string')
  const { parameters } = tool
  assert.deepEqual([parameters.type, Object.keys(parameters.properties), parameters.required, parameters.additionalProperties], ['object', ['entries'], ['entries'], false])
  assert.equal(parameters.properties.entries.type, 'array')
  const { items } = parameters.properties.entries
  assert.deepEqual(Object.keys(items.properties), ['ref', 'status', 'reply_line', 'evidence', 'note'])
  assert.deepEqual(items.required, ['ref', 'status', 'reply_line', 'evidence'], 'note is optional')
  assert.equal(items.additionalProperties, false)
  assert.deepEqual(items.properties.status.enum, ['confirmed', 'refuted', 'unverifiable'])
  assert.deepEqual([items.properties.ref.type, items.properties.reply_line.type, items.properties.reply_line.minimum, items.properties.note.type], ['string', 'integer', 1, 'string'])
  assert.deepEqual(items.properties.evidence.items, { type: 'string' })
  // No id, path, tally, importance, severity, score or summary input at any level.
  for (const name of ['id', 'consult_id', 'path', 'reply_path', 'tally', 'importance', 'severity', 'score', 'weight', 'summary', 'verdict', 'confirmed']) {
    assert.equal(Object.hasOwn(parameters.properties, name) || Object.hasOwn(items.properties, name), false, name)
  }
  assert.deepEqual(schemaErrors(tool.output.schema, { recorded: true, verifies: ID, verified_kind: 'advice', missing: ['2', '3'] }), [])
  assert.deepEqual(schemaErrors(tool.output.schema, { recorded: true, verifies: ID, verified_kind: 'plan', missing: [] }), [])
  assert.notDeepEqual(schemaErrors(tool.output.schema, { recorded: true, verifies: ID, verified_kind: 'plan', missing: [], confirmed: 1 }), [], 'the result carries no counts')
  h.dispose()
})

test('report: validateVerifierReport checks statuses, refs of advice, plans and other, duplicates, ranges, the evidence grammar, protected paths and caps', () => {
  const advice = Object.freeze({ kind: 'advice', expected: 3 })
  const planRun = Object.freeze({ kind: 'plan', expected: 2, taskIds: ['T1', 'T3'] })
  const ok = (args, run = advice) => {
    const result = validateVerifierReport(args, run)
    assert.equal(result.ok, true, result.issues?.join('\n'))
    return result
  }
  const bad = (args, run, pattern, label) => {
    const result = validateVerifierReport(args, run)
    assert.equal(result.ok, false, `${label}: refused`)
    assert.match(result.issues.join('\n'), pattern, label)
  }
  // Statuses.
  for (const status of ['confirmed', 'refuted', 'unverifiable']) ok({ entries: [reportEntry('1', status)] })
  for (const status of ['Confirmed', 'partly', 'verified', '', null, 1]) bad({ entries: [{ ...reportEntry('1'), status }] }, advice, /^entries\.0\.status: /m, String(status))
  // Advice refs: claim numbers 1..claim_count, each at most once, or "other".
  const accepted = ok({ entries: [reportEntry('1'), reportEntry('3', 'refuted'), reportEntry('other', 'unverifiable'), reportEntry('other')] })
  assert.deepEqual(accepted.entries.map((entry) => entry.ref), ['1', '3', 'other', 'other'])
  assert.deepEqual([accepted.covered, accepted.missing], [2, ['2']])
  assert.deepEqual(accepted.counts, { entries: 4, confirmed: 1, refuted: 1, unverifiable: 0, other: 2 })
  const unequal = ok({ entries: UNEQUAL_ENTRIES }, { kind: 'advice', expected: UNEQUAL_CLAIMS })
  const { expected: _expected, covered: _covered, ...unequalCounts } = UNEQUAL_COUNTS
  assert.deepEqual([unequal.covered, unequal.missing, unequal.counts], [UNEQUAL_COUNTS.covered, ['7'], unequalCounts])
  for (const ref of ['0', '4', '03', ' 1', '1 ', '1.0', '-1', '+1', 'T1', 'Other', 'OTHER', 'claim 1', '99999999999999999999']) {
    bad({ entries: [reportEntry(ref)] }, advice, /^entries\.0\.ref: must be a claim number from 1 to 3 \(the 1-based position of the claim in claims\) or "other"$/m, JSON.stringify(ref))
  }
  bad({ entries: [reportEntry('')] }, advice, /^entries\.0\.ref: Too small/m, 'an empty ref')
  bad({ entries: [reportEntry(2)] }, advice, /^entries\.0\.ref: Invalid input: expected string, received number$/m, 'a number')
  bad({ entries: [reportEntry('2'), reportEntry('1'), reportEntry('2', 'refuted')] }, advice, /^entries\.2\.ref: claim 2 already has an entry \(entries\.0\); give one entry per claim$/m, 'a duplicate')
  bad({ entries: [reportEntry('1')] }, { kind: 'advice', expected: 0 }, /^entries\.0\.ref: this advice has no claims; use "other"$/m, 'advice without claims')
  assert.deepEqual(ok({ entries: [reportEntry('other')] }, { kind: 'advice', expected: 0 }).missing, [])
  // Plan refs: the plan's task ids, any number of entries each, or "other".
  const planned = ok({ entries: [reportEntry('T1'), reportEntry('T1'), reportEntry('T1', 'refuted'), reportEntry('other', 'unverifiable')] }, planRun)
  assert.deepEqual([planned.covered, planned.missing, planned.counts], [1, ['T3'], { entries: 4, confirmed: 2, refuted: 1, unverifiable: 0, other: 1 }])
  for (const ref of ['T2', 't1', '1', 'T01', ' T1', 'other ']) bad({ entries: [reportEntry(ref)] }, planRun, /^entries\.0\.ref: must be a task id of this plan \(T1, T3\) or "other"$/m, ref)
  // Evidence: the advice validator's grammar and protected-path rules.
  for (const [reference, pattern] of [
    ['/etc/passwd:1', /path must be workspace-relative/], ['../x.js:1', /path must not contain \.\./], ['.git/config', /path must not touch \.git/],
    ['src/*.js', /path must be a path prefix, not a glob/], ['~/x', /path must not start with ~/], ['src/a.js:0', /lines start at 1/],
    ['src/a.js:5-3', /line range must not run backwards/], ['.env:1', /path reaches a protected file \(\.env\)/], ['id_rsa', /path reaches a protected file \(id_rsa\)/],
    ['config/credentials.json:2', /path reaches a protected file \(credentials\.json\)/], [' src/a.js', /must be a workspace-relative path with optional :line or :start-end/],
  ]) {
    bad({ entries: [reportEntry('1', 'confirmed', { evidence: ['src/a.js:1', reference] })] }, advice, new RegExp(`^entries\\.0\\.evidence\\.1: ${pattern.source}$`, 'm'), reference)
  }
  ok({ entries: [reportEntry('1', 'confirmed', { evidence: ['src/a.js', 'src/a.js:12', 'src/a.js:12-30', '.env.example:1', 'docs/readme.md'] })] })
  // C1 and bidi controls, zero-width and other format characters, tags, separators and unpaired surrogates never reach the side file.
  const UNSAFE = /path must not contain control, format or line separator characters, or unpaired surrogates/
  for (const [label, reference, pattern] of [
    ['C1 NEL', 'src/a\u0085b.js', UNSAFE], ['C1 CSI', 'src/a\u009bb.js:1', UNSAFE], ['RLO', 'src/\u202eb.js', UNSAFE], ['LRI', 'src/a\u2066b.js', UNSAFE],
    ['ALM', 'src/a\u061cb.js', UNSAFE], ['ZWSP', 'src/a\u200b.js', UNSAFE], ['ZWJ', 'src/a\u200db.js', UNSAFE], ['word joiner', 'src/a\u2060b.js', UNSAFE],
    ['inner BOM', 'src/a\ufeffb.js', UNSAFE], ['soft hyphen', 'src/a\u00adb.js', UNSAFE], ['tag', 'src/a\u{E0041}b.js', UNSAFE],
    ['lone high surrogate', 'src/a\ud800b.js', UNSAFE], ['lone low surrogate', 'src/a\udc00b.js', UNSAFE],
    ['line separator', 'src/a\u2028b.js', /must be a workspace-relative path with optional :line or :start-end/],
    ['paragraph separator', 'src/a\u2029b.js', /must be a workspace-relative path with optional :line or :start-end/],
    ['C0', 'src/a\u0007b.js', /path must not contain control characters/],
  ]) {
    bad({ entries: [reportEntry('1', 'confirmed', { evidence: ['src/a.js:1', reference] })] }, advice, new RegExp(`^entries\\.0\\.evidence\\.1: ${pattern.source}$`, 'm'), label)
  }
  ok({ entries: [reportEntry('1', 'confirmed', { evidence: ['src/\u{1F642}.js:1', 'src/a\u00a0b.js', 'docs/\u00e9t\u00e9.md'] })] })
  // Confirmed and refuted need a reference; unverifiable may have none.
  for (const status of ['confirmed', 'refuted']) {
    bad({ entries: [reportEntry('1', status, { evidence: [] })] }, advice, new RegExp(`^entries\\.0\\.evidence: ${status} needs at least one repository reference such as src/a\\.js:12$`, 'm'), status)
  }
  ok({ entries: [reportEntry('1', 'unverifiable', { evidence: [] })] })
  ok({ entries: [reportEntry('1', 'unverifiable', { evidence: ['src/a.js:1'] })] })
  // reply_line is a positive integer.
  for (const replyLine of [0, -1, 1.5, '3', null, Number.NaN, 2 ** 53]) bad({ entries: [reportEntry('1', 'confirmed', { reply_line: replyLine })] }, advice, /^entries\.0\.reply_line: /m, String(replyLine))
  // note: optional, plain, at most 300 characters.
  assert.equal(ok({ entries: [reportEntry('1', 'confirmed', { note: '  checked the caller  ' })] }).entries[0].note, 'checked the caller')
  assert.equal(Object.hasOwn(ok(VALID_REPORT).entries[0], 'note'), false)
  ok({ entries: [reportEntry('1', 'confirmed', { note: 'n'.repeat(300) })] })
  for (const note of ['n'.repeat(301), '', '   ', 7]) bad({ entries: [reportEntry('1', 'confirmed', { note })] }, advice, /^entries\.0\.note: /m, JSON.stringify(note))
  for (const note of [
    'line\nbreak', 'tab\there', 'nul\u0000', 'separator\u2028x', 'paragraph\u2029x', 'c1\u0085x', 'csi\u009bx', 'rlo\u202ex', 'lri\u2066x', 'zwsp\u200bx',
    'zwj\u200dx', 'bom\ufeffx', 'shy\u00adx', 'tag\u{E0041}x', 'high\ud800x', 'low\udc00x', 'ends high\ud800',
  ]) {
    bad({ entries: [reportEntry('1', 'confirmed', { note })] }, advice, /^entries\.0\.note: must be plain text without control, format or line separator characters, or unpaired surrogates$/m, JSON.stringify(note))
  }
  for (const note of ['emoji \u{1F642} ok', 'nbsp\u00a0ok', '\u00e9t\u00e9 \u6f22\u5b57']) {
    assert.equal(ok({ entries: [reportEntry('1', 'confirmed', { note })] }).entries[0].note, note, JSON.stringify(note))
  }
  assert.equal(ok({ entries: [reportEntry('1', 'confirmed', { note: '\ufeff\u2028trimmed\u2029 ' })] }).entries[0].note, 'trimmed', 'surrounding whitespace, a BOM and separators included, is trimmed')
  // Caps: 1 to 100 entries, 0 to 5 references of at most 300 characters.
  assert.equal(MAX_REPORT_ENTRIES, 100)
  bad({ entries: [] }, advice, /^entries: Too small/m, 'no entries')
  ok({ entries: Array.from({ length: MAX_REPORT_ENTRIES }, () => reportEntry('other')) })
  bad({ entries: Array.from({ length: MAX_REPORT_ENTRIES + 1 }, () => reportEntry('other')) }, advice, /^entries: Too big/m, '101 entries')
  ok({ entries: [reportEntry('1', 'confirmed', { evidence: Array(5).fill('src/a.js:1') })] })
  bad({ entries: [reportEntry('1', 'confirmed', { evidence: Array(6).fill('src/a.js:1') })] }, advice, /^entries\.0\.evidence: Too big/m, '6 references')
  bad({ entries: [reportEntry('1', 'confirmed', { evidence: [`src/${'a'.repeat(300)}.js`] })] }, advice, /^entries\.0\.evidence\.0: Too big/m, 'a reference over 300 characters')
  // No id, path, tally, importance, severity, score or summary input.
  for (const key of ['importance', 'severity', 'score', 'weight', 'summary', 'id', 'consult_id', 'path', 'claim']) {
    bad({ entries: [{ ...reportEntry('1'), [key]: 'x' }] }, advice, new RegExp(`^entries\\.0: Unrecognized key: "${key}"$`, 'm'), `entry ${key}`)
  }
  for (const key of ['consult_id', 'id', 'path', 'reply_path', 'tally', 'confirmed', 'summary', 'verdict', 'score', 'importance']) {
    bad({ ...VALID_REPORT, [key]: 'x' }, advice, new RegExp(`^\\(root\\): Unrecognized key: "${key}"$`, 'm'), `root ${key}`)
  }
  for (const args of [undefined, null, [], 'x', 7, {}, { entries: 'x' }, { entries: [null] }, { entries: [reportEntry('1'), 'x'] }]) {
    assert.equal(validateVerifierReport(args, advice).ok, false, JSON.stringify(args))
  }
  // An own __proto__ key, as JSON.parse makes one, is refused like any other unknown key.
  const protoRoot = JSON.parse(`{"entries":[${JSON.stringify(reportEntry('1'))}],"__proto__":{"importance":"high"}}`)
  assert.equal(Object.hasOwn(protoRoot, '__proto__'), true)
  bad(protoRoot, advice, /^\(root\): Unrecognized key: "__proto__"$/m, 'root __proto__')
  const protoEntry = JSON.parse(`{"entries":[${JSON.stringify(reportEntry('1')).slice(0, -1)},"__proto__":{"score":9}}]}`)
  assert.equal(Object.hasOwn(protoEntry.entries[0], '__proto__'), true)
  bad(protoEntry, advice, /^entries\.0: Unrecognized key: "__proto__"$/m, 'entry __proto__')
  const both = JSON.parse(`{"entries":[${JSON.stringify(reportEntry('9')).slice(0, -1)},"__proto__":{}}],"__proto__":{}}`)
  const issuesOfBoth = validateVerifierReport(both, advice).issues
  assert.deepEqual(issuesOfBoth.slice(0, 2), ['(root): Unrecognized key: "__proto__"', 'entries.0: Unrecognized key: "__proto__"'])
})

test('report: evidence uses the advice reference grammar: literal brackets and braces are paths; * and ? and malformed line suffixes are refused, also through the tool', async () => {
  const advice = Object.freeze({ kind: 'advice', expected: 1 })
  const withRefs = (evidence) => ({ entries: [reportEntry('1', 'confirmed', { evidence })] })
  const accepted = validateVerifierReport(withRefs(['app/[id]/page.tsx:3', 'routes/{x}/a.js', 'a/[b]/c.ts:1-4', 'dir/a:b.js', 'a.js:12-14']), advice)
  assert.equal(accepted.ok, true, accepted.issues?.join('\n'))
  const SUFFIX = 'line suffix must be :line or :start-end with positive whole numbers; write path, path:line or path:start-end, such as src/a.js:12 or src/a.js:12-30'
  for (const [reference, issue] of [
    ['src/*.js', 'path must be a path prefix, not a glob'],
    ['a?.js', 'path must be a path prefix, not a glob'],
    ['app/[id]/../x.js', 'path must not contain ..'],
    ['/etc/passwd', 'path must be workspace-relative'],
    ['.git/config', 'path must not touch .git'],
    ['app/[id]/.env', 'path reaches a protected file (.env)'],
    ['a.js:12:5', SUFFIX],
    ['a.js:12-', SUFFIX],
    ['a.js:', SUFFIX],
    ['a.js:0', 'lines start at 1'],
    ['a.js:5-3', 'line range must not run backwards'],
  ]) {
    const result = validateVerifierReport(withRefs(['src/a.js:1', reference]), advice)
    assert.equal(result.ok, false, reference)
    assert.deepEqual(result.issues, [`entries.0.evidence.1: ${issue}`], reference)
  }

  const ledger = freshLedger()
  await recordRun(ledger, { count: 1 })
  const h = harness({ ledger })
  const c = h.startChild()
  await assert.rejects(guardedReport(h, c, withRefs(['a.js:12:5'])), (error) => error.message.includes(`entries.0.evidence.0: ${SUFFIX}`))
  const stored = await guardedReport(h, c, withRefs(['app/[id]/page.tsx:3', 'routes/{x}/a.js']))
  assert.equal(stored.recorded, true)
  assert.deepEqual(JSON.parse(readFileSync(sidePath(ledger), 'utf8')).entries[0].evidence, ['app/[id]/page.tsx:3', 'routes/{x}/a.js'])
  h.dispose()
})

test('report: a valid advice report is stored once: the side file, one flat ledger line with Host-computed counts, and the uncovered claims in the result', async () => {
  const ledger = freshLedger()
  const run = await recordRun(ledger, { count: UNEQUAL_CLAIMS })
  const clock = { value: 1_700_000_000_000 }
  const h = harness({ ledger, now: () => clock.value })
  const c = h.startChild()
  // Four calls pass the identity checks (one of them is then path-denied); bash is not on the allowlist.
  for (const [name, args] of [['read', { file_path: 'src/a.js' }], ['grep', { pattern: 'x' }], ['read', { file_path: '/etc/hosts' }], ['bash', {}]]) h.run(c, name, args)
  clock.value += 12_345
  const entries = UNEQUAL_ENTRIES
  const result = await guardedReport(h, c, { entries })
  assert.deepEqual(result, { recorded: true, verifies: ID, verified_kind: 'advice', missing: ['7'] })
  assert.deepEqual(schemaErrors(c.registered.get(REPORT_TOOL).output.schema, result), [])
  assert.equal(renderReport(c, result), `Verification record stored for ${ID}. No entry for claim(s) 7. It cannot be replaced; your final response is still the report.`)

  const file = sidePath(ledger)
  const bytes = readFileSync(file)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.ok(bytes.length <= MAX_VERIFICATION_BYTES)
  assert.ok(bytes.toString('utf8').endsWith('}\n'))
  const record = JSON.parse(bytes.toString('utf8'))
  assert.deepEqual(record, {
    schema: VERIFICATION_SCHEMA_ID, verifies: ID, entries, reply_sha256: run.sha256, recorded_at: new Date(clock.value).toISOString(),
  })
  assert.equal(VERIFICATION_SCHEMA_ID, 'advisor-verification/1')

  await until(() => verificationLines(ledger).length === 1, 'the verification line')
  const [line] = verificationLines(ledger)
  assert.deepEqual(Object.keys(line), RECORDED_KEYS, 'flat, in this order, and no top-level consult_id')
  assert.deepEqual(line, {
    kind: 'verification', schema: VERIFICATION_SCHEMA_ID, verifies: ID, verified_kind: 'advice', ts: Math.floor(clock.value / 1000), status: 'recorded',
    session_id: 'lead', verifier_session_id: 'verifier-1', backend: 'dsh:unknown', model: null, effort: null, effort_requested: null,
    reply_sha256: run.sha256, report_file: file, report_sha256: sha256(bytes),
    expected: 7, covered: 6, entries: 10, confirmed: 2, refuted: 1, unverifiable: 3, other: 4,
    submit_attempts: 1, tool_calls: 4, duration_s: 12.3,
  })
  assert.deepEqual(countsOf(line), UNEQUAL_COUNTS)
  assert.deepEqual(countsFromRecord(record, UNEQUAL_CLAIMS), countsOf(line), 'the line counts are those of the side file entries')
  const ledgerText = readFileSync(ledger.ledgerPath, 'utf8')
  for (const authored of ['the caller passes a path', 'the recommendation is opinion', 'src/sub/b.js', 'docs/readme.md']) assert.ok(!ledgerText.includes(authored), authored)

  // Once only: the same verifier cannot replace or add a record.
  await assert.rejects(guardedReport(h, c, { entries: [reportEntry('3')] }), /^Error: Your verification record is already stored and cannot be replaced; end with your final report\.$/)
  h.end(c)
  await settle()
  assert.equal(verificationLines(ledger).length, 1, 'a recorded verifier gets no unrecorded line')
  assert.deepEqual(readFileSync(file), bytes)
  h.dispose()
})

test('report: plan refs are the plan\'s task ids; several entries may name one task, and covered counts distinct tasks', async () => {
  const ledger = freshLedger()
  const run = await recordRun(ledger, { kind: 'plan', taskIds: ['T1', 'T2', 'T5'] })
  const h = harness({ ledger })
  const c = h.startChild()
  await assert.rejects(report(c, { entries: [reportEntry('T3')] }), /entries\.0\.ref: must be a task id of this plan \(T1, T2, T5\) or "other"/)
  // Unequal counts: entries, not tasks, are counted per status; covered counts distinct tasks.
  const entries = [
    reportEntry('T1'), reportEntry('T1'), reportEntry('T5', 'refuted'),
    reportEntry('T5', 'unverifiable'), reportEntry('T1', 'unverifiable'), reportEntry('T5', 'unverifiable'),
    reportEntry('other', 'refuted'), reportEntry('other', 'confirmed'), reportEntry('other', 'unverifiable'), reportEntry('other', 'refuted'),
  ]
  const result = await report(c, { entries })
  assert.deepEqual(result, { recorded: true, verifies: ID, verified_kind: 'plan', missing: ['T2'] })
  assert.match(renderReport(c, result), /No entry for task\(s\) T2\./)
  await until(() => verificationLines(ledger).length === 1, 'the verification line')
  const [line] = verificationLines(ledger)
  assert.deepEqual([line.verified_kind, line.reply_sha256, line.submit_attempts], ['plan', run.sha256, 2])
  assert.deepEqual(countsOf(line), { expected: 3, covered: 2, entries: 10, confirmed: 2, refuted: 1, unverifiable: 3, other: 4 })
  assert.deepEqual(countsFromRecord(JSON.parse(readFileSync(sidePath(ledger), 'utf8')), 3), countsOf(line))
  // A full cover says so.
  const full = freshLedger()
  await recordRun(full, { kind: 'plan', taskIds: ['T1'] })
  const f = harness({ ledger: full })
  const fc = f.startChild()
  assert.match(renderReport(fc, await report(fc, { entries: [reportEntry('T1')] })), /Every task has an entry\./)
  h.dispose()
  f.dispose()
})

test('report: two concurrent calls store exactly one record (a synchronous latch before any await)', async () => {
  const base = freshLedger()
  await recordRun(base)
  const writes = []
  const { ledger } = wrapLedger(base, { writeVerification: (id, text) => { writes.push(id); return base.writeVerification(id, text) } })
  const h = harness({ ledger })
  const c = h.startChild()
  const results = await Promise.allSettled([report(c, VALID_REPORT), report(c, VALID_REPORT)])
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected'])
  assert.match(results[1].reason.message, /^Your verification record is being stored and cannot be replaced; end with your final report\.$/)
  assert.deepEqual(writes, [ID], 'one write')
  await assert.rejects(report(c, VALID_REPORT), /already stored/)
  await until(() => verificationLines(base).length === 1, 'the verification line')
  assert.equal(verificationLines(base)[0].submit_attempts, 1, 'a call stopped by the latch is not an attempt')
  h.end(c)
  await settle()
  assert.equal(verificationLines(base).length, 1)
  h.dispose()
})

test('report: one record per consult: a second verifier on the same consult gets already_recorded and the first record is kept', async () => {
  const ledger = freshLedger()
  await recordRun(ledger)
  const h = harness({ ledger })
  const first = h.startChild()
  await report(first, { entries: [reportEntry('1', 'confirmed', { note: 'first' })] })
  const before = readFileSync(sidePath(ledger))
  const second = h.startChild({ id: 'verifier-2' }) // the same consult, another verifier
  await assert.rejects(report(second, { entries: [reportEntry('1', 'refuted', { note: 'second' })] }),
    /^Error: Not recorded: this consult already has a verification record \(one per consult\)\. Your final response is still the report\.$/)
  await assert.rejects(report(second, VALID_REPORT), /^Error: advisor_verifier_report is closed \(already_recorded\); your final response is still the report\.$/)
  assert.deepEqual(readFileSync(sidePath(ledger)), before, 'the first record is kept')
  assert.equal(second.agent.cancelled, 0)
  h.end(first)
  h.end(second)
  await until(() => verificationLines(ledger).length === 2, 'the unrecorded line')
  assert.deepEqual(verificationLines(ledger).map((line) => [line.status, line.reason, line.verifier_session_id, line.submit_attempts]), [
    ['recorded', undefined, 'verifier-1', 1],
    ['unrecorded', 'already_recorded', 'verifier-2', 1],
  ])
  h.dispose()
})

test('report: a failed record write or line append closes the tool with write_failed; the verifier keeps running', async () => {
  const base = freshLedger()
  await recordRun(base)
  const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
  const { ledger } = wrapLedger(base, { writeVerification: async () => { throw denied } })
  const h = harness({ ledger })
  const c = h.startChild()
  await assert.rejects(report(c, VALID_REPORT), /^Error: Not recorded: the verification record could not be stored \(EACCES: permission denied\)\. Your final response is still the report\.$/)
  await assert.rejects(report(c, VALID_REPORT), /is closed \(write_failed\)/)
  assert.equal(c.agent.cancelled, 0)
  assert.equal(h.run(c, 'read', { file_path: 'src/a.js' }), undefined, 'the other tools still work')
  h.end(c)
  await until(() => verificationLines(base).length === 1, 'the unrecorded line')
  assert.deepEqual(verificationLines(base).map((line) => [line.status, line.reason]), [['unrecorded', 'write_failed']])
  h.dispose()

  // The record is stored but its line cannot be appended: the file stays, the outcome is write_failed.
  const second = freshLedger()
  await recordRun(second)
  let full = true
  const appendFails = wrapLedger(second, {
    appendLedger: (entry) => (full && entry.kind === 'verification' ? Promise.reject(new Error('ledger disk full')) : second.appendLedger(entry)),
  })
  const s = harness({ ledger: appendFails.ledger })
  const sc = s.startChild()
  await assert.rejects(report(sc, VALID_REPORT), /could not be stored \(ledger disk full\)/)
  assert.ok(fs.existsSync(sidePath(second)), 'the record file stays, like a reply whose ok line failed')
  full = false
  s.end(sc)
  await until(() => verificationLines(second).length === 1, 'the unrecorded line')
  assert.deepEqual(verificationLines(second).map((line) => [line.status, line.reason]), [['unrecorded', 'write_failed']])
  s.dispose()
})

test('report: a clock that throws never leaves the latch set, an event handler throwing, or the verifier unstarted', async () => {
  const ledger = freshLedger()
  await recordRun(ledger)
  let broken = false
  const h = harness({ ledger, now: () => { if (broken) throw new Error('clock gone'); return 1_700_000_000_000 } })
  const c = h.startChild()
  broken = true
  await assert.rejects(report(c, VALID_REPORT), /^Error: Not recorded: the verification record could not be stored \(clock gone\)\. Your final response is still the report\.$/)
  await assert.rejects(report(c, VALID_REPORT), /is closed \(write_failed\)/, 'the latch was released')
  assert.equal(fs.existsSync(sidePath(ledger)), false)
  assert.doesNotThrow(() => h.end(c))
  await settle()
  assert.ok(h.logs.some((entry) => entry.includes(`the verification line of ${ID} could not be appended: clock gone`)), h.logs.join('\n'))
  assert.equal(verificationLines(ledger).length, 0)
  h.dispose()

  const s = harness({ ledger: freshLedger(), now: () => { throw new Error('clock gone') } })
  const sc = s.startChild()
  assert.equal(sc.agent.cancelled, 0)
  assert.equal(s.run(sc, 'read', { file_path: 'src/a.js' }), undefined)
  assert.doesNotThrow(() => s.dispose())
})

test('report: a reply that changed, is withheld or unreadable, or whose run did not end ok is refused without a write; degraded is accepted', async () => {
  const sameSize = (text) => text.replace('claim 1', 'claim X')
  const cases = [
    ['the reply changed', async (ledger) => { const run = await recordRun(ledger); writeFileSync(run.file, `${run.text} `) }, 'reply_changed', /^the reply no longer matches the reply_sha256 of its terminal ledger line$/],
    ['the reply changed at the same size', async (ledger) => { const run = await recordRun(ledger); writeFileSync(run.file, sameSize(run.text)) }, 'reply_changed', /no longer matches the reply_sha256/],
    ['the reply was deleted', async (ledger) => { const run = await recordRun(ledger); rmSync(run.file) }, 'reply_withheld', /^the reply is withheld: the reply file does not exist$/],
    ['the reply became a symlink', async (ledger) => {
      const run = await recordRun(ledger)
      fs.renameSync(run.file, `${run.file}.moved`)
      symlinkSync(`${run.file}.moved`, run.file)
    }, 'reply_withheld', /^the reply is withheld: the reply file is a symbolic link$/],
    ['the run failed', async (ledger) => {
      await ledger.writeReply(ID, adviceReply(3))
      await ledger.appendLedger({ consult_id: ID, kind: 'advice', status: 'started' })
      await ledger.appendLedger({ consult_id: ID, kind: 'advice', status: 'failed', failure_reason: 'x' })
    }, 'reply_withheld', /^the reply is withheld: the last terminal ledger entry for this consult_id \(sessions\.jsonl:2\) does not name /],
    ['a failed line after the ok line', async (ledger) => {
      await recordRun(ledger)
      await ledger.appendLedger({ consult_id: ID, kind: 'advice', status: 'failed' })
    }, 'reply_withheld', /does not name .* as its reply_file$/],
    ['no line for this consult', async (ledger) => { await recordRun(ledger, { id: OTHER_ID }) }, 'reply_withheld', /^the reply is withheld: the ledger has no terminal entry for this consult_id$/],
    ['a terminal status that is not ok or degraded', async (ledger) => { await recordRun(ledger, { ok: { status: 'done' } }) }, 'reply_withheld', /^the last terminal ledger entry has status done, not ok or degraded$/],
    ['a terminal line of another kind', async (ledger) => { await recordRun(ledger, { ok: { kind: 'review' } }) }, 'reply_withheld', /^the last terminal ledger entry is not a plan or advice run$/],
    ['a terminal line without its count', async (ledger) => { await recordRun(ledger, { ok: { claim_count: undefined } }) }, 'reply_withheld', /^the last terminal ledger entry has no claim_count$/],
    ['a terminal line without reply_sha256', async (ledger) => { await recordRun(ledger, { ok: { reply_sha256: undefined } }) }, 'reply_withheld', /^the last terminal ledger entry records no reply_sha256$/],
    ['a plan reply without task ids', async (ledger) => { await recordRun(ledger, { kind: 'plan', reply: '{"schema":"advisor-plan/1"}\n', taskIds: ['T1'] }) }, 'reply_withheld', /^the reply is not a plan with task ids$/],
  ]
  for (const [label, setup, reason, issue] of cases) {
    const ledger = freshLedger()
    await setup(ledger)
    const h = harness({ ledger })
    const c = h.startChild()
    const message = await outcome(report(c, VALID_REPORT))
    const match = /^Not recorded: (.*)\. Your final response is still the report\.$/.exec(message)
    assert.ok(match !== null, `${label}: ${message}`)
    assert.match(match[1], issue, label)
    assert.equal(fs.existsSync(sidePath(ledger)), false, `${label}: no record`)
    assert.equal(c.agent.cancelled, 0, label)
    h.end(c)
    await until(() => verificationLines(ledger).length === 1, label)
    assert.deepEqual(verificationLines(ledger).map((line) => [line.status, line.reason]), [['unrecorded', reason]], label)
    h.dispose()
  }

  if (typeof process.getuid === 'function') {
    // The data directory turned unsafe: the reply is withheld, nothing is written.
    const ledger = freshLedger()
    await recordRun(ledger)
    const h = harness({ ledger })
    const c = h.startChild()
    fs.chmodSync(ledger.dir, 0o777)
    try {
      assert.match(await outcome(report(c, VALID_REPORT)), /^Not recorded: the reply is withheld: the Advisor data directory is unsafe: .* is writable by group or others \(mode 0777\)\./)
      assert.equal(fs.existsSync(sidePath(ledger)), false)
    } finally {
      fs.chmodSync(ledger.dir, 0o700)
    }
    h.end(c)
    await until(() => verificationLines(ledger).length === 1, 'unsafe folder')
    assert.equal(verificationLines(ledger)[0].reason, 'reply_withheld')
    h.dispose()
  }

  const degraded = freshLedger()
  await recordRun(degraded, { ok: { status: 'degraded' } })
  const d = harness({ ledger: degraded })
  assert.equal((await report(d.startChild(), VALID_REPORT)).recorded, true, 'a degraded terminal line is accepted')
  d.dispose()
})

test('report: bound to its own verifier: another verifier, the lead, a missing agent and a stale record are refused; the Host guard refuses it by name for any other agent', async () => {
  const ledger = freshLedger()
  await recordRun(ledger)
  await recordRun(ledger, { id: OTHER_ID })
  const h = harness({ ledger })
  const c = h.startChild()
  const other = h.startChild({ id: 'verifier-2', self: OTHER_VERIFIER })
  for (const agent of [other.agent, h.lead]) {
    await assert.rejects(report(c, VALID_REPORT, agent), /^Error: advisor_verifier_report is bound to another advisor verifier\.$/, agent.id)
  }
  const tool = c.registered.get(REPORT_TOOL)
  await assert.rejects(tool.execute(VALID_REPORT, { name: REPORT_TOOL, arguments: VALID_REPORT }), /^Error: advisor_verifier_report is bound to another advisor verifier\.$/, 'a call without an agent')
  await assert.rejects(tool.execute(VALID_REPORT, undefined), /bound to another advisor verifier/, 'no execution context')
  const mate = { id: 'mate', names: { self: 'mate', parent: 'lead' }, root: h.lead }
  for (const agent of [h.lead, mate, undefined]) {
    assert.equal(h.hostCall(REPORT_TOOL, VALID_REPORT, agent), 'advisor_verifier_report is only available to its advisor verifier.', String(agent?.id))
  }
  assert.match(h.run(c, REPORT_TOOL, VALID_REPORT, { agent: other.agent }), /no exact agent scope/, 'the child guard refuses another agent')
  assert.equal(fs.existsSync(sidePath(ledger)), false)
  assert.equal(fs.existsSync(sidePath(ledger, OTHER_ID)), false)
  assert.notEqual(c.registered.get(REPORT_TOOL), other.registered.get(REPORT_TOOL), 'one definition per verifier')
  // Each verifier records only its own consult; the id comes from its name, never from an argument.
  await report(other, { entries: [reportEntry('2')] })
  assert.equal(fs.existsSync(sidePath(ledger, OTHER_ID)), true)
  assert.equal(fs.existsSync(sidePath(ledger)), false)
  // A new Agent object under the same id shuts the old one's tool out; the new one records.
  const stale = c.registered.get(REPORT_TOOL)
  const replacement = h.child()
  h.start(replacement)
  await assert.rejects(stale.execute(VALID_REPORT, { name: REPORT_TOOL, arguments: VALID_REPORT, agent: c.agent }), /^Error: Advisor verifier failed closed: no tools are permitted\.$/)
  assert.equal((await report(replacement, VALID_REPORT)).verifies, ID)
  h.dispose()

  // A verifier denied at start has no report tool, and both guards deny the name.
  const refused = harness({ ledger: freshLedger(), dataDirProblem: () => DATA_DIR_NOT_CONFIGURED })
  const r = refused.startChild()
  assert.equal(r.registered.has(REPORT_TOOL), false)
  assert.match(refused.run(r, REPORT_TOOL, VALID_REPORT), /failed closed/)
  assert.match(refused.hostCall(REPORT_TOOL, VALID_REPORT, r.agent), /failed closed/)
  refused.dispose()
})

test('report: after five refused calls the tool closes; the verifier is never cancelled over it', async () => {
  assert.equal(MAX_REPORT_FAILURES, 5)
  const ledger = freshLedger()
  await recordRun(ledger)
  const h = harness({ ledger })
  const c = h.startChild()
  const invalid = { entries: [reportEntry('9')] }
  for (let attempt = 1; attempt < MAX_REPORT_FAILURES; attempt++) {
    await assert.rejects(report(c, invalid), /^Error: Not recorded\. Fix these problems and call advisor_verifier_report again:\n- entries\.0\.ref: must be a claim number from 1 to 3 /)
  }
  await assert.rejects(report(c, invalid), /^Error: Not recorded: advisor_verifier_report refused 5 calls and is now closed; your final response is still the report\.$/)
  await assert.rejects(report(c, VALID_REPORT), /^Error: advisor_verifier_report is closed \(invalid_payload\); your final response is still the report\.$/, 'a valid report after the cap is not stored')
  assert.equal(c.agent.cancelled, 0)
  assert.equal(fs.existsSync(sidePath(ledger)), false)
  for (const [name, args] of ALLOWED_CALLS) assert.equal(h.run(c, name, args), undefined, `${name} is still allowed`)
  assert.equal(typeof (await evidence(c)).reply_sha256, 'string', 'the evidence tool still serves the reply')
  h.end(c)
  await until(() => verificationLines(ledger).length === 1, 'the unrecorded line')
  assert.deepEqual(verificationLines(ledger).map((line) => [line.status, line.reason, line.submit_attempts]), [['unrecorded', 'invalid_payload', 5]])
  h.dispose()

  // Fixed within the cap: recorded, with every attempt counted.
  const retry = freshLedger()
  await recordRun(retry)
  const r = harness({ ledger: retry })
  const rc = r.startChild()
  await assert.rejects(report(rc, invalid))
  await assert.rejects(report(rc, { entries: [] }))
  await report(rc, VALID_REPORT)
  await until(() => verificationLines(retry).length === 1, 'the verification line')
  assert.deepEqual(verificationLines(retry).map((line) => [line.status, line.submit_attempts]), [['recorded', 3]])
  r.dispose()
})

test('report: a record over 64 KB is refused as an invalid payload and nothing is written; a large record under the cap is stored', async () => {
  const ledger = freshLedger()
  await recordRun(ledger)
  const h = harness({ ledger })
  const c = h.startChild()
  const reference = (index) => `src/${String(index).padStart(3, '0')}/${'d'.repeat(280)}.js:1`
  const large = Array.from({ length: MAX_REPORT_ENTRIES }, (_, index) => reportEntry('other', 'confirmed', {
    evidence: Array.from({ length: 5 }, () => reference(index)), note: 'n'.repeat(300),
  }))
  assert.equal(validateVerifierReport({ entries: large }, { kind: 'advice', expected: 3 }).ok, true, 'each entry is valid on its own')
  await assert.rejects(report(c, { entries: large }), /^Error: Not recorded\. Fix these problems and call advisor_verifier_report again:\n- the record would be \d+ bytes, over the 65536-byte cap: shorten notes or evidence, or drop entries$/)
  assert.equal(fs.existsSync(sidePath(ledger)), false)
  assert.equal(c.agent.cancelled, 0)
  // Stored: claims 1 and 2 confirmed, 3 refuted, and 17 "other" entries, 5 of them unverifiable.
  const stored = large.slice(0, 20).map((entry, index) => (index < 3
    ? { ...entry, ref: String(index + 1), status: index < 2 ? 'confirmed' : 'refuted' }
    : { ...entry, status: index < 8 ? 'unverifiable' : 'confirmed' }))
  await report(c, { entries: stored })
  const size = fs.statSync(sidePath(ledger)).size
  assert.ok(size > 32 * 1024 && size <= MAX_VERIFICATION_BYTES, `${size} bytes`)
  assert.equal(fs.statSync(sidePath(ledger)).mode & 0o777, 0o600)
  await until(() => verificationLines(ledger).length === 1, 'the verification line')
  const [line] = verificationLines(ledger)
  assert.equal(line.submit_attempts, 2)
  assert.deepEqual(countsOf(line), { expected: 3, covered: 3, entries: 20, confirmed: 2, refuted: 1, unverifiable: 0, other: 17 })
  assert.deepEqual(countsFromRecord(JSON.parse(readFileSync(sidePath(ledger), 'utf8')), 3), countsOf(line))
  h.dispose()
})

test('unrecorded: an allowed verifier that ends without a record appends one unrecorded line with a fixed reason, once', async () => {
  const eacces = () => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
  const cases = [
    ['not_called', async () => {}, 0],
    ['invalid_payload', async (c) => { await outcome(report(c, { entries: [] })) }, 1],
    ['reply_changed', async (c, run) => { writeFileSync(run.file, `${run.text} `); await outcome(report(c, VALID_REPORT)) }, 1],
    ['reply_withheld', async (c, run) => { rmSync(run.file); await outcome(report(c, VALID_REPORT)) }, 1],
    ['already_recorded', async (c, _run, base) => { await base.writeVerification(ID, '{}\n'); await outcome(report(c, VALID_REPORT)) }, 1],
    ['write_failed', async (c) => { await outcome(report(c, VALID_REPORT)) }, 1, { writeVerification: eacces }],
    // The last refusal decides.
    ['reply_changed', async (c, run) => {
      await outcome(report(c, { entries: [] }))
      writeFileSync(run.file, `${run.text} `)
      await outcome(report(c, VALID_REPORT))
    }, 2],
  ]
  for (const [reason, act, attempts, overrides] of cases) {
    const base = freshLedger()
    const run = await recordRun(base)
    const { ledger, appended } = wrapLedger(base, overrides)
    const clock = { value: 1_700_000_000_000 }
    const h = harness({ ledger, now: () => clock.value })
    const c = h.startChild()
    await act(c, run, base)
    clock.value += 2_000
    h.end(c)
    assert.equal(appended.length, 1, `${reason}: appended at the end`)
    h.agentDisposed(c)
    h.end(c)
    h.dispose()
    assert.equal(appended.length, 1, `${reason}: once`)
    await until(() => verificationLines(base).length === 1, reason)
    const [line] = verificationLines(base)
    assert.deepEqual(Object.keys(line), UNRECORDED_KEYS, reason)
    assert.deepEqual(line, {
      kind: 'verification', schema: VERIFICATION_SCHEMA_ID, verifies: ID, verified_kind: 'advice', ts: Math.floor(clock.value / 1000), status: 'unrecorded', reason,
      session_id: 'lead', verifier_session_id: 'verifier-1', backend: 'dsh:unknown', model: null, effort: null, effort_requested: null,
      submit_attempts: attempts, tool_calls: 0, duration_s: 2,
    }, reason)
  }
  assert.deepEqual([...UNRECORDED_REASONS].sort(), [...new Set(cases.map(([reason]) => reason))].sort(), 'every reason is covered')
  assert.equal(Object.isFrozen(UNRECORDED_REASONS), true)
})

test('unrecorded: agent/disposed and plugin dispose write it once; recorded and denied verifiers write none; an end during the write waits for it', async () => {
  // agent/disposed alone, then a late end.
  {
    const base = freshLedger()
    await recordRun(base)
    const { ledger, appended } = wrapLedger(base)
    const h = harness({ ledger })
    const c = h.startChild()
    h.agentDisposed(c)
    h.end(c)
    h.dispose()
    assert.deepEqual(appended.map((line) => [line.status, line.reason]), [['unrecorded', 'not_called']])
  }
  // Plugin dispose stops the verifier and writes its line once.
  {
    const base = freshLedger()
    await recordRun(base)
    const { ledger, appended } = wrapLedger(base)
    const h = harness({ ledger })
    const c = h.startChild()
    h.dispose()
    assert.equal(c.agent.cancelled, 1)
    h.end(c)
    assert.deepEqual(appended.map((line) => [line.status, line.reason]), [['unrecorded', 'not_called']])
  }
  // A recorded verifier writes no unrecorded line, whatever ends it.
  {
    const base = freshLedger()
    await recordRun(base)
    const { ledger, appended } = wrapLedger(base)
    const h = harness({ ledger })
    const c = h.startChild()
    await report(c, VALID_REPORT)
    h.end(c)
    h.agentDisposed(c)
    h.dispose()
    assert.deepEqual(appended.map((line) => line.status), ['recorded'])
  }
  // A verifier denied at start is not allowed: no line at all.
  for (const [label, options, childOptions] of [
    ['malformed name', {}, { self: `${VERIFIER}-x` }],
    ['not the lead\'s child', {}, { parent: 'mate' }],
    ['data directory unusable', { dataDirProblem: () => DATA_DIR_NOT_CONFIGURED }, {}],
    ['workspace unknown', { workspace: 'relative' }, {}],
    ['its boundary failed closed at the first start', {}, { refuse: [REPORT_TOOL] }],
  ]) {
    const base = freshLedger()
    await recordRun(base)
    const { ledger, appended } = wrapLedger(base)
    const h = harness({ ledger, ...options })
    const c = h.startChild(childOptions)
    assert.equal(c.agent.cancelled, 1, label)
    h.end(c)
    h.agentDisposed(c)
    h.dispose()
    assert.deepEqual(appended, [], label)
  }
  // The verifier ends while its record is being written: the write decides.
  for (const fails of [false, true]) {
    const base = freshLedger()
    await recordRun(base)
    let release
    const { ledger, appended } = wrapLedger(base, {
      writeVerification: async (id, text) => {
        await new Promise((resolve) => { release = resolve })
        if (fails) throw new Error('disk full')
        return base.writeVerification(id, text)
      },
    })
    const h = harness({ ledger })
    const c = h.startChild()
    const pending = outcome(report(c, VALID_REPORT))
    await settle()
    h.end(c)
    assert.deepEqual(appended, [], `${fails}: no line while the write is in flight`)
    release()
    assert.match(await pending, fails ? /could not be stored \(disk full\)/ : /^stored$/)
    const outcomeLine = [fails ? ['unrecorded', 'write_failed'] : ['recorded', undefined]]
    // The call in flight writes the outcome itself, before anything else disposes the verifier.
    assert.deepEqual(appended.map((line) => [line.status, line.reason]), outcomeLine, `${fails}: written by the call in flight`)
    await settle()
    h.agentDisposed(c)
    h.dispose()
    assert.deepEqual(appended.map((line) => [line.status, line.reason]), outcomeLine, String(fails))
  }
  // A new Agent object under the same id takes the verifier over: the late
  // disposal of the old object writes no early unrecorded line.
  {
    const base = freshLedger()
    await recordRun(base)
    const { ledger, appended } = wrapLedger(base)
    const h = harness({ ledger })
    const old = h.startChild()
    const replacement = h.child()
    h.start(replacement)
    h.agentDisposed(old)
    assert.deepEqual(appended, [], 'no line while the new object still runs')
    assert.equal((await report(replacement, VALID_REPORT)).recorded, true)
    h.end(replacement)
    h.agentDisposed(replacement)
    h.dispose()
    assert.deepEqual(appended.map((line) => line.status), ['recorded'])
  }
  // A later start of an ended verifier keeps its outcome.
  {
    const base = freshLedger()
    await recordRun(base)
    const { ledger, appended } = wrapLedger(base)
    const h = harness({ ledger })
    const c = h.startChild()
    h.end(c)
    h.start(c)
    assert.equal(c.agent.cancelled, 0)
    await assert.rejects(report(c, VALID_REPORT), /^Error: Not recorded: this verifier already ended without a record; the first outcome of a verifier is final\. Your final response is still the report\.$/)
    h.end(c)
    assert.deepEqual(appended.map((line) => [line.status, line.reason]), [['unrecorded', 'not_called']])
    const recorded = harness({ ledger: wrapLedger(await (async () => { const l = freshLedger(); await recordRun(l); return l })()).ledger })
    const rc = recorded.startChild()
    await report(rc, VALID_REPORT)
    recorded.end(rc)
    recorded.start(rc)
    await assert.rejects(report(rc, VALID_REPORT), /already stored/)
    recorded.end(rc)
    await settle()
    assert.deepEqual(verificationLines(recorded.ledger).map((line) => line.status), ['recorded'])
    recorded.dispose()
    h.dispose()
  }
})

test('final lines: the first verification line of a verifier session is final, also for a new Agent object under its id or after a plugin reload', async () => {
  const statuses = (ledger) => verificationLines(ledger).map((line) => [line.status, line.reason, line.verifier_session_id])
  // 1. Ended without a record, disposed, then a new Agent object under the same id starts and reports.
  {
    const base = freshLedger()
    await recordRun(base)
    const { ledger, appended } = wrapLedger(base)
    const h = harness({ ledger })
    const c = h.startChild()
    h.end(c)
    h.agentDisposed(c)
    const again = h.child() // the same id, a new Agent object
    h.start(again)
    assert.equal(again.agent.cancelled, 0)
    assert.match(await outcome(report(again, VALID_REPORT)), /^Not recorded: this verifier already ended without a record; the first outcome of a verifier is final\. Your final response is still the report\.$/)
    h.end(again)
    h.agentDisposed(again)
    h.dispose()
    assert.deepEqual(appended.map((line) => [line.status, line.reason]), [['unrecorded', 'not_called']], 'no recorded line and no second unrecorded line')
    assert.equal(fs.existsSync(sidePath(base)), false)
  }
  // 2. The same after a plugin reload: the new boundary knows the verifier only from the ledger.
  for (const reportsAgain of [true, false]) {
    const base = freshLedger()
    await recordRun(base)
    const first = harness({ ledger: base })
    first.end(first.startChild())
    await until(() => verificationLines(base).length === 1, 'the unrecorded line')
    first.dispose()
    const { ledger, appended } = wrapLedger(base)
    const reloaded = harness({ ledger })
    const again = reloaded.startChild() // the same id 'verifier-1'
    if (reportsAgain) {
      assert.match(await outcome(report(again, VALID_REPORT)), /^Not recorded: this verifier already has a verification line in the ledger; the first one is final\. Your final response is still the report\.$/)
      await assert.rejects(report(again, VALID_REPORT), /is closed \(already_recorded\)/)
    }
    reloaded.end(again)
    reloaded.agentDisposed(again)
    reloaded.dispose()
    assert.deepEqual(appended, [], `${reportsAgain}: the reloaded boundary writes nothing for it`)
    assert.deepEqual(statuses(base), [['unrecorded', 'not_called', 'verifier-1']])
    assert.equal(fs.existsSync(sidePath(base)), false)
  }
  // 3. A verifier that recorded, then a reload: its later report is refused and its end writes no unrecorded line.
  {
    const base = freshLedger()
    await recordRun(base)
    const first = harness({ ledger: base })
    const c = first.startChild()
    await report(c, VALID_REPORT)
    first.end(c)
    first.dispose()
    await until(() => verificationLines(base).length === 1, 'the recorded line')
    const reloaded = harness({ ledger: base })
    const again = reloaded.startChild()
    assert.match(await outcome(report(again, VALID_REPORT)), /already has a verification line in the ledger/)
    reloaded.end(again)
    reloaded.dispose()
    await settle()
    assert.deepEqual(statuses(base), [['recorded', undefined, 'verifier-1']])
  }
  // 4. Another verifier session on the same consult still records after the first ended without a record.
  {
    const base = freshLedger()
    await recordRun(base)
    const h = harness({ ledger: base })
    h.end(h.startChild())
    await until(() => verificationLines(base).length === 1, 'the unrecorded line')
    const other = h.startChild({ id: 'verifier-2' })
    assert.equal((await report(other, VALID_REPORT)).recorded, true)
    h.end(other)
    h.dispose()
    await until(() => verificationLines(base).length === 2, 'the recorded line')
    assert.deepEqual(statuses(base), [['unrecorded', 'not_called', 'verifier-1'], ['recorded', undefined, 'verifier-2']])
  }
  // 5. A recorded line of the consult refuses every later report, also when its side file is gone.
  {
    const base = freshLedger()
    await recordRun(base)
    const h = harness({ ledger: base })
    const c = h.startChild()
    await report(c, VALID_REPORT)
    h.end(c)
    await until(() => verificationLines(base).length === 1, 'the recorded line')
    rmSync(sidePath(base))
    const other = h.startChild({ id: 'verifier-2' })
    assert.match(await outcome(report(other, VALID_REPORT)), /^Not recorded: this consult already has a verification record \(one per consult\)\./)
    assert.equal(fs.existsSync(sidePath(base)), false, 'no second record')
    h.end(other)
    h.dispose()
    await until(() => verificationLines(base).length === 2, 'the unrecorded line')
    assert.deepEqual(statuses(base), [['recorded', undefined, 'verifier-1'], ['unrecorded', 'already_recorded', 'verifier-2']])
  }
})

test('report: no verifier-authored text reaches sessions.jsonl; it lives only in the side file', async () => {
  const ledger = freshLedger()
  await recordRun(ledger)
  const h = harness({ ledger })
  const c = h.startChild()
  await outcome(report(c, { entries: [reportEntry('FAKE_REF_CANARY', 'confirmed', { note: 'FAKE_REFUSED_NOTE' })], FAKE_KEY_CANARY: 'FAKE_VALUE_CANARY' }))
  await outcome(report(c, { entries: [reportEntry('1', 'confirmed', { evidence: ['src/FAKE_PROTECTED/.env'] })] }))
  assert.match(await outcome(report(c, { entries: [reportEntry('1', 'confirmed', { note: 'FAKE_BIDI\u202eNOTE', evidence: ['src/FAKE_ZW\u200b.js'] })] })), /must be plain text without control, format/)
  assert.match(await outcome(report(c, JSON.parse(`{"entries":[${JSON.stringify(reportEntry('1'))}],"__proto__":{"note":"FAKE_PROTO_CANARY"}}`))), /Unrecognized key: "__proto__"/)
  await report(c, {
    entries: [
      reportEntry('1', 'confirmed', { note: 'FAKE_NOTE_CANARY', evidence: ['src/FAKE_EVIDENCE_CANARY.js:4'] }),
      reportEntry('other', 'unverifiable', { note: 'FAKE_OTHER_NOTE' }),
    ],
  })
  const second = h.startChild({ id: 'verifier-2' })
  await outcome(report(second, { entries: [reportEntry('2', 'refuted', { note: 'FAKE_SECOND_NOTE', evidence: ['src/FAKE_SECOND.js'] })] }))
  h.end(c)
  h.end(second)
  await until(() => verificationLines(ledger).length === 2, 'both verification lines')
  const ledgerText = readFileSync(ledger.ledgerPath, 'utf8')
  assert.doesNotMatch(ledgerText, /FAKE_/, 'no ref, note, evidence or key from a verifier is on any line')
  const side = readFileSync(sidePath(ledger), 'utf8')
  for (const canary of ['FAKE_NOTE_CANARY', 'FAKE_EVIDENCE_CANARY', 'FAKE_OTHER_NOTE']) assert.ok(side.includes(canary), canary)
  assert.doesNotMatch(side, /FAKE_SECOND|FAKE_REF_CANARY|FAKE_REFUSED|FAKE_KEY|FAKE_VALUE|FAKE_PROTECTED|FAKE_BIDI|FAKE_ZW|FAKE_PROTO/, 'refused entries are never stored')
  const stored = JSON.parse(side).entries.flatMap((entry) => [entry.note ?? '', ...entry.evidence])
  assert.ok(stored.every((text) => !/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u.test(text)), 'no control, format or separator character, and no unpaired surrogate, is stored')
  for (const line of verificationLines(ledger)) {
    for (const [key, value] of Object.entries(line)) {
      if (typeof value !== 'string') continue
      const hostValues = [ID, VERIFICATION_SCHEMA_ID, 'verification', 'advice', 'recorded', 'unrecorded', 'already_recorded', 'lead', 'verifier-1', 'verifier-2', 'dsh:unknown', sidePath(ledger)]
      assert.ok(hostValues.includes(value) || /^[0-9a-f]{64}$/.test(value), `${key}: ${value}`)
    }
  }
  h.dispose()
})

test('readers: after verification lines, the evidence tool still serves the reply and lists only run lines; id-keyed readers are unchanged', async () => {
  const ledger = freshLedger()
  const run = await recordRun(ledger)
  const before = { entries: ledger.ledgerEntriesFor(ID), used: ledger.idInUse(ID), recent: await ledger.recentLedger() }
  const h = harness({ ledger })
  const first = h.startChild()
  const firstEvidence = await evidence(first)
  await report(first, VALID_REPORT)
  h.end(first)
  // A second verifier of the same consult (an A/B round): unrecorded already_recorded.
  const second = h.startChild({ id: 'verifier-2' })
  await outcome(report(second, VALID_REPORT))
  h.end(second)
  await until(() => verificationLines(ledger).length === 2, 'two verification lines')
  // A third verifier still gets the reply: the terminal entry is still the ok line.
  const third = h.startChild({ id: 'verifier-3' })
  const value = await evidence(third)
  assert.equal(value.reply_text, firstEvidence.reply_text)
  assert.equal(value.reply_sha256, run.sha256)
  assert.equal(value.reply_reason, null)
  assert.deepEqual(value.entries, firstEvidence.entries, 'the same ledger lines, at the same numbers: no verification line')
  assert.doesNotMatch(render(third, value), /verification/)
  assert.deepEqual(ledger.ledgerEntriesFor(ID), before.entries)
  assert.equal(ledger.idInUse(ID), before.used)
  assert.equal(await ledger.recentLedger(), before.recent, '/advisor status lists runs only')
  assert.ok(verificationLines(ledger).every((line) => !Object.hasOwn(line, 'consult_id')))
  h.dispose()
})

test('report: the line names the verifier\'s own route: its reported selection, else the stored Verifier model; effort_requested is the stored effort at its first start', async () => {
  const stored = { provider: 'openrouter', model: '~deepseek/deepseek-flash-latest', effort: 'low' }
  const cases = [
    ['a reported selection with its effort', stored, { provider: stored.provider, model: stored.model, reasoningEffort: 'low' }, { backend: `dsh:${stored.provider}/${stored.model}`, model: stored.model, effort: 'low', effort_requested: 'low' }],
    ['a reported selection without an effort', { provider: 'p', model: 'm' }, { provider: 'p', model: 'm' }, { backend: 'dsh:p/m', model: 'm', effort: null, effort_requested: null }],
    ['an unreadable selection falls back to the stored route', stored, new Error('no selection'), { backend: `dsh:${stored.provider}/${stored.model}`, model: stored.model, effort: null, effort_requested: 'low' }],
    ['Inherit and no selection', null, undefined, { backend: 'dsh:unknown', model: null, effort: null, effort_requested: null }],
  ]
  for (const [label, setting, current, expected] of cases) {
    const ledger = freshLedger()
    await recordRun(ledger)
    let selected = setting
    const h = harness({ ledger, selectedRoute: () => selected })
    const c = h.startChild({ model: { current() { if (current instanceof Error) throw current; return current } } })
    selected = { provider: 'later', model: 'changed', effort: 'max' } // a later change of the setting does not matter
    await report(c, VALID_REPORT)
    await until(() => verificationLines(ledger).length === 1, label)
    const [line] = verificationLines(ledger)
    assert.deepEqual({ backend: line.backend, model: line.model, effort: line.effort, effort_requested: line.effort_requested }, expected, label)
    h.dispose()
  }
  // A throwing setting at start records null.
  const ledger = freshLedger()
  await recordRun(ledger)
  const h = harness({ ledger, selectedRoute: () => { throw new Error('state gone') } })
  const c = h.startChild()
  assert.equal(c.agent.cancelled, 0)
  h.end(c)
  await until(() => verificationLines(ledger).length === 1, 'the unrecorded line')
  assert.deepEqual([verificationLines(ledger)[0].backend, verificationLines(ledger)[0].effort_requested], ['dsh:unknown', null])
  h.dispose()
})

test('text: the verifier policy and the lead workflow ask for one status-only report that matches the final response and decides nothing', () => {
  const policy = VERIFIER_POLICY.replace(/\s+/g, ' ')
  for (const phrase of [
    'After you finish the claim review, call advisor_verifier_report once with one entry per claim you checked, status and file:line evidence only; the entries must match your final report.',
    'for advice the 1-based position of the claim in claims, for a plan the task id, otherwise "other"',
    'confirmed and refuted need at least one', 'an optional plain note of at most 300 characters',
    'The record is measurement, not a verdict, and its absence invalidates nothing', 'Your final response stays the sole report.',
    'Do not provide an aggregate tally, score, accept/reject conclusion, or overall verdict.',
  ]) assert.ok(policy.includes(phrase), phrase)
  const workflow = VERIFIER_WORKFLOW.replace(/\s+/g, ' ')
  for (const phrase of [
    'the teammate calls advisor_verifier_report once, with one entry per claim it checked: status and file:line evidence only.',
    'no consult_id', 'The record is measurement, not a verdict, and its absence invalidates nothing; the lead\'s task, completion, and hash checks do not change.',
    'Its final response is the sole report', 'the lead keeps both hash checks',
  ]) assert.ok(workflow.includes(phrase), phrase)
  for (const text of [VERIFIER_POLICY, VERIFIER_WORKFLOW]) assert.doesNotMatch(text, /importance|severity|weight/i)
})

test('text: the README documents the report tool, the record file, the verification line, the unrecorded reasons, the readers and offline tallies', () => {
  const text = readFileSync(README, 'utf8')
  const collapsed = text.replace(/\s+/g, ' ')
  assert.ok(!collapsed.includes('verifiers write no ledger line'), 'the stale sentence is gone')
  assert.ok(collapsed.includes('its verification line records `effort` and `effort_requested` the same way'))
  const data = text.slice(text.indexOf('### Data directory'), text.indexOf('### What the lead does next')).replace(/\s+/g, ' ')
  assert.ok(data.includes('`<dataDir>/replies/<id>.verification.json`: at most one verification record per run (mode 0600, created exclusively, at most 64 KB)'), 'the data directory lists the record file')
  assert.ok(data.includes('Verification lines have no top-level `consult_id`, so they are never an entry of the run they verify.'))
  const evidenceSection = text.slice(text.indexOf('## Evidence verification'), text.indexOf('### Verification records')).replace(/\s+/g, ' ')
  for (const phrase of [
    'Only `read`, `grep`, `glob`, `team_task_get`, `advisor_evidence_get`, and `advisor_verifier_report` are allowed.',
    'After the claim review it calls `advisor_verifier_report` once', 'its absence invalidates nothing', 'the final response counts',
  ]) assert.ok(evidenceSection.includes(phrase), phrase)
  assert.ok(text.indexOf('### Verification records') > text.indexOf('## Evidence verification') && text.indexOf('### Verification records') < text.indexOf('## License'))
  const section = text.slice(text.indexOf('### Verification records'), text.indexOf('## License')).replace(/\s+/g, ' ')
  for (const phrase of [
    '`advisor_verifier_report`', 'one entry per claim it checked', 'The record is measurement, not a verdict', 'a missing record invalidates nothing',
    '`entries`, holds 1 to 100 entries', '`"other"`', 'appears at most once', '`confirmed` and `refuted` need at least one', 'at most 300 characters',
    'There is no ID, path, tally, importance, severity, score or summary input.', 'A claim without an entry is not an error', '`expected` and `covered`',
    'The result carries no counts.', 'After five refused calls the tool closes; the verifier is never stopped over it.', 'A synchronous latch lets only one call write.',
    '`<dataDir>/replies/<id>.verification.json`, created exclusively with mode 0600, at most 64 KB', '`schema: advisor-verification/1`', '`recorded_at`',
    'Verifier-authored text, the notes and evidence, lives only in this file', 'with Host-authored values only',
    ...RECORDED_KEYS.map((key) => `\`${key}\``), '`status: unrecorded`', ...UNRECORDED_REASONS.map((reason) => `\`${reason}\``),
    'One record per consult', 'records `already_recorded`', 'no top-level `consult_id`', '`/advisor status` skips them', 'state version 7',
    'There are no token or cost fields for verifiers.',
    // Plan counts are per entry; ids are agent ids; the first line of a verifier session is final.
    'For a plan the status counts are per entry, not per task: one task can have several entries.',
    '| `session_id`, `verifier_session_id` | the agent ids of the lead and of the verifier, as in the planner\'s `session_id` and `planner_session_id` |',
    'The first verification line of a verifier session is final.', 'a later report from the same agent id is refused as `already_recorded`',
    'no second `unrecorded` line is written', 'also after a plugin reload or for a new Agent object under the same id',
    // The offline tally divides by the verified runs, not by all ok runs.
    'divide by the `ok` or `degraded` terminal lines that have a verification line for their ID, `recorded` or `unrecorded`',
    'not by all `ok` terminal lines', 'only runs verified while verification was on',
  ]) assert.ok(section.includes(phrase), phrase)
  for (const stale of ['divide their count by all `ok` terminal lines', 'the `ok` terminal lines lacking a `recorded` verification line', 'the lead\'s and the verifier\'s session']) {
    assert.ok(!section.includes(stale), `stale: ${stale}`)
  }
})

// ---------------------------------------------------------------------------
// Mutation checks: each protection is removed from a temporary copy of the
// sources, and the scenario that pins it must hold for the real sources and
// fail for the copy.

const ZOD_URL = import.meta.resolve('zod')
const SOURCES = Object.freeze({ verifier: { installVerifierBoundary }, ledger: { createLedger } })

/** Load a copy of src/ (verifier, ledger, planner, state) with `search` replaced once in `file`. */
async function mutant(file, search, replace) {
  const dir = mkdtempSync(path.join(TMP, 'mutant-'))
  for (const name of ['verifier.js', 'ledger.js', 'planner.js', 'state.js']) {
    let text = readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8').replaceAll("from 'zod'", `from ${JSON.stringify(ZOD_URL)}`)
    if (name === file) {
      assert.equal(text.split(search).length - 1, 1, `the mutation target occurs once in ${file}: ${search}`)
      text = text.replace(search, () => replace)
    }
    writeFileSync(path.join(dir, name), text)
  }
  const load = (name) => import(pathToFileURL(path.join(dir, name)).href)
  return { verifier: await load('verifier.js'), ledger: await load('ledger.js') }
}

/** Run a scenario on the real sources (it must hold) and on the mutant (it must not). */
async function assertPinned(scenario, file, search, replace) {
  assert.equal(await scenario(SOURCES), true, 'the protection holds in src/')
  assert.equal(await scenario(await mutant(file, search, replace)), false, 'without it the scenario fails')
}

/** A fresh recorded run on the given ledger module, and a harness on the given boundary. */
async function scenarioSetup(modules, overrides, runOptions) {
  const base = modules.ledger.createLedger(mkdtempSync(path.join(TMP, 'scenario-')))
  const run = await recordRun(base, runOptions)
  const { ledger, appended } = wrapLedger(base, overrides?.(base))
  const h = harness({ ledger, installBoundary: modules.verifier.installVerifierBoundary })
  return { base, run, ledger, appended, h }
}

test('mutation: the synchronous latch is what stops a concurrent second write', async () => {
  await assertPinned(async (modules) => {
    let writes = 0
    const { h } = await scenarioSetup(modules, (base) => ({ writeVerification: (id, text) => { writes++; return base.writeVerification(id, text) } }))
    const c = h.startChild()
    const results = await Promise.allSettled([report(c, VALID_REPORT), report(c, VALID_REPORT)])
    h.end(c)
    h.dispose()
    const refused = results.filter((result) => result.status === 'rejected')
    return writes === 1 && refused.length === 1 && /being stored/.test(refused[0].reason.message)
  }, 'verifier.js', '    report.recording = true\n', '')
})

test('mutation: the reply hash check is what refuses a changed reply', async () => {
  await assertPinned(async (modules) => {
    const { base, run, h } = await scenarioSetup(modules)
    writeFileSync(run.file, `${run.text} `)
    const c = h.startChild()
    const message = await outcome(report(c, VALID_REPORT))
    h.end(c)
    h.dispose()
    return /no longer matches the reply_sha256/.test(message) && !fs.existsSync(sidePath(base))
  }, 'verifier.js', 'if (replySha256 !== entry.reply_sha256)', 'if (false)')
})

test('mutation: the exclusive create is what keeps one record per consult', async () => {
  await assertPinned(async (modules) => {
    const { base, h } = await scenarioSetup(modules)
    // A record without its line (its append failed, or another host wrote it):
    // no ledger line refuses the report, only the exclusive create does.
    const first = await base.writeVerification(ID, '{"first":true}\n')
    const c = h.startChild()
    const message = await outcome(report(c, { entries: [reportEntry('1', 'refuted', { note: 'second' })] }))
    h.end(c)
    h.dispose()
    await settle()
    return /already has a verification record/.test(message) && readFileSync(first.file, 'utf8') === '{"first":true}\n'
  }, 'ledger.js', "await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 })", "await fs.writeFile(target, bytes, { flag: 'w', mode: 0o600 })")
})

test('mutation: the agent binding is what keeps another agent from recording for a verifier', async () => {
  await assertPinned(async (modules) => {
    const { base, h } = await scenarioSetup(modules)
    const c = h.startChild()
    const other = h.startChild({ id: 'verifier-2', self: OTHER_VERIFIER })
    const byOther = await outcome(report(c, VALID_REPORT, other.agent))
    const byLead = await outcome(report(c, VALID_REPORT, h.lead))
    h.dispose()
    return /bound to another advisor verifier/.test(byOther) && /bound to another advisor verifier/.test(byLead) && !fs.existsSync(sidePath(base))
  }, 'verifier.js', "    if (exec?.agent === undefined || exec.agent !== record.agent) throw new Error(`${REPORT_TOOL} is bound to another advisor verifier.`)\n", '')
})

test('mutation: the Host computes each count from the validated entries, other refs apart; a swap or an off-by-one shows', async () => {
  const scenario = async (modules) => {
    const { base, h } = await scenarioSetup(modules, undefined, { count: UNEQUAL_CLAIMS })
    const c = h.startChild()
    await report(c, { entries: UNEQUAL_ENTRIES })
    await until(() => verificationLines(base).length === 1, 'the verification line')
    h.dispose()
    return JSON.stringify(countsOf(verificationLines(base)[0])) === JSON.stringify(UNEQUAL_COUNTS)
  }
  for (const [search, replace] of [
    ['const numbered = entries.filter((entry) => entry.ref !== OTHER_REF)', 'const numbered = entries'],
    ["confirmed: count('confirmed'), refuted: count('refuted')", "confirmed: count('refuted'), refuted: count('confirmed')"],
    ["refuted: count('refuted'), unverifiable: count('unverifiable')", "refuted: count('unverifiable'), unverifiable: count('refuted')"],
    ["unverifiable: count('unverifiable'), other", "unverifiable: count('unverifiable') - 1, other"],
    ['other: entries.length - numbered.length', 'other: entries.length - numbered.length + 1'],
    ['return { entries: entries.length,', 'return { entries: numbered.length,'],
    ['covered: checked.covered,', 'covered: run.expected,'],
    ['expected: run.expected,', 'expected: checked.covered,'],
  ]) await assertPinned(scenario, 'verifier.js', search, replace)
})

test('mutation: no top-level consult_id is what keeps the readers and the evidence tool unchanged', async () => {
  await assertPinned(async (modules) => {
    const { base, run, h } = await scenarioSetup(modules)
    const before = base.ledgerEntriesFor(ID)
    const c = h.startChild()
    await report(c, VALID_REPORT)
    h.end(c)
    await until(() => verificationLines(base).length === 1, 'the verification line')
    const later = h.startChild({ id: 'verifier-2' })
    const value = await evidence(later)
    h.dispose()
    return JSON.stringify(base.ledgerEntriesFor(ID)) === JSON.stringify(before) && value.reply_sha256 === run.sha256 && value.entries.length === 2
      && !Object.hasOwn(verificationLines(base)[0], 'consult_id')
  }, 'verifier.js', "...lineHead(report, 'recorded', run.kind, recordedAt),", "...lineHead(report, 'recorded', run.kind, recordedAt), consult_id: report.consultId,")
})

test('mutation: the once-only flag is what keeps a second unrecorded line out', async () => {
  await assertPinned(async (modules) => {
    const { appended, h } = await scenarioSetup(modules)
    const c = h.startChild()
    h.end(c)
    h.agentDisposed(c)
    h.dispose()
    return appended.length === 1 && appended[0].status === 'unrecorded'
  }, 'verifier.js', 'if (report === undefined || report.recorded || report.finalized) return', 'if (report === undefined || report.recorded) return')
})
