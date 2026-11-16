// Tests for scripts/compare.mjs: ledger merging and pairing, reply selection
// and validation, tallies, topics, pricing, totals, and the Markdown report.
// Everything this file writes lives under TMP. HOME, DSH_HOME, XDG_STATE_HOME
// and ADVISOR_LEDGER point into TMP for this process (a safety net), for every
// env handed to main(), and for spawned children, so nothing reads or writes
// the real ~/.dsh or ~/.local/state.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { renderAdvice, renderPlan, validateAdvice, validatePlan } from '../src/planner.js'
import {
  armOf,
  buildComparison,
  classifyReplyText,
  COLUMNS,
  CompareError,
  defaultLedgerPaths,
  escapeCell,
  escapeText,
  extractReplyObject,
  fencedBlocks,
  isoTime,
  LEDGER_FILE,
  main,
  mergeLedgerLines,
  normalizeTopic,
  parseArgs,
  parseLedger,
  parseLedgers,
  parsePrice,
  parseTallies,
  parseTopics,
  pricedCost,
  readRegularFile,
  recordedCost,
  replyCandidates,
  resolveDshHome,
  resolveLedgers,
  selectReply,
  shownRun,
  stripEnvelope,
  TOPIC_SLUG,
  USAGE,
  validateReply,
} from '../scripts/compare.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/compare.mjs', import.meta.url))
const TMP = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'advisor-compare-test-')))
const SAFETY_NET = Object.freeze({
  HOME: path.join(TMP, 'process-home'),
  DSH_HOME: path.join(TMP, 'process-dsh'),
  XDG_STATE_HOME: path.join(TMP, 'process-xdg'),
  ADVISOR_LEDGER: path.join(TMP, 'process-ledger', 'sessions.jsonl'),
})
const ORIGINAL_ENV = Object.fromEntries(Object.keys(SAFETY_NET).map((key) => [key, process.env[key]]))
Object.assign(process.env, SAFETY_NET)
after(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(TMP, { recursive: true, force: true })
})

const hash = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
/** Environment handed to main(): homes inside TMP, and an override ledger that does not exist. */
const SAFE_ENV = Object.freeze({
  HOME: path.join(TMP, 'main-home'),
  DSH_HOME: path.join(TMP, 'main-dsh'),
  XDG_STATE_HOME: path.join(TMP, 'main-xdg'),
  ADVISOR_LEDGER: path.join(TMP, 'no-default-ledger', 'sessions.jsonl'),
})
/** Environment for spawned children: homes and ledger all inside TMP. */
const childEnv = (extra = {}) => ({
  PATH: process.env.PATH ?? '',
  HOME: path.join(TMP, 'child-home'),
  DSH_HOME: path.join(TMP, 'child-dsh'),
  XDG_STATE_HOME: path.join(TMP, 'child-xdg'),
  ADVISOR_LEDGER: path.join(TMP, 'child-default', 'sessions.jsonl'),
  ...extra,
})
/** Write a ledger file (creating its directory) from line objects or raw strings. */
function writeLedger(file, entries) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${entries.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n')}\n`)
  return file
}
const ledgerHeaders = (stdout) => stdout.split('\n').filter((line) => line.startsWith('- Ledger: ')).map((line) => line.slice('- Ledger: '.length))

function runMain(argv, env = SAFE_ENV) {
  let stdout = ''
  let stderr = ''
  const code = main(argv, {
    stdout: { write: (chunk) => { stdout += chunk } },
    stderr: { write: (chunk) => { stderr += chunk } },
    env,
  })
  return { code, stdout, stderr }
}

let caseCount = 0
/** A fresh directory with a ledger path and a replies/ directory. */
function makeCase(name) {
  const dir = path.join(TMP, `${String(++caseCount).padStart(2, '0')}-${name}`)
  mkdirSync(path.join(dir, 'replies'), { recursive: true })
  const ledger = path.join(dir, 'sessions.jsonl')
  return {
    dir,
    ledger,
    /** Write a reply file; returns the ledger fields that point at it. */
    reply(id, body) {
      const file = path.join(dir, 'replies', `${id}.md`)
      writeFileSync(file, body)
      return { reply_file: file, reply_sha256: hash(body) }
    },
    file(name, body) {
      const file = path.join(dir, name)
      writeFileSync(file, body)
      return file
    },
    write(entries) {
      writeFileSync(ledger, `${entries.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n')}\n`)
    },
    run(...args) {
      return runMain(['--ledger', ledger, ...args])
    },
  }
}

/** Table rows of a report as cell arrays (the header is checked against COLUMNS). */
function rowsOf(stdout) {
  const [header, ...rows] = stdout.split('\n').filter((line) => line.startsWith('| '))
  assert.deepEqual(header.slice(2, -2).split(' | '), [...COLUMNS])
  return rows.map((line) => line.slice(2, -2).split(' | '))
}
const cell = (row, column) => row[COLUMNS.indexOf(column)]
const pick = (row, ...columns) => Object.fromEntries(columns.map((column) => [column, cell(row, column)]))
const totalsOf = (stdout) => stdout.split('\n').filter((line) => /^- (all runs|paired), (plugin|cli): runs /.test(line))
const totalsFor = (stdout, label) => totalsOf(stdout).filter((line) => line.startsWith(`- ${label}, `))
const unpairedOf = (stdout) => stdout.split('\n').find((line) => line.startsWith('- unpaired topics: '))
const notesOf = (stdout) => stdout.slice(stdout.indexOf('## Notes')).split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2))
const oneStderrLine = (stderr) => stderr.endsWith('\n') && stderr.indexOf('\n') === stderr.length - 1
// kind, consult_id, ts, model, runs, then status, then reply .. priced.
const MISSING_CELLS = ['-', '-', '-', '-', '-', 'missing', ...Array(11).fill('-')]

// ---------------------------------------------------------------------------
// Fixtures shaped like real ledger lines (planner.js baseLine/terminalFields
// and consult.py try_advisor).

const PLUGIN_ID = '30f822936a3e'
const CLI_ID = '0e065b9a70a9'
const TS_PLUGIN = '2025-11-16T13:33:20Z' // 1763300000
const TS_CLI_FAILED = '2025-11-16T13:34:10Z' // 1763300050
const TS_CLI = '2025-11-16T13:35:00Z' // 1763300100
const PLUGIN_BASE = Object.freeze({
  kind: 'plan', advisor: 'dsh', caller: 'advisor-plugin', topic: 'unset', session_id: 'lead-session',
  planner_session_id: 'child-session', cwd: '/workspace', briefing_sha256: 'b'.repeat(64), briefing_chars: 1200,
  backend: 'dsh:anthropic/claude-fable-5-2', model: 'claude-fable-5-2', effort: null,
})
const pluginStarted = (fields = {}) => ({ consult_id: PLUGIN_ID, ...PLUGIN_BASE, ts: 1763299800, status: 'started', ...fields })
const pluginLine = (fields = {}) => ({
  consult_id: PLUGIN_ID, ...PLUGIN_BASE, ts: 1763300000, status: 'ok', task_count: 2, submit_attempts: 1, tool_calls: 21,
  duration_s: 161.6, cost_usd: null, input_tokens: 14, output_tokens: 15582, cache_read_tokens: 169290,
  cache_write_tokens: 66149, reasoning_tokens: 0, model_requests: 5, ...fields,
})
const pluginFailed = (fields = {}) => ({
  consult_id: PLUGIN_ID, ...PLUGIN_BASE, ts: 1763300000, status: 'failed', failure_reason: 'tool-call cap (150) reached',
  submit_attempts: 0, tool_calls: 151, duration_s: 30, cost_usd: null, input_tokens: 7, output_tokens: 3,
  cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, model_requests: 1, ...fields,
})
const CLI_BASE = Object.freeze({
  kind: 'plan', briefing_sha256: 'c'.repeat(64), briefing_chars: 1180, briefing_head: 'Goal: compare the advisors',
  ppid: 4242, cwd: '/workspace', caller: 'unset', topic: 'unset',
})
const cliStarted = (fields = {}) => ({ consult_id: CLI_ID, ...CLI_BASE, ts: 1763300000, status: 'started', ...fields })
// consult.py logs a failed or degraded attempt without usage: base, ts, advisor, model, status, duration_s.
const cliFailed = (fields = {}) => ({
  consult_id: CLI_ID, ...CLI_BASE, ts: 1763300050, advisor: 'fable', model: 'claude-fable-5-2', status: 'error_reply', duration_s: 3.2, ...fields,
})
const cliLine = (fields = {}) => ({
  consult_id: CLI_ID, ...CLI_BASE, ts: 1763300100, advisor: 'fable', model: 'claude-fable-5-2', status: 'ok', duration_s: 112.0,
  session_id: 'cli-session', cost_usd: 0.48, input_tokens: 2, output_tokens: 9724, cache_read_tokens: 50000,
  cache_write_tokens: 20000, num_turns: 7, ...fields,
})

const PLAN = {
  summary: 'Add the comparison script, then document it.',
  tasks: [
    {
      id: 'T1', title: 'Write the script', level: 'hard', level_reason: 'Its output decides between backends.',
      write_scopes: ['packages/advisor/scripts/compare.mjs'],
      acceptance: [{ criterion: 'The report prints two rows per topic.', verify: 'node --test packages/advisor/test/compare.test.mjs' }],
      blocked_by: [], open_questions: [],
    },
    {
      id: 'T2', title: 'Document the script', level: 'ordinary', level_reason: 'Prose that must match the script.',
      write_scopes: ['packages/advisor/README.md'],
      acceptance: [{ criterion: 'The README names every flag.', verify: 'Read packages/advisor/README.md' }],
      blocked_by: ['T1'], open_questions: [],
    },
  ],
  open_questions: [],
}
const ADVICE = {
  question: 'Pair the two arms by topic or by briefing hash?',
  recommendation: 'Pair by topic.',
  rationale: 'The two arms hash different briefing text, so hashes never match.',
  options: [
    { name: 'topic', verdict: 'recommended', tradeoffs: 'Needs one topic per briefing.' },
    { name: 'briefing hash', verdict: 'rejected', tradeoffs: 'Never matches across arms.' },
  ],
  risks: ['A reused topic hides an earlier run.'],
  do_not_build: ['A built-in price table.'],
  claims: [{ claim: 'Plugin lines carry a topic.', evidence: ['packages/advisor/src/planner.js:640'] }],
  open_questions: [],
}
const VALID_PLAN = validatePlan(PLAN).plan
const VALID_ADVICE = validateAdvice(ADVICE).advice
assert.ok(VALID_PLAN !== undefined && VALID_ADVICE !== undefined, 'fixtures must be valid')
const fenced = (json, info = 'json') => `I read the workspace first.\n\n\`\`\`${info}\n${json.endsWith('\n') ? json : `${json}\n`}\`\`\`\n\nThat is my answer.\n`
const block = (body, info = 'json') => `\`\`\`${info}\n${body}\n\`\`\`\n`

// ---------------------------------------------------------------------------
// Usage

