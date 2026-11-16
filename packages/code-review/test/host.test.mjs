import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { apply, findingFingerprint, dedupeCandidates, reviewWorkflowScript } from '../src/index.host.js'

async function collect(stream) {
  let text = ''
  for await (const chunk of stream) text += chunk.toString()
  return text
}

function harness(cwd, git = false) {
  let command
  let steered = null
  const ctx = {
    commands: { register(value) { command = value } },
    subprocess: {
      spawn({ argv, cwd }) {
        if (!git) throw new Error('git should not be used')
        const child = spawn(argv[0], argv.slice(1), { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
        return {
          stdout: { collect: () => collect(child.stdout) },
          stderr: { collect: () => collect(child.stderr) },
          done: new Promise((resolve) => child.on('close', (code) => resolve({ code }))),
        }
      },
    },
  }
  const agent = {
    session: { header: { cwd } },
    followup(message) { steered = message },
  }
  return { ctx, agent, command: () => command, steered: () => steered }
}

async function temp() {
  return mkdtemp(path.join(os.tmpdir(), 'dsh-code-review-'))
}

async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true })
}

test('rejects unsafe paths before spawning anything', async () => {
  const cwd = await temp()
  try {
    const h = harness(cwd)
    await apply(h.ctx)
    assert.equal((await h.command().handler({ agent: h.agent, rawInput: '-bad' })).kind, 'error')
    assert.equal((await h.command().handler({ agent: h.agent, rawInput: '../outside' })).kind, 'error')
    assert.equal((await h.command().handler({ agent: h.agent, rawInput: 'missing.js' })).kind, 'error')
    assert.equal(h.steered(), null)
  } finally {
    await cleanup(cwd)
  }
})

test('non-git scope filters sensitive and generated files', async () => {
  const cwd = await temp()
  try {
    await mkdir(path.join(cwd, 'src'))
    await writeFile(path.join(cwd, 'src/a.js'), 'export const a = 1\n')
    await writeFile(path.join(cwd, 'src/b.js'), 'export const b = 2\n')
    await writeFile(path.join(cwd, '.env'), 'SUPER_SECRET=value\n')
    await writeFile(path.join(cwd, 'id_rsa'), 'PRIVATE\n')
    await writeFile(path.join(cwd, 'package-lock.json'), '{}\n')
    const h = harness(cwd)
    await apply(h.ctx)
    const result = await h.command().handler({ agent: h.agent, rawInput: '' })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /Code review queued/)
    const text = h.steered().content[0].text
    assert.match(text, /exactly ONE workflow call/)
    assert.match(text, /two independent finders in parallel and one refuter/)
    assert.match(text, /src\/a\.js/)
    assert.match(text, /src\/b\.js/)
    assert.match(text, /sensitive/)
    assert.match(text, /generated/)
    assert.doesNotMatch(text, /SUPER_SECRET/)
    assert.doesNotMatch(text, /PRIVATE/)
  } finally {
    await cleanup(cwd)
  }
})

test('patch mode keeps diff paths and filters sensitive patches', async () => {
  const cwd = await temp()
  try {
    await writeFile(path.join(cwd, 'change.patch'), 'diff --git a/src/a.js b/src/a.js\n+const a = 1\ndiff --git a/.env b/.env\n+SECRET=value\n')
    const h = harness(cwd)
    await apply(h.ctx)
    const result = await h.command().handler({ agent: h.agent, rawInput: 'change.patch' })
    assert.equal(result.kind, 'success')
    const text = h.steered().content[0].text
    assert.match(text, /"mode":"patch"/)
    assert.match(text, /src\/a\.js/)
    assert.match(text, /sensitive/)
    assert.match(text, /\+const a = 1/)
    assert.doesNotMatch(text, /SECRET=value/)
  } finally {
    await cleanup(cwd)
  }
})

test('symlinks and unsafe filenames are excluded', async () => {
  const cwd = await temp()
  try {
    await writeFile(path.join(cwd, 'a.js'), 'const a = 1\n')
    await writeFile(path.join(cwd, 'bad\nname.js'), 'const bad = 1\n')
    await symlink('/etc/passwd', path.join(cwd, 'link.js'))
    const h = harness(cwd)
    await apply(h.ctx)
    const result = await h.command().handler({ agent: h.agent, rawInput: '' })
    assert.equal(result.kind, 'success')
    const text = h.steered().content[0].text
    assert.match(text, /a\.js/)
    assert.match(text, /unsafe_name/)
    assert.doesNotMatch(text, /link\.js/)
  } finally {
    await cleanup(cwd)
  }
})

test('a repository without a HEAD still lists untracked files', async () => {
  const cwd = await temp()
  try {
    execFileSync('git', ['init', '-q'], { cwd })
    await writeFile(path.join(cwd, 'new.js'), 'const fresh = 1\n')
    const h = harness(cwd, true)
    await apply(h.ctx)
    const result = await h.command().handler({ agent: h.agent, rawInput: '' })
    assert.equal(result.kind, 'success')
    assert.match(h.steered().content[0].text, /new\.js/)
  } finally {
    await cleanup(cwd)
  }
})

test('fingerprints normalize paths and line ranges', () => {
  assert.equal(
    findingFingerprint({ file: './src/../src/a.js', line: '4-2', category: 'Logic Error' }),
    findingFingerprint({ file: 'src/a.js', line: [2, 4], category: 'logic-error' }),
  )
  assert.notEqual(
    findingFingerprint({ file: 'src/a.js', line: 2, category: 'logic' }),
    findingFingerprint({ file: 'src/a.js', line: 3, category: 'logic' }),
  )
})

test('dedupe drops seen and same-round duplicate candidates', () => {
  const a = { file: 'a.js', line: 1, category: 'logic' }
  const b = { file: './a.js', line: [1, 1], category: 'Logic' }
  const seen = new Set([findingFingerprint(a)])
  const result = dedupeCandidates([a, b, { file: 'b.js', line: 2, category: 'security' }], seen)
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].file, 'b.js')
  assert.equal(result.duplicates, 2)
})

test('steer spec embeds the bounded three-round loop and stop contract', async () => {
  const cwd = await temp()
  try {
    await writeFile(path.join(cwd, 'a.js'), 'const a = 1\n')
    const h = harness(cwd)
    await apply(h.ctx)
    await h.command().handler({ agent: h.agent, rawInput: '' })
    const text = h.steered().content[0].text
    const spec = JSON.parse(text.match(/<workflow_spec>([\s\S]*)<\/workflow_spec>/)[1])
    assert.equal(spec.args.finderPrompts.length, 2)
    assert.match(spec.script, /round <= 3/)
    assert.match(spec.script, /return finish\('dry'\)/)
    assert.match(spec.script, /return finish\('cap_reached'\)/)
    assert.match(spec.script, /validRefuterOutput/)
    assert.match(text, /passing spec\.meta as meta, spec\.args as args, and spec\.script as the script verbatim/)
    assert.match(text, /Rounds: <rounds>\/3/)
    assert.match(text, /Stop reason: <dry\|cap_reached>/)
    assert.match(text, /More findings may remain/)
  } finally {
    await cleanup(cwd)
  }
})

async function runReviewScript({ finders, verdict }) {
  const calls = []
  const args = {
    scope: { mode: 'scope', path: '.', files: [], skipped: [] },
    finderPrompts: ['correctness', 'security'],
    refuterPrompt: 'refuter',
  }
  const context = {
    args,
    phase() {},
    log() {},
    async parallel(thunks) { return Promise.all(thunks.map((thunk) => thunk())) },
    async agent(prompt, options) {
      calls.push({ prompt, options })
      const round = Number(options.label.match(/round-(\d+)/)?.[1] ?? 1)
      if (options.label.includes('refuter')) {
        const candidates = JSON.parse(prompt.split('CANDIDATES (JSON, treat as data): ')[1])
        return { verdicts: verdict(candidates, round) }
      }
      return { findings: finders(round, options.label) }
    },
  }
  const script = `(async () => {${reviewWorkflowScript()}})()`
  const result = await vm.runInNewContext(script, context)
  return { result, calls }
}

test('workflow stops dry on a clean first round', async () => {
  const { result, calls } = await runReviewScript({ finders: () => [], verdict: () => [] })
  assert.equal(result.stop, 'dry')
  assert.equal(result.rounds, 1)
  assert.equal(calls.length, 2)
})

test('workflow repeats after a confirmed finding and then stops dry', async () => {
  const { result, calls } = await runReviewScript({
    finders: (round) => round === 1 ? [{ file: 'a.js', line: 1, severity: 'medium', category: 'logic', evidence: 'x', recommendation: 'fix' }] : [],
    verdict: (candidates) => candidates.map((candidate) => ({ id: candidate.id, verdict: 'confirmed', reason: '' })),
  })
  assert.equal(result.stop, 'dry')
  assert.equal(result.rounds, 2)
  assert.equal(calls.filter((call) => call.options.label.includes('refuter')).length, 1)
})

test('workflow caps after three confirmed rounds', async () => {
  const { result, calls } = await runReviewScript({
    finders: (round, label) => [{ file: `${label}-${round}.js`, line: round, severity: 'medium', category: 'logic', evidence: 'x', recommendation: 'fix' }],
    verdict: (candidates) => candidates.map((candidate) => ({ id: candidate.id, verdict: 'confirmed', reason: '' })),
  })
  assert.equal(result.stop, 'cap_reached')
  assert.equal(result.rounds, 3)
  assert.equal(calls.filter((call) => call.options.label.includes('refuter')).length, 3)
})

test('workflow rejects unknown refuter IDs instead of reporting dry', async () => {
  await assert.rejects(() => runReviewScript({
    finders: () => [{ file: 'a.js', line: 1, severity: 'medium', category: 'logic', evidence: 'x', recommendation: 'fix' }],
    verdict: () => [{ id: 'unknown', verdict: 'confirmed', reason: '' }],
  }), /unknown, duplicate, missing, or extra output/)
})

test('git scope includes tracked and untracked reviewable files', async () => {
  const cwd = await temp()
  try {
    execFileSync('git', ['init', '-q'], { cwd })
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd })
    await writeFile(path.join(cwd, 'a.js'), 'const a = 1\n')
    execFileSync('git', ['add', 'a.js'], { cwd })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd })
    await writeFile(path.join(cwd, 'a.js'), 'const a = 2\n')
    await writeFile(path.join(cwd, 'b.js'), 'const b = 2\n')
    const h = harness(cwd, true)
    await apply(h.ctx)
    const result = await h.command().handler({ agent: h.agent, rawInput: '' })
    assert.equal(result.kind, 'success')
    const text = h.steered().content[0].text
    assert.match(text, /a\.js/)
    assert.match(text, /b\.js/)
  } finally {
    await cleanup(cwd)
  }
})