test('usage: the script imports only node: builtins, ../src/planner.js (validators) and ../src/ledger.js', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  const specifiers = [...source.matchAll(/^\s*(?:import|export)\s[^'"]*?\sfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm)]
    .map((match) => match[1] ?? match[2])
  assert.ok(specifiers.length >= 4)
  for (const specifier of specifiers) {
    assert.ok(specifier.startsWith('node:') || specifier === '../src/planner.js' || specifier === '../src/ledger.js', specifier)
  }
  assert.deepEqual(specifiers.filter((specifier) => !specifier.startsWith('node:')).sort(), ['../src/ledger.js', '../src/planner.js'])
  assert.match(source, /^import \{ validateAdvice, validatePlan \} from '\.\.\/src\/planner\.js'$/m)
  assert.doesNotMatch(source, /\bimport\s*\(/, 'no dynamic import')
  assert.doesNotMatch(source, /\brequire\s*\(/, 'no require')
})

test('usage: importing the script does not run main; running it directly, or through a symlink, does', () => {
  const wrapper = path.join(TMP, 'import-only.mjs')
  writeFileSync(wrapper, `import * as compare from ${JSON.stringify(pathToFileURL(SCRIPT).href)}\nprocess.stdout.write(typeof compare.main)\n`)
  // The child's default ledger does not exist: had main run, it would print an error and exit 1.
  const imported = spawnSync(process.execPath, [wrapper], { env: childEnv(), encoding: 'utf8' })
  assert.deepEqual([imported.status, imported.stdout, imported.stderr], [0, 'function', ''])

  const c = makeCase('direct')
  c.write([pluginLine({ topic: 'alpha' }), cliLine({ topic: 'alpha' })])
  const direct = spawnSync(process.execPath, [SCRIPT, '--ledger', c.ledger], { env: childEnv(), encoding: 'utf8' })
  assert.equal(direct.status, 0, direct.stderr)
  assert.equal(direct.stderr, '')
  assert.equal(rowsOf(direct.stdout).length, 2)

  const viaEnv = spawnSync(process.execPath, [SCRIPT], { env: childEnv({ ADVISOR_LEDGER: c.ledger }), encoding: 'utf8' })
  assert.equal(viaEnv.status, 0, viaEnv.stderr)
  assert.ok(viaEnv.stdout.includes(`- Ledger: ${escapeText(c.ledger)}\n`))

  const link = path.join(TMP, 'compare-link.mjs')
  symlinkSync(SCRIPT, link)
  const linked = spawnSync(process.execPath, [link, '--ledger', c.ledger], { env: childEnv(), encoding: 'utf8' })
  assert.equal(linked.status, 0, linked.stderr)
  assert.equal(linked.stdout, direct.stdout)

  const bad = spawnSync(process.execPath, [SCRIPT, '--nope'], { env: childEnv(), encoding: 'utf8' })
  assert.deepEqual([bad.status, bad.stdout, bad.stderr], [2, '', 'compare: unknown option --nope\n'])
})

test('usage: main(argv, io) returns an exit code and reads the env it is given; --flag=value equals --flag value', () => {
  const c = makeCase('main-io')
  c.write([cliLine({ topic: 'from-advisor-ledger' })])
  const viaLedgerEnv = runMain([], { ...SAFE_ENV, ADVISOR_LEDGER: c.ledger })
  assert.equal(viaLedgerEnv.code, 0)
  assert.deepEqual(ledgerHeaders(viaLedgerEnv.stdout), [escapeText(c.ledger)])
  assert.deepEqual(rowsOf(viaLedgerEnv.stdout).map((row) => cell(row, 'topic')), ['from-advisor-ledger', 'from-advisor-ledger'])
  assert.equal(runMain([`--ledger=${c.ledger}`]).stdout, runMain(['--ledger', c.ledger]).stdout)
})

test('usage: --help prints the usage; unknown flags and bad arguments exit 2 with one stderr line and no report', () => {
  const help = runMain(['--help'])
  assert.equal(help.code, 0)
  assert.ok(help.stdout.startsWith(`${USAGE}\n`))
  assert.match(USAGE, /\[--ledger <file>\]\.\.\. /)
  assert.match(USAGE, /\[--topics <file>\]/)
  assert.match(help.stdout, /USD per\s+million tokens/)
  for (const phrase of [/repeat it to merge several/, /\$ADVISOR_LEDGER alone when set/, /existing defaults it skips are noted/,
    /<DSH_HOME\|~\/\.dsh>\/advisor\/sessions\.jsonl \(plugin ledger\)/, /<XDG_STATE_HOME\|~\/\.local\/state>\/advisor\/sessions\.jsonl/,
    /None found: exit 1/, /a blank DSH_HOME\s+counts as unset, and ~, ~\/ and ~\\ expand against HOME/, /reached by two names \(a symlink\) is read once/,
    /merged in ts order/, /repeated verbatim in a later ledger counts once/, /header\s+lists every ledger read/, /directory of its own ledger/]) {
    assert.match(help.stdout, phrase)
  }
  assert.equal(help.stderr, '')
  assert.equal(runMain(['-h']).stdout, help.stdout)

  const c = makeCase('usage')
  c.write([])
  for (const [argv, message] of [
    [['--bogus'], 'unknown option --bogus'],
    [['--bogus=1'], 'unknown option --bogus'],
    [['-x'], 'unknown option -x'],
    [['stray'], 'unexpected argument "stray"'],
    [['--ledger'], '--ledger needs a value'],
    [['--ledger', '--tallies', 'x'], '--ledger needs a value'],
    [['--ledger='], '--ledger needs a value'],
    [['--tallies'], '--tallies needs a value'],
    [['--topics'], '--topics needs a value'],
    [['--price'], '--price needs a value'],
    [['--ledger', c.ledger, '--ledger'], '--ledger needs a value'],
    [['--ledger', c.ledger, '--tallies', 'a', '--tallies', 'b'], '--tallies given twice'],
    [['--ledger', c.ledger, '--topics', 'a', '--topics', 'b'], '--topics given twice'],
  ]) {
    const result = runMain(argv)
    assert.deepEqual(result, { code: 2, stdout: '', stderr: `compare: ${message}\n` }, argv.join(' '))
  }
  assert.deepEqual(parseArgs([]), { help: false, ledgers: [], tallies: undefined, topics: undefined, prices: new Map() })
  assert.deepEqual(parseArgs(['--ledger', 'a', '--ledger=b', '--ledger', 'a']).ledgers, ['a', 'b', 'a'])
})

// ---------------------------------------------------------------------------
// Ledger reading

test('ledger reading: an unreadable ledger exits 1 with a one-line message; an empty one prints an empty table', () => {
  const missing = runMain(['--ledger', path.join(TMP, 'absent', 'sessions.jsonl')])
  assert.equal(missing.code, 1)
  assert.equal(missing.stdout, '')
  assert.match(missing.stderr, /^compare: cannot read ledger \S+absent\/sessions\.jsonl: ENOENT\n$/)
  const directory = runMain(['--ledger', TMP])
  assert.equal(directory.code, 1)
  assert.match(directory.stderr, /^compare: cannot read ledger .*: EISDIR\n$/)

  const c = makeCase('empty-ledger')
  writeFileSync(c.ledger, '')
  const empty = c.run()
  assert.equal(empty.code, 0)
  assert.deepEqual(rowsOf(empty.stdout), [])
  assert.equal(totalsOf(empty.stdout).length, 4)
  assert.equal(unpairedOf(empty.stdout), '- unpaired topics: plugin 0 (no cli run), cli 0 (no plugin run)')
})

test('ledger reading: torn, non-object and started lines are skipped; missing or unset topics are excluded and counted in one footer line', () => {
  const c = makeCase('ledger-reading')
  const planReply = c.reply(PLUGIN_ID, renderPlan(PLUGIN_ID, VALID_PLAN))
  const cliReply = c.reply(CLI_ID, fenced(JSON.stringify(PLAN, null, 2)))
  c.write([
    pluginStarted(),
    cliStarted({ topic: 'alpha' }),
    '{"consult_id": "deadbeef0000", "kind": "plan", "advisor": "dsh", "status": "ok", "topic": "alp', // torn append
    '[1, 2]',
    'null',
    '42',
    '',
    // A plugin child that failed before its briefing arrived keeps topic unset.
    pluginFailed({ consult_id: 'aaaaaaaaaaa1', failure_reason: 'invalid advisor child start', topic: 'unset' }),
    cliLine({ consult_id: 'bbbbbbbbbbb1', topic: 'unset' }),
    cliLine({ consult_id: 'bbbbbbbbbbb2', topic: '   ' }),
    cliLine({ consult_id: 'bbbbbbbbbbb3', topic: undefined }), // no topic field at all
    `${JSON.stringify(pluginLine({ topic: 'alpha', ...planReply }))}\r`, // CRLF line ending
    cliFailed({ topic: 'alpha' }),
    cliLine({ topic: 'alpha', advisor: 'opus', model: 'claude-opus-5-5', ...cliReply }),
  ])
  const result = c.run()
  assert.equal(result.code, 0)
  const rows = rowsOf(result.stdout)
  assert.deepEqual(rows.map((row) => pick(row, 'topic', 'arm', 'consult_id', 'model', 'runs', 'status', 'reply')), [
    { topic: 'alpha', arm: 'plugin', consult_id: PLUGIN_ID, model: 'claude-fable-5-2', runs: '1', status: 'ok', reply: 'valid plan' },
    { topic: 'alpha', arm: 'cli', consult_id: CLI_ID, model: 'claude-opus-5-5', runs: '2', status: 'ok', reply: 'valid plan' },
  ])
  const notes = notesOf(result.stdout)
  assert.equal(notes.filter((note) => note.startsWith('Excluded ') && note.includes('missing or unset topic')).length, 1)
  assert.ok(notes.includes('Excluded 4 terminal ledger line(s) with a missing or unset topic (plugin 1, cli 3).'))
  assert.ok(notes.includes('Skipped 4 unparseable ledger line(s).'))

  const parsed = parseLedger(readFileSync(c.ledger, 'utf8'))
  assert.deepEqual([parsed.runs.length, parsed.excluded.unset, parsed.unparseable], [3, { plugin: 1, cli: 3 }, 4])
})

test('ledger reading: the plugin arm is advisor dsh; any other advisor, or none, is the cli arm', () => {
  assert.equal(armOf({ advisor: 'dsh' }), 'plugin')
  for (const advisor of ['fable', 'opus', 'DSH', 'dsh ', undefined, null, 7]) assert.equal(armOf({ advisor }), 'cli', String(advisor))
  const c = makeCase('arms')
  c.write([{ consult_id: 'legacy000001', kind: 'plan', status: 'ok', topic: 'no-advisor' }])
  assert.deepEqual(rowsOf(c.run().stdout).map((row) => pick(row, 'arm', 'status')), [
    { arm: 'plugin', status: 'missing' },
    { arm: 'cli', status: 'ok' },
  ])
})

test('ledger reading: per topic and arm the shown run is the last answered terminal line, else the last terminal line', () => {
  const runs = (...statuses) => statuses.map((status, index) => ({ line: { status, n: index } }))
  assert.equal(shownRun(runs('failed', 'ok')).line.n, 1)
  assert.equal(shownRun(runs('ok', 'failed')).line.n, 0)
  assert.equal(shownRun(runs('ok', 'ok', 'timeout')).line.n, 1)
  assert.equal(shownRun(runs('failed', 'error_reply')).line.n, 1)
  assert.equal(shownRun(runs('ok', 'degraded')).line.n, 1)
  assert.equal(shownRun(runs('degraded', 'failed')).line.n, 0)

  const c = makeCase('shown-run')
  c.write([
    // CLI fallback: a failed fable line, then an ok opus line, under one consult_id.
    cliStarted({ topic: 'fallback' }),
    cliFailed({ topic: 'fallback' }),
    cliLine({ topic: 'fallback', advisor: 'opus', model: 'claude-opus-5-5' }),
    pluginLine({ topic: 'ok-then-failed', consult_id: 'p00000000001' }),
    pluginFailed({ topic: 'ok-then-failed', consult_id: 'p00000000002' }),
    pluginFailed({ topic: 'two-failed', consult_id: 'p00000000003', duration_s: 10 }),
    pluginFailed({ topic: 'two-failed', consult_id: 'p00000000004', duration_s: 20 }),
    cliLine({ topic: 'two-ok', consult_id: 'c00000000003' }),
    cliLine({ topic: 'two-ok', consult_id: 'c00000000004' }),
  ])
  const rows = rowsOf(c.run().stdout).filter((row) => cell(row, 'status') !== 'missing')
  assert.deepEqual(rows.map((row) => pick(row, 'topic', 'arm', 'consult_id', 'model', 'runs', 'status', 'duration_s')), [
    { topic: 'fallback', arm: 'cli', consult_id: CLI_ID, model: 'claude-opus-5-5', runs: '2', status: 'ok', duration_s: '112.0' },
    { topic: 'ok-then-failed', arm: 'plugin', consult_id: 'p00000000001', model: 'claude-fable-5-2', runs: '2', status: 'ok', duration_s: '161.6' },
    { topic: 'two-failed', arm: 'plugin', consult_id: 'p00000000004', model: 'claude-fable-5-2', runs: '2', status: 'failed', duration_s: '20.0' },
    { topic: 'two-ok', arm: 'cli', consult_id: 'c00000000004', model: 'claude-fable-5-2', runs: '2', status: 'ok', duration_s: '112.0' },
  ])
})

// ---------------------------------------------------------------------------
// Several ledgers and the default ledgers

test('ledgers: several --ledger files merge in ts order; a relative reply_file resolves against the directory of its own ledger', () => {
  const a = makeCase('merge-a')
  const b = makeCase('merge-b')
  // The same relative name in both ledger directories, with different contents.
  const planBody = renderPlan('p-1', VALID_PLAN)
  const adviceBody = fenced(JSON.stringify(ADVICE))
  a.reply('shared', planBody)
  b.reply('shared', adviceBody)
  a.write([pluginLine({ topic: 'alpha', consult_id: 'p-1', ts: 200, reply_file: 'replies/shared.md', reply_sha256: hash(planBody) })])
  b.write([
    cliLine({ topic: 'beta', consult_id: 'c-0', ts: 50 }),
    cliLine({ topic: 'alpha', consult_id: 'c-1', kind: 'advice', ts: 100, reply_file: 'replies/shared.md', reply_sha256: hash(adviceBody) }),
  ])
  const result = runMain(['--ledger', a.ledger, '--ledger', b.ledger])
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(ledgerHeaders(result.stdout), [escapeText(a.ledger), escapeText(b.ledger)])
  // Topics in time order (beta at ts 50 comes first although its ledger was given second).
  assert.deepEqual(rowsOf(result.stdout).map((row) => [cell(row, 'topic'), cell(row, 'arm'), cell(row, 'consult_id'), cell(row, 'reply')]), [
    ['beta', 'plugin', '-', '-'],
    ['beta', 'cli', 'c-0', 'missing-file'],
    ['alpha', 'plugin', 'p-1', 'valid plan'],
    ['alpha', 'cli', 'c-1', 'valid advice'],
  ])
  assert.ok(notesOf(result.stdout).includes('2 answered run(s) record a relative `reply_file`, resolved against the directory of its ledger; `reply_file` should be absolute.'))
  assert.ok(notesOf(result.stdout).includes('The 2 ledgers are merged in ts order, each keeping its own line order; a line repeated verbatim in a later ledger counts once.'))

  // The last answered run is the latest by ts, whatever the --ledger order.
  const late = makeCase('merge-late')
  const early = makeCase('merge-early')
  late.write([pluginLine({ topic: 'reuse', consult_id: 'p-late', ts: 300 })])
  early.write([pluginLine({ topic: 'reuse', consult_id: 'p-early', ts: 100 })])
  for (const order of [[late, early], [early, late]]) {
    const merged = runMain(order.flatMap((item) => ['--ledger', item.ledger]))
    assert.deepEqual(pick(rowsOf(merged.stdout)[0], 'consult_id', 'runs'), { consult_id: 'p-late', runs: '2' })
    assert.ok(notesOf(merged.stdout).includes('More than one `consult_id` under one topic and arm; only the shown run is paired: reuse plugin ("p-early", "p-late").'))
  }

  // Inside one ledger the line order stands even when ts runs backwards; lines without ts keep their place.
  const lines = (...entries) => entries.map((entry) => JSON.stringify(entry)).join('\n')
  const merged = mergeLedgerLines([
    { file: '/x/one/sessions.jsonl', text: lines({ consult_id: 'one-300', ts: 300 }, { consult_id: 'one-100', ts: 100 }, { consult_id: 'one-none' }) },
    { file: '/x/two/sessions.jsonl', text: lines({ consult_id: 'two-200', ts: 200 }, { consult_id: 'two-300', ts: 300 }) },
  ])
  assert.deepEqual(merged.entries.map(({ line, baseDir }) => [line.consult_id, baseDir]), [
    ['two-200', '/x/two'], ['one-300', '/x/one'], ['one-100', '/x/one'], ['one-none', '/x/one'], ['two-300', '/x/two'],
  ])
  assert.deepEqual(parseLedgers([{ file: a.ledger, text: readFileSync(a.ledger, 'utf8') }]).runs.map((run) => run.baseDir), [a.dir])
})

test('ledgers: a line repeated verbatim (line ending aside) in a later ledger counts once; repeats inside one ledger stay', () => {
  const a = makeCase('dedupe-a')
  const b = makeCase('dedupe-b')
  const shared = cliLine({ topic: 'alpha', consult_id: 'c-1', ts: 100 })
  // Two fast failures of one consult: different advisors, so different text.
  const fast = [
    cliFailed({ topic: 'beta', consult_id: 'c-2', status: 'spawn_error', ts: 100 }),
    cliFailed({ topic: 'beta', consult_id: 'c-2', status: 'spawn_error', ts: 100, advisor: 'opus', model: 'claude-opus-5-5' }),
  ]
  // An exact repeat inside one ledger stays.
  const repeated = cliFailed({ topic: 'gamma', consult_id: 'c-3', status: 'timeout', ts: 100 })
  a.write([pluginLine({ topic: 'alpha', consult_id: 'p-1', ts: 90 }), shared, ...fast, repeated, repeated])
  // b repeats them all (shared with a CRLF ending), plus lines that differ from shared in ts, status,
  // or only in serialization (spacing): none of those is the same text, so they stay.
  b.write([
    `${JSON.stringify(shared)}\r`, ...fast, repeated, repeated,
    cliLine({ topic: 'alpha', consult_id: 'c-1', ts: 101 }),
    cliLine({ topic: 'alpha', consult_id: 'c-1', ts: 100, status: 'degraded' }),
    JSON.stringify(shared, null, 1).replace(/\n/g, ''),
  ])
  const result = runMain(['--ledger', a.ledger, '--ledger', b.ledger])
  assert.equal(result.code, 0, result.stderr)
  const runsOf = (stdout, topic, arm) => cell(rowsOf(stdout).find((row) => cell(row, 'topic') === topic && cell(row, 'arm') === arm), 'runs')
  assert.equal(runsOf(result.stdout, 'alpha', 'cli'), '4')
  assert.equal(runsOf(result.stdout, 'beta', 'cli'), '2')
  assert.equal(runsOf(result.stdout, 'gamma', 'cli'), '2')
  assert.ok(notesOf(result.stdout).includes('Dropped 5 duplicate ledger line(s): the exact same line was already read from an earlier ledger.'))
  assert.match(totalsFor(result.stdout, 'all runs')[1], /^- all runs, cli: runs 8, /)
  assert.equal(mergeLedgerLines([{ file: a.ledger, text: readFileSync(a.ledger, 'utf8') }, { file: b.ledger, text: readFileSync(b.ledger, 'utf8') }]).duplicates, 5)

  // The reviewer's case: a plugin line and a CLI line that share consult_id, status and ts are
  // different lines; neither drops the other.
  const pluginLedger = makeCase('dedupe-plugin')
  const legacyLedger = makeCase('dedupe-legacy')
  const fields = { topic: 'delta', consult_id: 'abcdef012345', status: 'ok', ts: 1763300000 }
  pluginLedger.write([pluginLine(fields)])
  legacyLedger.write([cliLine(fields)])
  const both = runMain(['--ledger', pluginLedger.ledger, '--ledger', legacyLedger.ledger])
  assert.deepEqual(rowsOf(both.stdout).map((row) => [cell(row, 'arm'), cell(row, 'consult_id'), cell(row, 'status')]), [
    ['plugin', 'abcdef012345', 'ok'],
    ['cli', 'abcdef012345', 'ok'],
  ])
  assert.ok(!both.stdout.includes('Dropped '))
  // A torn line copied into a later ledger is a duplicate too, not a second unparseable line.
  const merged = mergeLedgerLines([{ file: '/x/a', text: '{"torn\n' }, { file: '/y/b', text: '{"torn\r\n' }])
  assert.deepEqual([merged.entries.length, merged.unparseable, merged.duplicates], [0, 1, 1])

  // The same file named twice (absolute, then relative to the cwd) is read once.
  const twice = runMain(['--ledger', a.ledger, '--ledger', path.relative(process.cwd(), a.ledger)])
  assert.equal(twice.code, 0, twice.stderr)
  assert.deepEqual(ledgerHeaders(twice.stdout), [escapeText(a.ledger)])
  assert.ok(!twice.stdout.includes('Dropped '))
  assert.equal(runsOf(twice.stdout, 'beta', 'cli'), '2')
})

test('ledgers: without --ledger, every existing default ledger is read: <DSH_HOME|~/.dsh>/advisor, then <XDG_STATE_HOME|~/.local/state>/advisor', () => {
  const root = path.join(TMP, 'defaults')
  const home = path.join(root, 'home')
  const env = { HOME: home, DSH_HOME: path.join(root, 'dsh-home'), XDG_STATE_HOME: path.join(root, 'state-home') }
  const [pluginLedger, legacyLedger] = defaultLedgerPaths(env)
  assert.equal(pluginLedger, path.join(root, 'dsh-home', 'advisor', 'sessions.jsonl'))
  assert.equal(legacyLedger, path.join(root, 'state-home', 'advisor', 'sessions.jsonl'))
  // ~ is HOME; an empty DSH_HOME or XDG_STATE_HOME counts as unset.
  const homeDefaults = [path.join(home, '.dsh', 'advisor', 'sessions.jsonl'), path.join(home, '.local', 'state', 'advisor', 'sessions.jsonl')]
  assert.deepEqual(defaultLedgerPaths({ HOME: home }), homeDefaults)
  assert.deepEqual(defaultLedgerPaths({ HOME: home, DSH_HOME: '', XDG_STATE_HOME: '' }), homeDefaults)

  writeLedger(pluginLedger, [pluginLine({ topic: 'alpha', consult_id: 'p-new', ts: 200 })])
  const pluginOnly = runMain([], env)
  assert.equal(pluginOnly.code, 0, pluginOnly.stderr)
  assert.deepEqual(ledgerHeaders(pluginOnly.stdout), [escapeText(pluginLedger)])
  assert.deepEqual(rowsOf(pluginOnly.stdout).map((row) => cell(row, 'status')), ['ok', 'missing'])

  writeLedger(legacyLedger, [cliLine({ topic: 'alpha', consult_id: 'c-old', ts: 100 })])
  const both = runMain([], env)
  assert.deepEqual(ledgerHeaders(both.stdout), [escapeText(pluginLedger), escapeText(legacyLedger)])
  assert.deepEqual(rowsOf(both.stdout).map((row) => [cell(row, 'arm'), cell(row, 'consult_id')]), [['plugin', 'p-new'], ['cli', 'c-old']])
  // Also when the script runs directly with only these variables.
  const direct = spawnSync(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' })
  assert.equal(direct.status, 0, direct.stderr)
  assert.equal(direct.stdout, both.stdout)

  unlinkSync(pluginLedger)
  const legacyOnly = runMain([], env)
  assert.deepEqual(ledgerHeaders(legacyOnly.stdout), [escapeText(legacyLedger)])

  // HOME-based defaults; a directory where a ledger file should be is not a ledger.
  writeLedger(homeDefaults[1], [cliLine({ topic: 'home', consult_id: 'c-home' })])
  mkdirSync(homeDefaults[0], { recursive: true })
  assert.deepEqual(resolveLedgers([], { HOME: home }), { files: [homeDefaults[1]], aliases: [], skippedDefaults: [] })
  assert.deepEqual(ledgerHeaders(runMain([], { HOME: home }).stdout), [escapeText(homeDefaults[1])])
})

test('ledgers: ADVISOR_LEDGER is a script-only override of the defaults, and --ledger overrides both', () => {
  const root = path.join(TMP, 'override')
  const env = { HOME: path.join(root, 'home'), DSH_HOME: path.join(root, 'dsh'), XDG_STATE_HOME: path.join(root, 'state') }
  for (const file of defaultLedgerPaths(env)) writeLedger(file, [cliLine({ topic: 'default', consult_id: `c-${path.basename(path.dirname(path.dirname(file)))}` })])
  const override = writeLedger(path.join(root, 'override', 'sessions.jsonl'), [cliLine({ topic: 'override', consult_id: 'c-override' })])
  const explicit = writeLedger(path.join(root, 'explicit', 'sessions.jsonl'), [cliLine({ topic: 'explicit', consult_id: 'c-explicit' })])

  const [pluginDefault, legacyDefault] = defaultLedgerPaths(env)
  const viaOverride = runMain([], { ...env, ADVISOR_LEDGER: override })
  assert.deepEqual(ledgerHeaders(viaOverride.stdout), [escapeText(override)])
  assert.deepEqual([...new Set(rowsOf(viaOverride.stdout).map((row) => cell(row, 'topic')))], ['override'])
  assert.deepEqual(resolveLedgers([], { ...env, ADVISOR_LEDGER: override }), { files: [override], aliases: [], skippedDefaults: [pluginDefault, legacyDefault] })
  // The defaults that the override left unread are named in a note.
  assert.ok(notesOf(viaOverride.stdout).includes(
    `\`ADVISOR_LEDGER\` replaces the default ledgers; existing default ledger(s) not read: ${[pluginDefault, legacyDefault].map((file) => escapeText(JSON.stringify(file))).join(', ')}.`,
  ))
  // An override that is itself a default ledger skips only the other one; no defaults, no note.
  assert.deepEqual(resolveLedgers([], { ...env, ADVISOR_LEDGER: legacyDefault }).skippedDefaults, [pluginDefault])
  const lonely = { HOME: path.join(root, 'lonely-home') }
  assert.deepEqual(resolveLedgers([], { ...lonely, ADVISOR_LEDGER: override }).skippedDefaults, [])
  assert.ok(!runMain([], { ...lonely, ADVISOR_LEDGER: override }).stdout.includes('ADVISOR\\_LEDGER'))
  assert.ok(!runMain([], { ...lonely, ADVISOR_LEDGER: override }).stdout.includes('`ADVISOR_LEDGER`'))

  const viaFlag = runMain(['--ledger', explicit], { ...env, ADVISOR_LEDGER: override })
  assert.deepEqual(ledgerHeaders(viaFlag.stdout), [escapeText(explicit)])
  assert.ok(!viaFlag.stdout.includes('`ADVISOR_LEDGER`'))

  // A set but missing override is an error, not a fallback to the defaults.
  const missing = runMain([], { ...env, ADVISOR_LEDGER: path.join(root, 'absent.jsonl') })
  assert.equal(missing.code, 1)
  assert.equal(missing.stdout, '')
  assert.match(missing.stderr, /^compare: cannot read ledger \S+absent\.jsonl: ENOENT\n$/)

  // An empty ADVISOR_LEDGER counts as unset.
  const empty = runMain([], { ...env, ADVISOR_LEDGER: '' })
  assert.deepEqual(ledgerHeaders(empty.stdout), defaultLedgerPaths(env).map(escapeText))
})

test('ledgers: the DSH home mirrors DSH resolveDshHome: blank DSH_HOME is unset, ~ ~/ ~\\ expand against HOME, then path.resolve', () => {
  const home = path.join(TMP, 'dsh-home-rules')
  const dsh = (value) => resolveDshHome(value === undefined ? { HOME: home } : { HOME: home, DSH_HOME: value })
  assert.equal(dsh(undefined), path.join(home, '.dsh'))
  for (const blank of ['', ' ', '\t \n']) assert.equal(dsh(blank), path.join(home, '.dsh'), JSON.stringify(blank))
  assert.equal(dsh('~'), home)
  assert.equal(dsh('~/custom'), path.join(home, 'custom'))
  assert.equal(dsh('~\\custom'), path.join(home, 'custom'))
  // Only ~, ~/ and ~\ expand; anything else resolves against the cwd, as in DSH.
  assert.equal(dsh('~other/x'), path.resolve('~other/x'))
  assert.equal(dsh('relative/dsh'), path.resolve('relative/dsh'))
  assert.equal(dsh('/abs/dsh/../dsh2/'), path.resolve('/abs/dsh2'))
  // As in DSH (dsh-home-paths resolveRoot), a non-blank value is used as given, not trimmed.
  assert.equal(dsh(' /padded '), path.resolve(' /padded '))
  // Without HOME, ~ is os.homedir() (the safety net points it into TMP for this process).
  assert.equal(resolveDshHome({ DSH_HOME: '~/x' }), path.join(os.homedir(), 'x'))
  assert.ok(os.homedir().startsWith(`${TMP}${path.sep}`))

  const custom = path.join(home, 'custom', 'advisor', 'sessions.jsonl')
  assert.equal(defaultLedgerPaths({ HOME: home, DSH_HOME: '~/custom' })[0], custom)
  writeLedger(custom, [pluginLine({ topic: 'tilde', consult_id: 'p-tilde' })])
  const result = runMain([], { HOME: home, DSH_HOME: '~/custom' })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(ledgerHeaders(result.stdout), [escapeText(custom)])
  // A blank DSH_HOME falls back to ~/.dsh instead of resolving to the cwd.
  writeLedger(path.join(home, '.dsh', 'advisor', 'sessions.jsonl'), [pluginLine({ topic: 'blank', consult_id: 'p-blank' })])
  assert.deepEqual(ledgerHeaders(runMain([], { HOME: home, DSH_HOME: '   ' }).stdout), [escapeText(path.join(home, '.dsh', 'advisor', 'sessions.jsonl'))])
})

test('ledgers: a ledger reached by two names (~/.dsh/advisor symlinked to the legacy folder) is read once, by realpath, and noted', () => {
  const root = path.join(TMP, 'symlinked')
  const env = { HOME: path.join(root, 'home') }
  const [pluginLedger, legacyLedger] = defaultLedgerPaths(env)
  writeLedger(legacyLedger, [pluginLine({ topic: 'alpha', consult_id: 'p-1' }), cliLine({ topic: 'alpha', consult_id: 'c-1' })])
  mkdirSync(path.dirname(path.dirname(pluginLedger)), { recursive: true })
  symlinkSync(path.dirname(legacyLedger), path.dirname(pluginLedger)) // ~/.dsh/advisor -> ~/.local/state/advisor
  const result = runMain([], env)
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(ledgerHeaders(result.stdout), [escapeText(pluginLedger)])
  assert.deepEqual(rowsOf(result.stdout).map((row) => cell(row, 'runs')), ['1', '1'])
  assert.ok(notesOf(result.stdout).includes(`Same file as a ledger listed above, so read once: ${escapeText(JSON.stringify(legacyLedger))}.`))
  assert.ok(!result.stdout.includes('Dropped '))
  assert.deepEqual(resolveLedgers([], env), { files: [pluginLedger], aliases: [legacyLedger], skippedDefaults: [] })

  // Explicit names: a file symlink is the same file; a missing file (no realpath) keeps its resolved path.
  const link = path.join(root, 'link.jsonl')
  symlinkSync(legacyLedger, link)
  const missing = path.join(root, 'missing.jsonl')
  assert.deepEqual(resolveLedgers([legacyLedger, link, missing, path.relative(process.cwd(), missing)], env), {
    files: [legacyLedger, missing], aliases: [link], skippedDefaults: [],
  })
  const viaLink = runMain(['--ledger', link, '--ledger', legacyLedger])
  assert.deepEqual(ledgerHeaders(viaLink.stdout), [escapeText(link)])
  assert.ok(notesOf(viaLink.stdout).includes(`Same file as a ledger listed above, so read once: ${escapeText(JSON.stringify(legacyLedger))}.`))
})

test('ledgers: when no default ledger exists, exit 1 with one stderr line naming both paths and no report', () => {
  const home = path.join(TMP, 'empty-home')
  const result = runMain([], { HOME: home })
  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
  assert.ok(oneStderrLine(result.stderr), JSON.stringify(result.stderr))
  const [pluginLedger, legacyLedger] = defaultLedgerPaths({ HOME: home })
  assert.equal(result.stderr, `compare: no ledger found at ${pluginLedger} or ${legacyLedger}; pass --ledger <file>\n`)
  assert.throws(() => resolveLedgers([], { HOME: home }), (error) => error instanceof CompareError && error.exitCode === 1)
  const direct = spawnSync(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH ?? '', HOME: home }, encoding: 'utf8' })
  assert.deepEqual([direct.status, direct.stdout, direct.stderr], [1, '', result.stderr])
})

// ---------------------------------------------------------------------------
// Missing arms and failed runs

test('missing arms: every topic prints exactly two rows, plugin then cli, in first-seen topic order; exit 0', () => {
  const c = makeCase('missing-arms')
  c.write([
    cliLine({ topic: 'cli-only', consult_id: 'c00000000001' }),
    pluginLine({ topic: 'paired', consult_id: 'p00000000002' }),
    pluginLine({ topic: 'plugin-only', consult_id: 'p00000000001' }),
    cliLine({ topic: 'paired', consult_id: 'c00000000002' }),
  ])
  const result = c.run()
  assert.equal(result.code, 0)
  assert.equal(result.stderr, '')
  const rows = rowsOf(result.stdout)
  assert.deepEqual(rows.map((row) => [cell(row, 'topic'), cell(row, 'arm'), cell(row, 'status')]), [
    ['cli-only', 'plugin', 'missing'],
    ['cli-only', 'cli', 'ok'],
    ['paired', 'plugin', 'ok'],
    ['paired', 'cli', 'ok'],
    ['plugin-only', 'plugin', 'ok'],
    ['plugin-only', 'cli', 'missing'],
  ])
  assert.deepEqual(rows[0], ['cli-only', 'plugin', ...MISSING_CELLS])
  assert.deepEqual(rows[5], ['plugin-only', 'cli', ...MISSING_CELLS])
  assert.ok(rows.every((row) => row.length === COLUMNS.length))
})

test('failed runs: real status, reply -, no reply file read, tokens/cost/duration still shown; a both-failed topic keeps two rows', () => {
  const c = makeCase('failed-runs')
  // An existing file whose hash does not match: reading it would show hash-mismatch, not -.
  const decoy = c.reply('decoy', renderPlan('decoy', VALID_PLAN))
  c.write([
    pluginFailed({ topic: 'both-failed', ...decoy }),
    cliFailed({ topic: 'both-failed', reply_file: decoy.reply_file, reply_sha256: 'f'.repeat(64), cost_usd: 0.05, input_tokens: 11, output_tokens: 22, duration_s: 4.2 }),
    cliFailed({ topic: 'no-data', status: 'timeout', duration_s: 1500.0 }),
  ])
  const result = c.run('--price', 'claude-fable-5-2=3,15')
  assert.equal(result.code, 0)
  assert.deepEqual(rowsOf(result.stdout), [
    ['both-failed', 'plugin', 'plan', PLUGIN_ID, TS_PLUGIN, 'claude-fable-5-2', '1', 'failed', '-', '-', '-', '-', '7', '3', '0', '0', '30.0', 'n/a', '0.0001'],
    ['both-failed', 'cli', 'plan', CLI_ID, TS_CLI_FAILED, 'claude-fable-5-2', '1', 'error\\_reply', '-', '-', '-', '-', '11', '22', '-', '-', '4.2', '0.0500', '0.0004'],
    ['no-data', 'plugin', ...MISSING_CELLS],
    ['no-data', 'cli', 'plan', CLI_ID, TS_CLI_FAILED, 'claude-fable-5-2', '1', 'timeout', '-', '-', '-', '-', '-', '-', '-', '-', '1500.0', 'n/a', 'n/a'],
  ])
  assert.ok(notesOf(result.stdout).includes('Unanswered runs by ledger status, all runs: plugin failed 1; cli error\\_reply 1, timeout 1.'))

  const reads = []
  const readFile = (file) => {
    reads.push(file)
    return readFileSync(file)
  }
  const comparison = buildComparison(parseLedger(readFileSync(c.ledger, 'utf8')), { readFile, baseDir: c.dir })
  assert.equal(comparison.rows.length, 4)
  assert.deepEqual(reads, [])
})

test('status: degraded is answered (reply validated, shown over a later failure, answered in totals); other statuses show as recorded', () => {
  const c = makeCase('degraded')
  // consult.py accepts a plain-text reply with exit 0 as degraded and still writes the reply file.
  const plainPlan = c.reply('c-deg', fenced(JSON.stringify(PLAN, null, 2)))
  const prose = c.reply('c-dtf', 'Just prose, no JSON.\n')
  c.write([
    pluginLine({ topic: 'deg', consult_id: 'p-deg' }),
    cliFailed({ topic: 'deg', consult_id: 'c-deg', status: 'degraded', duration_s: 90, ...plainPlan }),
    pluginLine({ topic: 'deg-then-failed', consult_id: 'p-dtf' }),
    cliFailed({ topic: 'deg-then-failed', consult_id: 'c-dtf', status: 'degraded', ...prose }),
    cliFailed({ topic: 'deg-then-failed', consult_id: 'c-dtf', status: 'timeout' }),
    pluginFailed({ topic: 'statuses', consult_id: 'p-none', status: undefined }),
    cliFailed({ topic: 'statuses', consult_id: 'c-spawn', status: 'spawn_error' }),
    cliFailed({ topic: 'no-result', consult_id: 'c-nr', status: 'no_result' }),
  ])
  const result = c.run()
  assert.equal(result.code, 0)
  const cli = (topic) => rowsOf(result.stdout).find((row) => cell(row, 'topic') === topic && cell(row, 'arm') === 'cli')
  assert.deepEqual(pick(cli('deg'), 'status', 'reply', 'runs'), { status: 'degraded', reply: 'valid plan', runs: '1' })
  assert.deepEqual(pick(cli('deg-then-failed'), 'status', 'reply', 'runs'), { status: 'degraded', reply: 'malformed', runs: '2' })
  assert.deepEqual(pick(cli('statuses'), 'status', 'reply'), { status: 'spawn\\_error', reply: '-' })
  assert.deepEqual(pick(cli('no-result'), 'status', 'reply'), { status: 'no\\_result', reply: '-' })
  const plugin = rowsOf(result.stdout).find((row) => cell(row, 'topic') === 'statuses' && cell(row, 'arm') === 'plugin')
  assert.equal(cell(plugin, 'status'), 'unknown')
  const [, allCli] = totalsFor(result.stdout, 'all runs')
  assert.match(allCli, /^- all runs, cli: runs 5, answered 2 \(ok 0, degraded 2\), failed 3, valid replies 1,/)
  const [, pairedCli] = totalsFor(result.stdout, 'paired')
  assert.match(pairedCli, /^- paired, cli: runs 3, answered 2 \(ok 0, degraded 2\), failed 1, valid replies 1,/)
  assert.ok(notesOf(result.stdout).includes('Unanswered runs by ledger status, all runs: plugin (no status) 1; cli timeout 1, spawn\\_error 1, no\\_result 1.'))
})

// ---------------------------------------------------------------------------
// Reply parsing and selection

test('reply parsing: real renderPlan and renderAdvice replies are valid; the same JSON fenced in prose is valid too', () => {
  const c = makeCase('reply-parsing')
  const plan = c.reply('p00000000001', renderPlan('p00000000001', VALID_PLAN))
  const advice = c.reply('p00000000002', renderAdvice('p00000000002', VALID_ADVICE))
  const fencedPlan = c.reply('c00000000001', fenced(JSON.stringify(PLAN, null, 2)))
  // An enveloped advice in the middle fence; the last fence is not JSON, the first is shell.
  const fencedAdvice = c.reply('c00000000002', `Summary first.\n\n\`\`\`bash\nnode --test\n\`\`\`\n\n${fenced(renderAdvice('c00000000002', ADVICE))}\n\`\`\`\nnot json\n\`\`\`\n`)
  const legacyPlan = c.reply('c00000000003', fenced(JSON.stringify(PLAN)))
  c.write([
    pluginLine({ topic: 'plan-topic', consult_id: 'p00000000001', ...plan }),
    cliLine({ topic: 'plan-topic', consult_id: 'c00000000001', ...fencedPlan }),
    pluginLine({ topic: 'advice-topic', consult_id: 'p00000000002', kind: 'advice', ...advice }),
    cliLine({ topic: 'advice-topic', consult_id: 'c00000000002', kind: 'advice', ...fencedAdvice }),
    // A legacy CLI line (kind consult), admitted by --topics: the last object, validated by its shape.
    cliLine({ topic: 'unset', consult_id: 'c00000000003', kind: 'consult', ...legacyPlan }),
  ])
  const topics = c.file('topics.json', JSON.stringify({ c00000000003: 'legacy-topic' }))
  const result = c.run('--topics', topics)
  assert.equal(result.code, 0)
  assert.deepEqual(rowsOf(result.stdout).map((row) => [cell(row, 'kind'), cell(row, 'reply')]), [
    ['plan', 'valid plan'], ['plan', 'valid plan'],
    ['advice', 'valid advice'], ['advice', 'valid advice'],
    ['-', '-'], ['consult', 'valid plan'],
  ])
  const [allPlugin, allCli] = totalsFor(result.stdout, 'all runs')
  assert.match(allPlugin, /, valid replies 2,/)
  assert.match(allCli, /, valid replies 3,/)

  // Each answered reply file is read exactly once, though rows and totals both use it.
  const reads = []
  const readFile = (file) => {
    reads.push(path.basename(file))
    return readFileSync(file)
  }
  const ledger = parseLedger(readFileSync(c.ledger, 'utf8'), { topics: parseTopics(readFileSync(topics, 'utf8')) })
  buildComparison(ledger, { readFile, baseDir: c.dir })
  assert.deepEqual(reads.sort(), ['c00000000001.md', 'c00000000002.md', 'c00000000003.md', 'p00000000001.md', 'p00000000002.md'])
})

test('reply candidates: the whole file if it is a JSON object, else fenced blocks (quoted, indented, listed or nested), else unfenced JSON', () => {
  assert.deepEqual(extractReplyObject('{"a": 1}\n'), { a: 1 })
  assert.equal(extractReplyObject('[{"a": 1}]'), undefined)
  assert.equal(extractReplyObject('"text"'), undefined)
  assert.equal(extractReplyObject('No JSON here.'), undefined)
  const markdown = [
    'Two candidates:', '```json', '{"first": true}', '```',
    '~~~', '{"second": true}', '~~~',
    '```json', '[{"array": true}]', '```',
    '```', 'not json', '```', '',
  ].join('\n')
  assert.deepEqual(extractReplyObject(markdown), { second: true })
  // A longer outer fence keeps an inner fence as content; the inner block is a candidate as well.
  assert.deepEqual(fencedBlocks('````md\n```json\n{}\n```\n````\n'), ['```json\n{}\n```', '{}'])
  assert.deepEqual(extractReplyObject('````markdown\nExample:\n```json\n{"nested": 1}\n```\n````\n'), { nested: 1 })
  // Same-length mis-nesting still yields the inner object.
  assert.deepEqual(extractReplyObject('```markdown\n```json\n{"misnested": 1}\n```\n```\n'), { misnested: 1 })
  // Blockquotes (nested too), list items, a list marker on the fence line, tabs, deep indentation.
  assert.deepEqual(fencedBlocks('> Here:\n> ```json\n> {"q": 1}\n> ```\n'), ['{"q": 1}'])
  assert.deepEqual(fencedBlocks('> > ```json\n> > {"qq": 1}\n> > ```\n'), ['{"qq": 1}'])
  // (Checked on fencedBlocks itself: the unfenced span would otherwise find these one-line objects too.)
  assert.deepEqual(fencedBlocks('1. Plan:\n\n    ```json\n    {"list": 1}\n    ```\n2. Done\n'), ['    {"list": 1}'])
  assert.deepEqual(fencedBlocks('- ```json\n  {"marker": 1}\n  ```\n'), ['  {"marker": 1}'])
  assert.deepEqual(fencedBlocks('\t```json\n\t{"tab": 1}\n\t```\n'), ['\t{"tab": 1}'])
  assert.deepEqual(fencedBlocks('    ```json\n    {"deep": 1}\n    ```\n'), ['    {"deep": 1}'])
  assert.deepEqual(extractReplyObject('1. Plan:\n\n    ```json\n    {"list": 1}\n    ```\n2. Done\n'), { list: 1 })
  // CRLF line endings and an unclosed fence that runs to the end.
  assert.deepEqual(extractReplyObject('Plan:\r\n```json\r\n{"y": 1}\r\n```\r\n'), { y: 1 })
  assert.deepEqual(extractReplyObject('Plan:\n```json\n{"z": 1}\n'), { z: 1 })
  // A backtick line whose info string has a backtick is not a fence.
  assert.deepEqual(fencedBlocks('``` a`b\n{"x": 1}\n```\n'), [''])
  // Unfenced JSON in prose, the last resort: first line starting with { to last line ending with }.
  assert.deepEqual(extractReplyObject('Here it is:\n{\n  "span": 1\n}\nThanks.\n'), { span: 1 })
  assert.deepEqual(extractReplyObject('> {\n>   "quoted": 1\n> }\n'), { quoted: 1 })
  assert.deepEqual(extractReplyObject('Run:\n```bash\nnode --test\n```\nResult:\n{\n  "after": 1\n}\n'), { after: 1 })
  // A fenced object comes first; the span is only a fallback.
  assert.deepEqual(replyCandidates('```json\n{"fenced": 1}\n```\nAlso {"inline": 2}\n'), { objects: [{ fenced: 1 }], span: undefined })
  assert.deepEqual(extractReplyObject('```json\n{"fenced": 1}\n```\n{"span": 2}\n'), { fenced: 1 })
})

test('reply selection: for kind plan or advice the last candidate of that shape is validated as that kind', () => {
  const secondAdvice = { ...ADVICE, recommendation: 'Pair by topic, second answer.' }
  const mixed = `First:\n${block(JSON.stringify(ADVICE))}Then:\n${block(JSON.stringify(PLAN))}And:\n${block(JSON.stringify(secondAdvice))}Example:\n${block('{"example": true}')}`
  assert.deepEqual(selectReply(mixed, 'plan'), { kind: 'plan', value: PLAN })
  assert.deepEqual(selectReply(mixed, 'advice'), { kind: 'advice', value: secondAdvice })
  // A trailing example object no longer hides the answer (it did under the last-object rule).
  assert.equal(classifyReplyText(mixed, 'plan').cell, 'valid plan')
  assert.equal(classifyReplyText(mixed, 'advice').cell, 'valid advice')
  // The last candidate of the shape is validated, even when an earlier one is valid.
  const draftThenBroken = `${block(JSON.stringify(PLAN))}${block(JSON.stringify({ ...PLAN, extra: 1 }))}`
  assert.equal(classifyReplyText(draftThenBroken, 'plan').cell, `invalid plan (${validatePlan({ ...PLAN, extra: 1 }).issues.length})`)
  // The unfenced span counts when no fenced candidate has the shape.
  const spanPlan = `Shell:\n${block('node --test', 'bash')}Plan:\n${JSON.stringify(PLAN, null, 2)}\nDone.\n`
  assert.equal(classifyReplyText(spanPlan, 'plan').cell, 'valid plan')
  const spanBehindObject = `${block('{"note": "not the plan"}')}\nPlan follows.\n${JSON.stringify(PLAN, null, 2)}\n`
  assert.deepEqual(replyCandidates(spanBehindObject).objects, [{ note: 'not the plan' }])
  // Objects of neither shape are validated as the line's kind; no object at all is malformed.
  assert.equal(classifyReplyText(block('{"steps": []}'), 'plan').cell, `invalid plan (${validatePlan({ steps: [] }).issues.length})`)
  assert.equal(classifyReplyText(block('{"answer": "A"}'), 'advice').cell, `invalid advice (${validateAdvice({ answer: 'A' }).issues.length})`)
  assert.equal(classifyReplyText('No JSON.', 'plan').cell, 'malformed')
})

test('reply selection: wrong kind when only the other shape is present; it is not valid and not counted as valid', () => {
  assert.deepEqual(selectReply(block(JSON.stringify(ADVICE)), 'plan'), { wrongKind: true })
  assert.deepEqual(selectReply(renderPlan('x', VALID_PLAN), 'advice'), { wrongKind: true })
  assert.deepEqual(classifyReplyText(fenced(JSON.stringify(ADVICE)), 'plan'), { cell: 'wrong kind', valid: false })
  const c = makeCase('wrong-kind')
  const advice = c.reply('c-plan', fenced(JSON.stringify(ADVICE)))
  const plan = c.reply('c-advice', fenced(JSON.stringify(PLAN)))
  c.write([
    cliLine({ topic: 'asked-plan', consult_id: 'c-plan', kind: 'plan', ...advice }),
    cliLine({ topic: 'asked-advice', consult_id: 'c-advice', kind: 'advice', ...plan }),
  ])
  const result = c.run()
  assert.deepEqual(rowsOf(result.stdout).filter((row) => cell(row, 'arm') === 'cli').map((row) => cell(row, 'reply')), ['wrong kind', 'wrong kind'])
  assert.match(totalsFor(result.stdout, 'all runs')[1], /, answered 2 \(ok 2, degraded 0\), failed 0, valid replies 0,/)
})

test('reply selection: kind consult or unknown keeps the last-object rule, validated by its shape', () => {
  const planThenExample = `${block(JSON.stringify(PLAN))}${block('{"example": true}')}`
  assert.deepEqual(selectReply(planThenExample, 'consult'), { kind: 'advice', value: { example: true } })
  assert.equal(classifyReplyText(planThenExample, 'consult').cell, `invalid advice (${validateAdvice({ example: true }).issues.length})`)
  assert.equal(classifyReplyText(block(JSON.stringify(PLAN)), undefined).cell, 'valid plan')
  assert.equal(classifyReplyText(block(JSON.stringify(ADVICE)), 'smoke').cell, 'valid advice')
  assert.equal(classifyReplyText(block(JSON.stringify(ADVICE)), 'consult').cell, 'valid advice')
})

test('reply parsing: schema, plan_id and advice_id are dropped; validateReply checks the given kind, else the shape', () => {
  assert.deepEqual(stripEnvelope({ schema: 's', plan_id: 'p', advice_id: 'a', summary: 'x' }), { summary: 'x' })
  const plan = validateReply({ schema: 'advisor-plan/1', plan_id: 'x', ...PLAN })
  assert.deepEqual([plan.kind, plan.ok], ['plan', true])
  const advice = validateReply({ schema: 'advisor-advice/1', advice_id: 'x', ...ADVICE })
  assert.deepEqual([advice.kind, advice.ok], ['advice', true])
  assert.deepEqual([validateReply(PLAN, 'advice').kind, validateReply(PLAN, 'advice').ok], ['advice', false])
  // Without a kind, a plan whose tasks is not an array is checked as advice.
  assert.equal(validateReply({ ...PLAN, tasks: {} }).kind, 'advice')
  // Without the envelope the plugin's own reply would fail its strict schema.
  assert.equal(validatePlan(JSON.parse(renderPlan('x', VALID_PLAN))).ok, false)
  assert.equal(classifyReplyText(renderPlan('x', VALID_PLAN), 'plan').cell, 'valid plan')
  assert.equal(classifyReplyText(renderAdvice('x', VALID_ADVICE), 'advice').cell, 'valid advice')
  // An own "__proto__" key stays a plain key: a plan cannot be smuggled in through the prototype.
  const smuggled = `{"__proto__": ${JSON.stringify(PLAN)}}`
  assert.equal(classifyReplyText(smuggled, 'plan').valid, false)
  assert.match(classifyReplyText(smuggled, 'plan').cell, /^invalid plan \(\d+\)$/)
  assert.match(classifyReplyText(smuggled, 'consult').cell, /^invalid advice \(\d+\)$/)
})

test('malformed replies: malformed, invalid plan (n), invalid advice (n), missing-file and hash-mismatch never throw or change the exit code', () => {
  const c = makeCase('malformed')
  const badPlan = { ...PLAN, notes: 'an extra key' }
  const badAdvice = { question: 'Which?', recommendation: 'Option A.' }
  const planIssues = validatePlan(badPlan).issues.length
  const adviceIssues = validateAdvice(badAdvice).issues.length
  assert.ok(planIssues >= 1 && adviceIssues >= 2)
  const lines = []
  const expected = []
  const add = (topic, pluginFields, cliFields, cellText, kind = 'plan') => {
    lines.push(pluginLine({ topic, kind, consult_id: `p-${topic}`, ...pluginFields }), cliLine({ topic, kind, consult_id: `c-${topic}`, ...cliFields }))
    expected.push([topic, cellText], [topic, cellText])
  }
  for (const [topic, body, cellText, kind] of [
    ['prose', 'I would pick option A, for the reasons below.\n', 'malformed'],
    ['broken-fence', 'Plan:\n```json\n{"summary": "x",\n```\n', 'malformed'],
    ['array-json', JSON.stringify([PLAN]), 'malformed'],
    ['fenced-array', fenced('[1, 2, 3]'), 'malformed'],
    ['bad-plan', renderPlan('x', badPlan), `invalid plan (${planIssues})`],
    ['bad-advice', fenced(JSON.stringify(badAdvice)), `invalid advice (${adviceIssues})`, 'advice'],
  ]) {
    add(topic, c.reply(`p-${topic}`, body), c.reply(`c-${topic}`, body), cellText, kind)
  }
  // Deleted reply files.
  const deleted = [c.reply('p-deleted', renderPlan('p', VALID_PLAN)), c.reply('c-deleted', fenced(JSON.stringify(PLAN)))]
  for (const fields of deleted) unlinkSync(fields.reply_file)
  add('deleted', deleted[0], deleted[1], 'missing-file')
  // Edited after the hash was recorded: still a valid plan, but not validated.
  const edited = [c.reply('p-edited', renderPlan('p', VALID_PLAN)), c.reply('c-edited', fenced(JSON.stringify(PLAN)))]
  for (const fields of edited) writeFileSync(fields.reply_file, renderPlan('p', { ...VALID_PLAN, summary: 'Edited later.' }))
  add('edited', edited[0], edited[1], 'hash-mismatch')
  // No recorded hash: the file cannot be matched, so it is not validated either.
  const unhashed = [c.reply('p-unhashed', renderPlan('p', VALID_PLAN)), c.reply('c-unhashed', fenced(JSON.stringify(PLAN)))]
  add('unhashed', { reply_file: unhashed[0].reply_file }, { reply_file: unhashed[1].reply_file }, 'hash-mismatch')
  // An answered line without reply_file, and one whose reply_file is a directory.
  add('no-reply-file', {}, {}, 'missing-file')
  add('directory', { reply_file: c.dir, reply_sha256: 'e'.repeat(64) }, { reply_file: c.dir, reply_sha256: 'e'.repeat(64) }, 'missing-file')
  c.write(lines)

  const result = c.run()
  assert.equal(result.code, 0)
  assert.equal(result.stderr, '')
  const rows = rowsOf(result.stdout)
  assert.deepEqual(rows.map((row) => [cell(row, 'topic'), cell(row, 'reply')]), expected)
  assert.ok(rows.every((row) => cell(row, 'status') === 'ok'))
  for (const line of totalsOf(result.stdout)) assert.match(line, /: runs 11, answered 11 \(ok 11, degraded 0\), failed 0, valid replies 0,/)
})

// ---------------------------------------------------------------------------
// Tallies

test('tallies: entries keyed by consult_id fill confirmed/refuted/unverifiable; rows without an entry show -', () => {
  const c = makeCase('tallies')
  c.write([
    pluginLine({ topic: 'alpha', consult_id: 'p1' }),
    cliLine({ topic: 'alpha', consult_id: 'c1' }),
    pluginLine({ topic: 'beta', consult_id: 'p2' }),
    cliLine({ topic: 'beta', consult_id: 'c2' }),
  ])
  const tallies = c.file('tallies.json', JSON.stringify({
    p1: { confirmed: 4, refuted: 1, unverifiable: 2 },
    c1: { confirmed: 3, refuted: 0, unverifiable: 0, note: 'extra keys are ignored' },
    c2: { confirmed: 0, refuted: 0, unverifiable: 0 },
    'not-listed': { confirmed: 9, refuted: 9, unverifiable: 9 },
  }))
  const result = c.run('--tallies', tallies)
  assert.equal(result.code, 0)
  assert.deepEqual(rowsOf(result.stdout).map((row) => [cell(row, 'consult_id'), cell(row, 'confirmed'), cell(row, 'refuted'), cell(row, 'unverifiable')]), [
    ['p1', '4', '1', '2'],
    ['c1', '3', '0', '0'],
    ['p2', '-', '-', '-'],
    ['c2', '0', '0', '0'],
  ])
  const [plugin, cli] = totalsFor(result.stdout, 'all runs')
  assert.match(plugin, /, confirmed 4, refuted 1, unverifiable 2 \(tallied consult_ids: 1 of 2\),/)
  assert.match(cli, /, confirmed 3, refuted 0, unverifiable 0 \(tallied consult_ids: 2 of 2\),/)
  assert.ok(result.stdout.includes(`- Tallies: ${escapeText(tallies)}\n`))
  assert.ok(notesOf(result.stdout).includes('Tallies for `consult_id`(s) with no listed run (ignored): "not-listed".'))
  assert.deepEqual(parseTallies('{"x": {"confirmed": 1, "refuted": 2, "unverifiable": 3}}'), new Map([['x', { confirmed: 1, refuted: 2, unverifiable: 3 }]]))
})

test('bad tallies file: exits 1 with one stderr line naming the consult_id and prints no table', () => {
  const c = makeCase('bad-tallies')
  c.write([cliLine({ topic: 'alpha', consult_id: 'c1' })])
  const valid = '"ok1": {"confirmed": 1, "refuted": 0, "unverifiable": 0}'
  for (const [name, body, pattern] of [
    ['absent', null, /^compare: cannot read tallies \S+absent\.json: ENOENT$/],
    ['not-json', '{"c1": ', /^compare: tallies \S+not-json\.json: not valid JSON \(.+\)$/],
    ['array', '[]', /^compare: tallies \S+: expected a JSON object keyed by consult_id$/],
    ['null', 'null', /^compare: tallies \S+: expected a JSON object keyed by consult_id$/],
    ['entry-number', '{"c1": 3}', /: consult_id "c1": expected an object with confirmed, refuted and unverifiable$/],
    ['entry-array', '{"c1": [1, 0, 0]}', /: consult_id "c1": expected an object/],
    ['negative', '{"c1": {"confirmed": -1, "refuted": 0, "unverifiable": 0}}', /: consult_id "c1": confirmed must be a non-negative integer$/],
    ['fraction', `{${valid}, "c2": {"confirmed": 1, "refuted": 1.5, "unverifiable": 0}}`, /: consult_id "c2": refuted must be a non-negative integer$/],
    ['string', '{"c3": {"confirmed": 1, "refuted": 0, "unverifiable": "2"}}', /: consult_id "c3": unverifiable must be a non-negative integer$/],
    ['missing-field', '{"c4": {"confirmed": 1, "refuted": 0}}', /: consult_id "c4": unverifiable must be a non-negative integer$/],
    ['newline-id', '{"a\\nb": {"confirmed": true, "refuted": 0, "unverifiable": 0}}', /: consult_id "a\\nb": confirmed must be a non-negative integer$/],
  ]) {
    const file = body === null ? path.join(c.dir, `${name}.json`) : c.file(`${name}.json`, body)
    const result = c.run('--tallies', file)
    assert.equal(result.code, 1, name)
    assert.equal(result.stdout, '', name)
    assert.ok(oneStderrLine(result.stderr), `${name}: ${JSON.stringify(result.stderr)}`)
    assert.match(result.stderr.trimEnd(), pattern, name)
  }
  assert.throws(() => parseTallies('{"c9": {"confirmed": 0, "refuted": 0, "unverifiable": -2}}'), (error) => error instanceof CompareError && /"c9"/.test(error.message))
})

// ---------------------------------------------------------------------------
// Pairing, kinds, topics

test('pairing: only kind plan or advice lines pair; other kinds are excluded and counted; kind and ts columns; a note for several consult_ids per topic and arm', () => {
  assert.equal(isoTime(1763300000), TS_PLUGIN)
  assert.equal(isoTime(0), '1970-01-01T00:00:00Z')
  assert.equal(isoTime(1.5), '1970-01-01T00:00:01.500Z')
  for (const bad of ['1763300000', null, undefined, 1e20, Number.NaN]) assert.equal(isoTime(bad), '-', String(bad))

  const c = makeCase('pairing-kinds')
  c.write([
    cliLine({ topic: 'alpha', consult_id: 'c-consult', kind: 'consult' }),
    cliLine({ topic: 'alpha', consult_id: 'c-smoke', kind: 'smoke' }),
    { ts: 1759000000, advisor: 'opus', model: 'claude-opus-5-5', cost_usd: 0.1, topic: 'alpha' }, // legacy usage line: no kind
    pluginLine({ topic: 'alpha', consult_id: 'p-alpha', kind: 'advice' }),
    cliLine({ topic: 'alpha', consult_id: 'c-alpha', kind: 'advice' }),
    pluginLine({ topic: 'beta', consult_id: 'p-beta-1' }),
    pluginLine({ topic: 'beta', consult_id: 'p-beta-2', ts: 1763300500 }),
    cliLine({ topic: 'beta', consult_id: 'c-beta' }),
  ])
  const result = c.run()
  assert.equal(result.code, 0)
  assert.deepEqual(rowsOf(result.stdout).map((row) => pick(row, 'topic', 'arm', 'kind', 'consult_id', 'ts', 'runs')), [
    { topic: 'alpha', arm: 'plugin', kind: 'advice', consult_id: 'p-alpha', ts: TS_PLUGIN, runs: '1' },
    { topic: 'alpha', arm: 'cli', kind: 'advice', consult_id: 'c-alpha', ts: TS_CLI, runs: '1' },
    { topic: 'beta', arm: 'plugin', kind: 'plan', consult_id: 'p-beta-2', ts: '2025-11-16T13:41:40Z', runs: '2' },
    { topic: 'beta', arm: 'cli', kind: 'plan', consult_id: 'c-beta', ts: TS_CLI, runs: '1' },
  ])
  const notes = notesOf(result.stdout)
  assert.ok(notes.includes('Excluded 3 terminal ledger line(s) of a kind other than plan or advice that `--topics` does not name (plugin 0, cli 3): consult 1, smoke 1, (no kind) 1.'))
  assert.ok(notes.includes('More than one `consult_id` under one topic and arm; only the shown run is paired: beta plugin ("p-beta-1", "p-beta-2").'))
  assert.deepEqual(parseLedger(readFileSync(c.ledger, 'utf8')).excluded.kind, { plugin: 0, cli: 3 })
})

test('topics: trimmed and checked against the briefingTopic slug rule; failures are excluded with a warning', () => {
  assert.equal(TOPIC_SLUG.source, '^[a-z0-9][a-z0-9-]{0,39}$')
  // The same slug as briefingTopic in src/planner.js (checked in its source; the script does not import it).
  assert.ok(readFileSync(new URL('../src/planner.js', import.meta.url), 'utf8').includes('([a-z0-9][a-z0-9-]{0,39})'))
  for (const [value, expected] of [
    [' alpha ', 'alpha'], ['a1-b2', 'a1-b2'], ['9lives', '9lives'], ['a'.repeat(40), 'a'.repeat(40)],
    ['Alpha', undefined], ['a_b', undefined], ['-x', undefined], ['a'.repeat(41), undefined],
    ['a b', undefined], ['é', undefined], ['', undefined], [7, undefined],
  ]) {
    assert.equal(normalizeTopic(value), expected, JSON.stringify(value))
  }
  const c = makeCase('topic-slugs')
  c.write([
    pluginLine({ topic: ' padded ', consult_id: 'p-pad' }),
    cliLine({ topic: 'padded', consult_id: 'c-pad' }),
    pluginLine({ topic: 'Bad_Topic', consult_id: 'p-bad' }),
    cliLine({ topic: 'x'.repeat(41), consult_id: 'c-long' }),
    cliLine({ topic: 'evil\u202etopic', consult_id: 'c-evil' }),
  ])
  const result = c.run()
  assert.deepEqual(rowsOf(result.stdout).map((row) => [cell(row, 'topic'), cell(row, 'arm'), cell(row, 'consult_id')]), [
    ['padded', 'plugin', 'p-pad'],
    ['padded', 'cli', 'c-pad'],
  ])
  assert.ok(notesOf(result.stdout).includes(
    `Warning: excluded 3 terminal ledger line(s) whose topic does not match \`^[a-z0-9][a-z0-9-]{0,39}$\` after trimming (plugin 1, cli 2): "Bad\\_Topic", "${'x'.repeat(41)}", "evil\\u202etopic".`,
  ))
  assert.ok(!result.stdout.includes('\u202e'))
})

test('--topics: maps consult_ids to topic slugs, supplying or overriding the ledger topic and admitting any kind', () => {
  const c = makeCase('topics-map')
  c.write([
    // The running host recorded this plugin line before the topic change was loaded.
    pluginLine({ consult_id: 'p-old-host', topic: 'unset' }),
    // A legacy CLI consult line whose ADVISOR_TOPIC was not set.
    cliLine({ consult_id: 'c-legacy', kind: 'consult', topic: 'unset' }),
    // Overridden: the ledger says old-topic, --topics says renamed.
    pluginLine({ consult_id: 'p-renamed', topic: 'old-topic' }),
    cliLine({ consult_id: 'c-renamed', topic: 'renamed' }),
    // Mapped to unset: left out.
    cliLine({ consult_id: 'c-dropped', topic: 'dropped' }),
  ])
  const topics = c.file('topics.json', JSON.stringify({
    'p-old-host': 'smoke-plan', 'c-legacy': ' smoke-plan ', 'p-renamed': 'renamed', 'c-dropped': 'unset', 'c-absent': 'nowhere',
  }))
  const result = c.run('--topics', topics)
  assert.equal(result.code, 0)
  assert.deepEqual(rowsOf(result.stdout).map((row) => [cell(row, 'topic'), cell(row, 'arm'), cell(row, 'kind'), cell(row, 'consult_id')]), [
    ['smoke-plan', 'plugin', 'plan', 'p-old-host'],
    ['smoke-plan', 'cli', 'consult', 'c-legacy'],
    ['renamed', 'plugin', 'plan', 'p-renamed'],
    ['renamed', 'cli', 'plan', 'c-renamed'],
  ])
  assert.ok(result.stdout.includes(`- Topics: ${escapeText(topics)}\n`))
  const notes = notesOf(result.stdout)
  assert.ok(notes.includes('Excluded 1 terminal ledger line(s) with a missing or unset topic (plugin 0, cli 1).'))
  assert.ok(notes.includes('`--topics` supplied the topic of 2 line(s) without a valid ledger topic and overrode a different ledger topic on 2 line(s).'))
  assert.ok(notes.includes('`--topics` entries with no terminal ledger line (ignored): "c-absent".'))
  assert.equal(parseTopics('{"x": " a-b "}').get('x'), 'a-b')
})

test('bad topics file: exits 1 with one stderr line naming the consult_id and prints no table', () => {
  const c = makeCase('bad-topics')
  c.write([cliLine({ topic: 'alpha', consult_id: 'c1' })])
  const rule = '^[a-z0-9][a-z0-9-]{0,39}$'.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const [name, body, pattern] of [
    ['absent', null, /^compare: cannot read topics \S+absent\.json: ENOENT$/],
    ['not-json', '{"c1": ', /^compare: topics \S+not-json\.json: not valid JSON \(.+\)$/],
    ['array', '["alpha"]', /^compare: topics \S+: expected a JSON object keyed by consult_id$/],
    ['number', '{"c1": 3}', new RegExp(`: consult_id "c1": topic must be a string matching ${rule}$`)],
    ['bad-slug', '{"ok": "alpha", "c2": "Bad Topic"}', /: consult_id "c2": topic must be a string matching /],
    ['empty', '{"c3": ""}', /: consult_id "c3": topic must be a string matching /],
    ['too-long', `{"c4": "${'a'.repeat(41)}"}`, /: consult_id "c4": topic must be a string matching /],
    ['newline-id', '{"a\\nb": null}', /: consult_id "a\\nb": topic must be a string matching /],
  ]) {
    const file = body === null ? path.join(c.dir, `${name}.json`) : c.file(`${name}.json`, body)
    const result = c.run('--topics', file)
    assert.equal(result.code, 1, name)
    assert.equal(result.stdout, '', name)
    assert.ok(oneStderrLine(result.stderr), `${name}: ${JSON.stringify(result.stderr)}`)
    assert.match(result.stderr.trimEnd(), pattern, name)
  }
})

// ---------------------------------------------------------------------------
// Cost

test('pricing: --price is <model>=<in>,<out>[,<cacheRead>,<cacheWrite>] with non-negative decimal rates', () => {
  assert.deepEqual(parsePrice('claude-fable-5-2=3,15'), { model: 'claude-fable-5-2', input: 3, output: 15, cacheRead: null, cacheWrite: null })
  assert.deepEqual(parsePrice('claude-fable-5-2=3,15,0.3,3.75'), { model: 'claude-fable-5-2', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })
  assert.deepEqual(parsePrice('vendor/model:v1=.5,2.,0,0'), { model: 'vendor/model:v1', input: 0.5, output: 2, cacheRead: 0, cacheWrite: 0 })
  assert.equal(parsePrice('odd=name=1,2').model, 'odd=name')
  for (const bad of [
    'claude', '=3,15', 'm=', 'm=3', 'm=3,15,0.3', 'm=3,15,0.3,3.75,1', 'm=-1,2', 'm=1e3,2', 'm=abc,2',
    'm= 3,15', ' m=3,15', 'm=3,,', 'm=3,15,,', 'm=Infinity,1', 'm=0x10,1', `m=${'9'.repeat(400)},1`,
  ]) {
    assert.throws(() => parsePrice(bad), (error) => error instanceof CompareError && error.exitCode === 2 && /^malformed --price /.test(error.message), bad)
  }
})

test('pricing: recorded is the numeric cost_usd; priced is disjoint tokens x price, n/a when a needed token field is null or absent', () => {
  const prices = new Map([
    ['claude-fable-5-2', parsePrice('claude-fable-5-2=3,15,0.3,3.75')],
    ['claude-opus-5-5', parsePrice('claude-opus-5-5=5,25')],
  ])
  const plugin = pluginLine()
  assert.equal(pricedCost(plugin, prices), (14 * 3 + 15582 * 15 + 169290 * 0.3 + 66149 * 3.75) / 1e6)
  assert.ok(Math.abs(pricedCost(plugin, prices) - 0.53261775) < 1e-12)
  // Without cache rates, cache fields count as 0 whether present or not.
  const opus = cliLine({ model: 'claude-opus-5-5' })
  assert.equal(pricedCost(opus, prices), (2 * 5 + 9724 * 25) / 1e6)
  assert.equal(pricedCost({ ...opus, cache_read_tokens: undefined, cache_write_tokens: null }, prices), (2 * 5 + 9724 * 25) / 1e6)
  // With cache rates, a null or absent cache field makes the cell n/a.
  assert.equal(pricedCost({ ...plugin, cache_write_tokens: undefined }, prices), undefined)
  assert.equal(pricedCost({ ...plugin, cache_read_tokens: null }, prices), undefined)
  // Null or absent input/output tokens, an unpriced model, or no model are n/a.
  assert.equal(pricedCost({ ...plugin, input_tokens: null }, prices), undefined)
  assert.equal(pricedCost({ ...plugin, output_tokens: undefined }, prices), undefined)
  assert.equal(pricedCost({ ...plugin, input_tokens: '14' }, prices), undefined)
  assert.equal(pricedCost({ ...plugin, model: 'claude-unpriced' }, prices), undefined)
  assert.equal(pricedCost({ ...plugin, model: null }, prices), undefined)
  // Zero cache rates still need the cache fields.
  assert.equal(pricedCost({ ...plugin, cache_read_tokens: undefined }, new Map([['claude-fable-5-2', parsePrice('claude-fable-5-2=3,15,0,0')]])), undefined)
  assert.equal(recordedCost(cliLine()), 0.48)
  assert.equal(recordedCost(plugin), undefined)
  assert.equal(recordedCost({ cost_usd: '0.48' }), undefined)
  assert.equal(recordedCost({}), undefined)
})

test('pricing: the report shows recorded and priced columns to 4 decimals and notes unpriced cache tokens and unused prices', () => {
  const c = makeCase('pricing')
  c.write([
    pluginLine({ topic: 'alpha', consult_id: 'p1' }),
    cliLine({ topic: 'alpha', consult_id: 'c1', advisor: 'opus', model: 'claude-opus-5-5' }),
    pluginLine({ topic: 'beta', consult_id: 'p2', input_tokens: null }),
    cliLine({ topic: 'beta', consult_id: 'c2', model: 'claude-unpriced' }),
    cliLine({ topic: 'gamma', consult_id: 'c3', cache_read_tokens: undefined, cost_usd: 0.123456 }),
  ])
  const result = c.run('--price', 'claude-fable-5-2=3,15,0.3,3.75', '--price=claude-opus-5-5=5,25', '--price', 'claude-never-used=1,1')
  assert.equal(result.code, 0)
  assert.deepEqual(rowsOf(result.stdout).map((row) => [cell(row, 'consult_id'), cell(row, 'recorded'), cell(row, 'priced')]), [
    ['p1', 'n/a', '0.5326'],
    ['c1', '0.4800', '0.2431'],
    ['p2', 'n/a', 'n/a'],
    ['c2', '0.4800', 'n/a'],
    ['-', '-', '-'],
    ['c3', '0.1235', 'n/a'],
  ])
  assert.ok(result.stdout.includes('- Prices (USD per million tokens): claude-fable-5-2 in 3, out 15, cache read 0.3, cache write 3.75; claude-opus-5-5 in 5, out 25 (no cache rates); claude-never-used in 1, out 1 (no cache rates)\n'))
  const notes = notesOf(result.stdout)
  assert.ok(notes.includes('1 listed run(s) carry cache tokens but were priced without cache rates; their priced cost leaves cache tokens out.'))
  assert.ok(notes.includes('`--price` given for model(s) with no listed run: "claude-never-used".'))
})

test('pricing: a malformed --price, a duplicate model or an unknown flag exits 2 with a stderr message and no report', () => {
  const c = makeCase('bad-price')
  c.write([cliLine({ topic: 'alpha' })])
  for (const [args, pattern] of [
    [['--price', 'claude-fable-5-2=3'], /^compare: malformed --price "claude-fable-5-2=3": expected <model>=<in>,<out>\[,<cacheRead>,<cacheWrite>\] in USD per million tokens$/],
    [['--price', 'claude-fable-5-2=3,15,1'], /^compare: malformed --price /],
    [['--price', 'claude-fable-5-2=-3,15'], /^compare: malformed --price /],
    [['--price', '=3,15'], /^compare: malformed --price /],
    [['--price', 'm=1,2', '--price', 'm=3,4'], /^compare: --price given twice for model "m"$/],
    [['--cost', '1'], /^compare: unknown option --cost$/],
  ]) {
    const result = c.run(...args)
    assert.equal(result.code, 2, args.join(' '))
    assert.equal(result.stdout, '')
    assert.ok(oneStderrLine(result.stderr))
    assert.match(result.stderr.trimEnd(), pattern)
  }
})

// ---------------------------------------------------------------------------
// Totals

test('totals: all runs covers every terminal line of the listed topics; n/a runs stated, never counted as zero', () => {
  const c = makeCase('totals')
  const pluginPlan = c.reply('p-alpha', renderPlan('p-alpha', VALID_PLAN))
  const cliPlan = c.reply('c-alpha', fenced(JSON.stringify(PLAN, null, 2)))
  const cliAdvice = c.reply('c-beta', fenced(JSON.stringify(ADVICE)))
  c.write([
    '{"consult_id": "torn', // skipped
    pluginFailed({ consult_id: 'p-unset', topic: 'unset' }), // excluded
    cliLine({ consult_id: 'c-unset', topic: 'unset' }), // excluded
    pluginStarted({ consult_id: 'p-alpha' }),
    pluginLine({ consult_id: 'p-alpha', topic: 'alpha', ...pluginPlan }),
    cliStarted({ consult_id: 'c-alpha', topic: 'alpha' }),
    // Fallback pair under one consult_id: a failed fable attempt, then opus (unpriced).
    cliFailed({ consult_id: 'c-alpha', topic: 'alpha' }),
    cliLine({ consult_id: 'c-alpha', topic: 'alpha', advisor: 'opus', model: 'claude-opus-5-5', ...cliPlan }),
    pluginFailed({ consult_id: 'p-beta', topic: 'beta' }),
    cliLine({ consult_id: 'c-beta', topic: 'beta', kind: 'advice', input_tokens: 5, output_tokens: 100, cache_read_tokens: 1000, cache_write_tokens: 0, cost_usd: 0.1, duration_s: 50.5, ...cliAdvice }),
    // A CLI-only topic: counted in all runs, not in paired.
    cliLine({ consult_id: 'c-gamma', topic: 'gamma', cost_usd: 0.2 }),
  ])
  const tallies = c.file('tallies.json', JSON.stringify({
    'p-alpha': { confirmed: 3, refuted: 1, unverifiable: 0 },
    'c-alpha': { confirmed: 2, refuted: 0, unverifiable: 1 },
    'c-beta': { confirmed: 1, refuted: 1, unverifiable: 1 },
  }))
  const result = c.run('--tallies', tallies, '--price', 'claude-fable-5-2=3,15,0.3,3.75')
  assert.equal(result.code, 0)
  assert.deepEqual(rowsOf(result.stdout), [
    ['alpha', 'plugin', 'plan', 'p-alpha', TS_PLUGIN, 'claude-fable-5-2', '1', 'ok', 'valid plan', '3', '1', '0', '14', '15582', '169290', '66149', '161.6', 'n/a', '0.5326'],
    ['alpha', 'cli', 'plan', 'c-alpha', TS_CLI, 'claude-opus-5-5', '2', 'ok', 'valid plan', '2', '0', '1', '2', '9724', '50000', '20000', '112.0', '0.4800', 'n/a'],
    ['beta', 'plugin', 'plan', 'p-beta', TS_PLUGIN, 'claude-fable-5-2', '1', 'failed', '-', '-', '-', '-', '7', '3', '0', '0', '30.0', 'n/a', '0.0001'],
    ['beta', 'cli', 'advice', 'c-beta', TS_CLI, 'claude-fable-5-2', '1', 'ok', 'valid advice', '1', '1', '1', '5', '100', '1000', '0', '50.5', '0.1000', '0.0018'],
    ['gamma', 'plugin', ...MISSING_CELLS],
    ['gamma', 'cli', 'plan', 'c-gamma', TS_CLI, 'claude-fable-5-2', '1', 'ok', 'missing-file', '-', '-', '-', '2', '9724', '50000', '20000', '112.0', '0.2000', '0.2359'],
  ])
  assert.deepEqual(totalsFor(result.stdout, 'all runs'), [
    '- all runs, plugin: runs 2, answered 1 (ok 1, degraded 0), failed 1, valid replies 1, confirmed 3, refuted 1, unverifiable 0 (tallied consult_ids: 1 of 2), '
      + 'input 21, output 15585, cache read 169290, cache write 66149, duration_s 191.6, recorded n/a (n/a runs: 2), priced 0.5327 (n/a runs: 0)',
    '- all runs, cli: runs 4, answered 3 (ok 3, degraded 0), failed 1, valid replies 2, confirmed 3, refuted 1, unverifiable 2 (tallied consult_ids: 2 of 3), '
      + 'input 9 (n/a runs: 1), output 19548 (n/a runs: 1), cache read 101000 (n/a runs: 1), cache write 40000 (n/a runs: 1), '
      + 'duration_s 277.7, recorded 0.7800 (n/a runs: 1), priced 0.2377 (n/a runs: 2)',
  ])
  assert.deepEqual(totalsFor(result.stdout, 'paired'), [
    '- paired, plugin: runs 2, answered 1 (ok 1, degraded 0), failed 1, valid replies 1, confirmed 3, refuted 1, unverifiable 0 (tallied consult_ids: 1 of 2), '
      + 'input 21, output 15585, cache read 169290, cache write 66149, duration_s 191.6, recorded n/a (n/a runs: 2), priced 0.5327 (n/a runs: 0)',
    '- paired, cli: runs 2, answered 2 (ok 2, degraded 0), failed 0, valid replies 2, confirmed 3, refuted 1, unverifiable 2 (tallied consult_ids: 2 of 2), '
      + 'input 7, output 9824, cache read 51000, cache write 20000, duration_s 162.5, recorded 0.5800 (n/a runs: 0), priced 0.0018 (n/a runs: 1)',
  ])
  assert.equal(unpairedOf(result.stdout), '- unpaired topics: plugin 0 (no cli run), cli 1 (no plugin run)')
  const notes = notesOf(result.stdout)
  assert.ok(notes.includes('Excluded 2 terminal ledger line(s) with a missing or unset topic (plugin 1, cli 1).'))
  assert.ok(notes.includes('Skipped 1 unparseable ledger line(s).'))
  assert.ok(notes.includes('Unanswered runs by ledger status, all runs: plugin failed 1; cli error\\_reply 1.'))
  assert.ok(notes.includes('all runs totals cover every terminal line of the listed topics, including failed and superseded runs, with tallies counted once per `consult_id`; paired totals cover only topics where both arms have a shown run, and only those shown runs.'))
})

test('totals: paired covers only topics where both arms have a shown run, over shown runs and their consult_ids; unpaired topics per arm', () => {
  const c = makeCase('paired')
  const p1 = c.reply('p1', renderPlan('p1', VALID_PLAN))
  const c1 = c.reply('c1', fenced(JSON.stringify(PLAN)))
  const p4a = c.reply('p4a', renderPlan('p4a', VALID_PLAN))
  const p4b = c.reply('p4b', renderPlan('p4b', VALID_PLAN))
  c.write([
    pluginLine({ topic: 't1', consult_id: 'p1', ...p1 }),
    cliLine({ topic: 't1', consult_id: 'c1', ...c1 }),
    pluginLine({ topic: 't2', consult_id: 'p2' }), // plugin only
    cliLine({ topic: 't3', consult_id: 'c3' }), // cli only
    // A reused topic: the earlier plugin run is superseded; only p4b is paired.
    pluginLine({ topic: 't4', consult_id: 'p4a', ...p4a }),
    pluginLine({ topic: 't4', consult_id: 'p4b', ...p4b }),
    cliFailed({ topic: 't4', consult_id: 'c4' }),
  ])
  const tallies = c.file('tallies.json', JSON.stringify({
    p1: { confirmed: 1, refuted: 0, unverifiable: 0 },
    c1: { confirmed: 2, refuted: 0, unverifiable: 0 },
    p4a: { confirmed: 5, refuted: 5, unverifiable: 5 },
    p4b: { confirmed: 1, refuted: 1, unverifiable: 1 },
  }))
  const result = c.run('--tallies', tallies)
  const [allPlugin, allCli] = totalsFor(result.stdout, 'all runs')
  assert.match(allPlugin, /^- all runs, plugin: runs 4, answered 4 \(ok 4, degraded 0\), failed 0, valid replies 3, confirmed 7, refuted 6, unverifiable 6 \(tallied consult_ids: 3 of 4\),/)
  assert.match(allCli, /^- all runs, cli: runs 3, answered 2 \(ok 2, degraded 0\), failed 1, valid replies 1, confirmed 2, refuted 0, unverifiable 0 \(tallied consult_ids: 1 of 3\),/)
  assert.deepEqual(totalsFor(result.stdout, 'paired'), [
    '- paired, plugin: runs 2, answered 2 (ok 2, degraded 0), failed 0, valid replies 2, confirmed 2, refuted 1, unverifiable 1 (tallied consult_ids: 2 of 2), '
      + 'input 28, output 31164, cache read 338580, cache write 132298, duration_s 323.2, recorded n/a (n/a runs: 2), priced n/a (n/a runs: 2)',
    '- paired, cli: runs 2, answered 1 (ok 1, degraded 0), failed 1, valid replies 1, confirmed 2, refuted 0, unverifiable 0 (tallied consult_ids: 1 of 2), '
      + 'input 2 (n/a runs: 1), output 9724 (n/a runs: 1), cache read 50000 (n/a runs: 1), cache write 20000 (n/a runs: 1), duration_s 115.2, recorded 0.4800 (n/a runs: 1), priced n/a (n/a runs: 2)',
  ])
  assert.equal(unpairedOf(result.stdout), '- unpaired topics: plugin 1 (no cli run), cli 1 (no plugin run)')
  assert.ok(notesOf(result.stdout).includes('More than one `consult_id` under one topic and arm; only the shown run is paired: t4 plugin ("p4a", "p4b").'))
})

test('totals: an arm whose runs all lack a value sums to n/a, and an arm with no runs sums to zero', () => {
  const c = makeCase('totals-empty-arm')
  c.write([cliFailed({ topic: 'only-cli' })])
  const result = c.run()
  const [plugin, cli] = totalsFor(result.stdout, 'all runs')
  assert.equal(plugin, '- all runs, plugin: runs 0, answered 0 (ok 0, degraded 0), failed 0, valid replies 0, confirmed 0, refuted 0, unverifiable 0 (tallied consult_ids: 0 of 0), '
    + 'input 0, output 0, cache read 0, cache write 0, duration_s 0.0, recorded 0.0000 (n/a runs: 0), priced 0.0000 (n/a runs: 0)')
  assert.equal(cli, '- all runs, cli: runs 1, answered 0 (ok 0, degraded 0), failed 1, valid replies 0, confirmed 0, refuted 0, unverifiable 0 (tallied consult_ids: 0 of 1), '
    + 'input n/a (n/a runs: 1), output n/a (n/a runs: 1), cache read n/a (n/a runs: 1), cache write n/a (n/a runs: 1), '
    + 'duration_s 3.2, recorded n/a (n/a runs: 1), priced n/a (n/a runs: 1)')
  assert.ok(totalsFor(result.stdout, 'paired').every((line) => /: runs 0, answered 0 /.test(line)))
  assert.equal(unpairedOf(result.stdout), '- unpaired topics: plugin 0 (no cli run), cli 1 (no plugin run)')
})

// ---------------------------------------------------------------------------
// Robustness

test('robustness: a reader that closes stdout early (| head) ends the report quietly with exit 0', async () => {
  const c = makeCase('epipe')
  c.write(Array.from({ length: 3000 }, (_, index) => cliLine({ topic: `t${index}`, consult_id: `c${index}` })))
  const child = spawn(process.execPath, [SCRIPT, '--ledger', c.ledger], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.destroy()
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const [code, signal] = await new Promise((resolve) => child.on('close', (...args) => resolve(args)))
  assert.deepEqual({ code, signal, stderr }, { code: 0, signal: null, stderr: '' })
})

test('robustness: a reply_file that is a FIFO is missing-file, without blocking', (t) => {
  const c = makeCase('fifo')
  const fifo = path.join(c.dir, 'replies', 'fifo.md')
  const made = spawnSync('mkfifo', [fifo])
  if (made.error !== undefined || made.status !== 0) {
    t.skip('mkfifo is not available')
    return
  }
  c.write([cliLine({ topic: 'alpha', consult_id: 'c-fifo', reply_file: fifo, reply_sha256: 'f'.repeat(64) })])
  // In a child with a timeout, so a blocking read fails the test instead of hanging it.
  const result = spawnSync(process.execPath, [SCRIPT, '--ledger', c.ledger], { env: childEnv(), encoding: 'utf8', timeout: 20_000 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(cell(rowsOf(result.stdout)[1], 'reply'), 'missing-file')
  assert.throws(() => readRegularFile(fifo), /not a regular file/)
  assert.throws(() => readRegularFile(c.dir), /not a regular file/)
  assert.equal(readRegularFile(c.file('plain.txt', 'x')).toString(), 'x')
})

test('robustness: Markdown, HTML and bidi characters from the ledger and argv are escaped in cells and notes', () => {
  assert.equal(escapeText('a_b*[c]`d`<e>&f|g\\h'), 'a\\_b\\*\\[c\\]\\`d\\`&lt;e&gt;&amp;f\\|g\\\\h')
  assert.equal(escapeText('rtl\u202eoverride\u2066iso\u200bzw\ufeffbom\u061calm\u200fx'), 'rtl\\u202eoverride\\u2066iso\\u200bzw\\ufeffbom\\u061calm\\u200fx')
  assert.equal(escapeText('line\nbreak\r\u2028x\u0007y'), 'line break x y')
  assert.equal(escapeCell, escapeText)
  const c = makeCase('escaping')
  c.write([
    pluginLine({ topic: 'alpha', consult_id: '<b>p</b>', model: 'm_*[x]`y`&z\u202e' }),
    cliLine({ topic: 'alpha', consult_id: 'c|1', status: 'weird_[status]' }),
  ])
  const result = c.run('--price', 'm_*[x]=1,2')
  const [plugin, cli] = rowsOf(result.stdout)
  assert.deepEqual(pick(plugin, 'consult_id', 'model'), { consult_id: '&lt;b&gt;p&lt;/b&gt;', model: 'm\\_\\*\\[x\\]\\`y\\`&amp;z\\u202e' })
  assert.deepEqual(pick(cli, 'consult_id', 'status'), { consult_id: 'c\\|1', status: 'weird\\_\\[status\\]' })
  assert.ok(result.stdout.includes('- Prices (USD per million tokens): m\\_\\*\\[x\\] in 1, out 2 (no cache rates)\n'))
  const notes = notesOf(result.stdout)
  assert.ok(notes.includes('Unanswered runs by ledger status, all runs: cli weird\\_\\[status\\] 1.'))
  assert.ok(notes.includes('`--price` given for model(s) with no listed run: "m\\_\\*\\[x\\]".'))
  for (const raw of ['\u202e', '<b>', '[x]', '`y`']) assert.ok(!result.stdout.includes(raw), raw)
})

test('docs: --help says reply_file must be absolute; a relative one resolves against the ledger directory and is noted', () => {
  assert.match(runMain(['--help']).stdout, /reply_file must be an absolute path/)
  const c = makeCase('relative-reply')
  const { reply_sha256: sha } = c.reply('c-rel', fenced(JSON.stringify(PLAN)))
  c.write([cliLine({ topic: 'alpha', consult_id: 'c-rel', reply_file: 'replies/c-rel.md', reply_sha256: sha })])
  const result = c.run()
  assert.equal(cell(rowsOf(result.stdout)[1], 'reply'), 'valid plan')
  assert.ok(notesOf(result.stdout).includes('1 answered run(s) record a relative `reply_file`, resolved against the directory of its ledger; `reply_file` should be absolute.'))
})

test('hygiene: every ledger this file can reach by default lies inside the temp dir', () => {
  const inside = (file) => file.startsWith(`${TMP}${path.sep}`)
  for (const env of [SAFE_ENV, process.env, childEnv()]) {
    for (const file of defaultLedgerPaths(env)) assert.ok(inside(file), file)
    assert.ok(inside(env.ADVISOR_LEDGER), env.ADVISOR_LEDGER)
    assert.deepEqual(resolveLedgers([], env).files, [env.ADVISOR_LEDGER])
  }
  // With no env at all, ~ is os.homedir(), which the safety net points at TMP for this process.
  assert.ok(defaultLedgerPaths({}).every(inside), defaultLedgerPaths({}).join(' '))
  // The script asks src/ledger.js for no paths: it imports only the file name and sha256 there.
  assert.match(readFileSync(SCRIPT, 'utf8'), /^import \{ LEDGER_FILE, sha256 \} from '\.\.\/src\/ledger\.js'$/m)
  assert.equal(LEDGER_FILE, 'sessions.jsonl')
})
