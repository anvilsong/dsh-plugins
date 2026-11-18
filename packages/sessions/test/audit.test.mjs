// Tests for the audit log (src/audit.js): hardened append-only writes, the
// field allow-list, fail-closed appendStart, and the bounded tail.
// Everything is written under a temp dir; HOME and DSH_HOME of the child
// process are decoys that must stay empty.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as auditModule from '../src/audit.js'
import { AUDIT_FILE, AuditError, createAudit, MAX_TAIL_BYTES, MAX_TAIL_LINES, sanitizeRecord } from '../src/audit.js'

const TMP = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sessions-audit-test-')))
after(() => rmSync(TMP, { recursive: true, force: true }))

const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const FIXED = new Date('2026-03-04T05:06:07.000Z')
const clock = () => FIXED
let counter = 0
const freshDir = () => path.join(TMP, `case-${++counter}`, 'data')
const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean)
const makeAudit = (dir = freshDir(), options) => createAudit(dir, { now: clock, hostPid: 4242, pluginVersion: '0.1.0', ...options })
const unix = typeof process.getuid === 'function' ? test : test.skip

test('the module exports the audit API and reads no environment variable', () => {
  assert.equal(AUDIT_FILE, 'audit.jsonl')
  assert.deepEqual(Object.keys(makeAudit()).sort(), ['append', 'appendStart', 'auditPath', 'dir', 'tail', 'writableProblem'])
  assert.ok(Object.isFrozen(makeAudit()))
  const source = readFileSync(path.join(SRC, 'audit.js'), 'utf8')
  assert.doesNotMatch(source, /process[.]env|homedir/)
  assert.ok(auditModule.AuditError)
  assert.throws(() => createAudit('relative/dir'), /absolute data directory/)
})

test('creating an audit touches no file; the first write creates folder 0700 and file 0600', async () => {
  const dir = freshDir()
  const audit = makeAudit(dir)
  assert.equal(existsSync(dir), false)
  assert.equal(audit.writableProblem(), undefined)
  assert.deepEqual(await audit.append({ op: 'plan', planId: 'p1' }), { ok: true })
  assert.equal(audit.auditPath, path.join(dir, 'audit.jsonl'))
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(statSync(audit.auditPath).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(dir), ['audit.jsonl'])
})

test('one line per record: v, ts and the defaults are filled in, lines append in order', async () => {
  const audit = makeAudit()
  await audit.appendStart({ planId: 'plan-1', batchId: 'batch-1', digest: 'abc123', counts: { units: 2 }, bytes: 10 })
  await audit.append({ op: 'unit-moved', planId: 'plan-1', batchId: 'batch-1', bytes: 5 })
  await audit.append({ op: 'apply-end', planId: 'plan-1', batchId: 'batch-1', outcome: 'complete' })
  const written = lines(audit.auditPath).map((line) => JSON.parse(line))
  assert.deepEqual(written, [
    { v: 1, ts: FIXED.toISOString(), op: 'apply-start', planId: 'plan-1', batchId: 'batch-1', digest: 'abc123', counts: { units: 2 }, bytes: 10, hostPid: 4242, pluginVersion: '0.1.0' },
    { v: 1, ts: FIXED.toISOString(), op: 'unit-moved', planId: 'plan-1', batchId: 'batch-1', bytes: 5, hostPid: 4242, pluginVersion: '0.1.0' },
    { v: 1, ts: FIXED.toISOString(), op: 'apply-end', planId: 'plan-1', batchId: 'batch-1', outcome: 'complete', hostPid: 4242, pluginVersion: '0.1.0' },
  ])
  assert.equal(readFileSync(audit.auditPath, 'utf8').endsWith('\n'), true)
})

test('appendStart always records op apply-start, whatever the caller passes', async () => {
  const audit = makeAudit()
  await audit.appendStart({ op: 'purge-start', planId: 'p' })
  assert.equal(JSON.parse(lines(audit.auditPath)[0]).op, 'apply-start')
})

test('allow-list: unknown keys are dropped, so no title, prompt or message text is recorded', async () => {
  const audit = makeAudit()
  const result = await audit.append({
    op: 'plan',
    planId: 'plan-1',
    title: 'Secret project title',
    prompt: 'my private prompt',
    message: 'hello there',
    text: 'free text',
    sessions: [
      { id: 's1', workspaceId: 'w1', parent: null, archived: true, pinned: false, bytes: 7, title: 'Secret title', path: '/Users/me/x' },
      { id: 's2', workspaceId: null, parent: 's1', archived: true, pinned: true, bytes: 3, messages: ['a'] },
    ],
    reasons: [{ code: 'recent', sessionId: 's1', detail: 'Secret detail' }],
    counts: { moved: 1, 'bad key with spaces': 3, nested: { a: 1 }, negative: -1 },
    extra: { deep: 'Secret' },
  })
  assert.deepEqual(result, { ok: true })
  const raw = readFileSync(audit.auditPath, 'utf8')
  for (const secret of ['Secret', 'private prompt', 'hello there', 'free text', '/Users/me', 'extra', 'title', 'message']) {
    assert.equal(raw.includes(secret), false, `${secret} must not be recorded`)
  }
  assert.deepEqual(JSON.parse(raw), {
    v: 1,
    ts: FIXED.toISOString(),
    op: 'plan',
    planId: 'plan-1',
    counts: { moved: 1 },
    sessions: [
      { id: 's1', workspaceId: 'w1', parent: null, archived: true, pinned: false, bytes: 7 },
      { id: 's2', workspaceId: null, parent: 's1', archived: true, pinned: true, bytes: 3 },
    ],
    reasons: [{ code: 'recent', sessionId: 's1' }],
    hostPid: 4242,
    pluginVersion: '0.1.0',
  })
})

test('allow-list: strings with spaces or control characters and wrong types are dropped, never recorded', () => {
  const clean = sanitizeRecord({
    ts: FIXED.toISOString(),
    op: 'unit-skipped',
    planId: 'My private title',
    batchId: 'line\nbreak',
    digest: 12,
    outcome: 'ok`x',
    errorCode: 'sessions-manager/busy',
    bytes: -5,
    hostPid: 0,
    pluginVersion: '1.2.3-rc.1+build',
    sessions: [{ id: 'has space', bytes: 1 }, { id: 'ok', bytes: 1.5 }, 'nope', { id: 'good', bytes: 2 }],
    reasons: 'not an array',
  })
  assert.deepEqual(clean, {
    v: 1,
    ts: FIXED.toISOString(),
    op: 'unit-skipped',
    errorCode: 'sessions-manager/busy',
    pluginVersion: '1.2.3-rc.1+build',
    sessions: [{ id: 'good', workspaceId: null, parent: null, archived: false, pinned: false, bytes: 2 }],
  })
})

test('ops: the named ops and restore-*, purge-* are accepted; anything else is refused', async () => {
  const audit = makeAudit()
  for (const op of ['plan', 'apply-start', 'unit-moved', 'unit-skipped', 'registry-step', 'apply-end', 'recover', 'restore-start', 'restore-end', 'purge-start', 'purge-end']) {
    assert.deepEqual(await audit.append({ op }), { ok: true }, op)
  }
  assert.equal(lines(audit.auditPath).length, 11)
  for (const op of ['delete', 'restore', 'purge', 'restore-', 'restore-X', 'Plan', 7, undefined, 'plan\n']) {
    const result = await audit.append({ op })
    assert.equal(result.ok, false, String(op))
    assert.equal(result.reason, 'invalid-record')
  }
  assert.equal((await audit.append('not an object')).ok, false)
  assert.equal(lines(audit.auditPath).length, 11)
})

test('principal is written only when defined; an owner call omits it', async () => {
  const audit = makeAudit()
  await audit.append({ op: 'restore-start', batchId: 'b1', principal: undefined })
  await audit.append({ op: 'restore-start', batchId: 'b2' })
  await audit.append({ op: 'restore-start', batchId: 'b3', principal: { kind: 'agent', sessionId: 's9', token: 'has space', secret: { x: 1 } } })
  await audit.append({ op: 'restore-start', batchId: 'b4', principal: 'owner' })
  const [a, b, c, d] = lines(audit.auditPath).map((line) => JSON.parse(line))
  assert.equal('principal' in a, false)
  assert.equal('principal' in b, false)
  assert.deepEqual(c.principal, { kind: 'agent', sessionId: 's9' })
  assert.equal('principal' in d, false)
})

test('a caller ts is kept when it is a valid date and replaced by the clock otherwise', async () => {
  const audit = makeAudit()
  await audit.append({ op: 'plan', ts: '2025-01-02T03:04:05.000Z' })
  await audit.append({ op: 'plan', ts: 'yesterday afternoon' })
  const [a, b] = lines(audit.auditPath).map((line) => JSON.parse(line))
  assert.equal(a.ts, '2025-01-02T03:04:05.000Z')
  assert.equal(b.ts, FIXED.toISOString())
  assert.equal(b.op, 'plan')
})

test('a record over the line cap is refused, not cut', async () => {
  const audit = makeAudit()
  const sessions = Array.from({ length: 20000 }, (_, index) => ({ id: `session-${'x'.repeat(100)}-${index}`, workspaceId: 'w'.repeat(100), parent: 'p'.repeat(100), bytes: index }))
  const result = await audit.append({ op: 'plan', sessions })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'record-too-large')
  assert.equal(existsSync(audit.auditPath), false)
})

unix('writing is refused when the folder is a symlink', async () => {
  const base = path.join(TMP, `link-folder-${++counter}`)
  const real = path.join(base, 'real')
  mkdirSync(real, { recursive: true, mode: 0o700 })
  const link = path.join(base, 'link')
  symlinkSync(real, link)
  const audit = makeAudit(link)
  assert.match(audit.writableProblem(), /is a symbolic link/)
  const result = await audit.append({ op: 'plan' })
  assert.equal(result.ok, false)
  assert.equal(result.warning.code, 'audit-failed')
  assert.equal(existsSync(path.join(real, 'audit.jsonl')), false)
})

unix('writing is refused when audit.jsonl is a symlink, and the target is untouched', async () => {
  const dir = freshDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const target = path.join(path.dirname(dir), 'elsewhere.txt')
  writeFileSync(target, 'keep\n', { mode: 0o600 })
  symlinkSync(target, path.join(dir, 'audit.jsonl'))
  const audit = makeAudit(dir)
  assert.match(audit.writableProblem(), /is a symbolic link/)
  assert.equal((await audit.append({ op: 'plan' })).ok, false)
  await assert.rejects(audit.appendStart({ planId: 'p' }), (error) => error instanceof AuditError && ['unsafe-folder', 'audit-failed'].includes(error.code))
  assert.equal(readFileSync(target, 'utf8'), 'keep\n')
  assert.deepEqual(await audit.tail(), [])
})

unix('writing is refused when the folder is writable by group or others', async () => {
  const dir = freshDir()
  mkdirSync(dir, { recursive: true })
  chmodSync(dir, 0o770)
  const audit = makeAudit(dir)
  assert.match(audit.writableProblem(), /unsafe: .*writable by group or others/)
  assert.equal((await audit.append({ op: 'plan' })).ok, false)
  chmodSync(dir, 0o702)
  assert.match(audit.writableProblem(), /writable by group or others/)
  assert.equal(existsSync(audit.auditPath), false)
  chmodSync(dir, 0o700)
  assert.equal(audit.writableProblem(), undefined)
  assert.equal((await audit.append({ op: 'plan' })).ok, true)
})

unix('writing is refused when audit.jsonl is writable by group or others, until fixed', async () => {
  const audit = makeAudit()
  await audit.append({ op: 'plan', planId: 'before' })
  chmodSync(audit.auditPath, 0o660)
  assert.match(audit.writableProblem(), /unsafe: .*writable by group or others/)
  const result = await audit.append({ op: 'plan', planId: 'blocked' })
  assert.equal(result.ok, false)
  await assert.rejects(audit.appendStart({ planId: 'blocked' }), AuditError)
  assert.equal(lines(audit.auditPath).length, 1)
  chmodSync(audit.auditPath, 0o600)
  assert.equal((await audit.append({ op: 'plan', planId: 'after' })).ok, true)
  assert.equal(lines(audit.auditPath).length, 2)
})

unix('an existing audit.jsonl keeps its mode 0600 and is appended to', async () => {
  const dir = freshDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(path.join(dir, 'audit.jsonl'), `${JSON.stringify({ v: 1, ts: FIXED.toISOString(), op: 'plan', planId: 'old' })}\n`, { mode: 0o600 })
  const audit = makeAudit(dir)
  await audit.append({ op: 'plan', planId: 'new' })
  assert.equal(statSync(audit.auditPath).mode & 0o777, 0o600)
  assert.deepEqual((await audit.tail(10)).map((record) => record.planId), ['old', 'new'])
})

test('a data directory that is a file is refused', async () => {
  const dir = freshDir()
  mkdirSync(path.dirname(dir), { recursive: true })
  writeFileSync(dir, 'x')
  const audit = makeAudit(dir)
  assert.equal((await audit.append({ op: 'plan' })).ok, false)
  await assert.rejects(audit.appendStart({}), AuditError)
})

test('fail closed: a failing appendStart() throws an AuditError the caller aborts on', async () => {
  const dir = freshDir()
  mkdirSync(path.dirname(dir), { recursive: true })
  writeFileSync(dir, 'a file where the folder should be')
  const audit = makeAudit(dir)
  let moved = false
  const apply = async () => {
    await audit.appendStart({ planId: 'p', batchId: 'b' })
    moved = true
  }
  await assert.rejects(apply(), (error) => error instanceof AuditError && error.code === 'audit-failed' && /Audit log/.test(error.message))
  assert.equal(moved, false)
})

test('fail closed: an oversize appendStart() record throws and writes nothing', async () => {
  const audit = makeAudit()
  await audit.appendStart({ planId: 'p' })
  const big = Array.from({ length: 20000 }, (_, index) => ({ id: `s${'x'.repeat(120)}${index}`, workspaceId: 'w'.repeat(100), parent: 'p'.repeat(100), bytes: 1 }))
  await assert.rejects(audit.appendStart({ sessions: big }), (error) => error instanceof AuditError && error.code === 'record-too-large')
  assert.equal(lines(audit.auditPath).length, 1)
})

test('later append failures are returned as an audit-failed warning and never thrown', async () => {
  const audit = makeAudit()
  await audit.appendStart({ planId: 'p' })
  rmSync(audit.dir, { recursive: true, force: true })
  writeFileSync(audit.dir, 'now a file')
  const result = await audit.append({ op: 'unit-moved', planId: 'p' })
  assert.equal(result.ok, false)
  assert.deepEqual(result.warning, { code: 'audit-failed', sessionId: null })
  assert.equal(typeof result.reason, 'string')
  const never = await audit.append({ op: 'apply-end' }).then(() => 'resolved', () => 'rejected')
  assert.equal(never, 'resolved')
})

test('the warning code is one the contract defines', async () => {
  const { WARNING_CODES } = await import('../src/contract.js')
  const blocker = path.join(TMP, `blocker-${++counter}.txt`)
  writeFileSync(blocker, '')
  const result = await createAudit(path.join(blocker, 'sub')).append({ op: 'apply-end' })
  assert.equal(result.ok, false)
  assert.ok(WARNING_CODES.includes(result.warning.code))
})

test('tail: records come back oldest first, limited to the last N', async () => {
  const audit = makeAudit()
  for (let index = 0; index < 10; index++) await audit.append({ op: 'unit-moved', planId: `p${index}`, bytes: index })
  const last3 = await audit.tail(3)
  assert.deepEqual(last3.map((record) => record.planId), ['p7', 'p8', 'p9'])
  assert.equal((await audit.tail(100)).length, 10)
  assert.equal((await audit.tail()).length, 10)
  assert.equal((await audit.tail(0)).length, 1)
  assert.equal((await audit.tail(-5)).length, 1)
  assert.equal((await audit.tail(Number.NaN)).length, 10)
  assert.ok(MAX_TAIL_LINES >= 100)
})

test('tail: a missing file or an empty file gives an empty list', async () => {
  const audit = makeAudit()
  assert.deepEqual(await audit.tail(), [])
  mkdirSync(audit.dir, { recursive: true, mode: 0o700 })
  writeFileSync(audit.auditPath, '', { mode: 0o600 })
  assert.deepEqual(await audit.tail(), [])
})

test('tail: torn, foreign and invalid lines are skipped', async () => {
  const audit = makeAudit()
  await audit.append({ op: 'plan', planId: 'a' })
  const good = (planId) => JSON.stringify({ v: 1, ts: FIXED.toISOString(), op: 'plan', planId })
  writeFileSync(
    audit.auditPath,
    [
      good('first'),
      '{"v":1,"ts":"2026-03-04T05:06:07.000Z","op":"pla', // torn, newline-terminated by a later write
      'not json at all',
      '[1,2,3]',
      '{"v":2,"op":"plan"}',
      '{"v":1,"op":"nope"}',
      JSON.stringify({ v: 1, ts: FIXED.toISOString(), op: 'plan', planId: 'a title with spaces', title: 'Secret' }),
      good('last'),
    ].join('\n'),
    { mode: 0o600 },
  )
  const records = await audit.tail(50)
  assert.deepEqual(records.map((record) => record.planId), ['first', undefined, 'last'])
  assert.equal(JSON.stringify(records).includes('Secret'), false)
})

test('tail: a whole line glued behind a torn fragment is recovered, the fragment is not', async () => {
  const audit = makeAudit()
  mkdirSync(audit.dir, { recursive: true, mode: 0o700 })
  const good = JSON.stringify({ v: 1, ts: FIXED.toISOString(), op: 'plan', planId: 'whole' })
  writeFileSync(audit.auditPath, `{"v":1,"ts":"2026-03-04T05:06:07.000Z","op":"unit-mo${good}\n`, { mode: 0o600 })
  assert.deepEqual((await audit.tail()).map((record) => record.planId), ['whole'])
})

test('tail: reads at most a bounded number of bytes from the end and drops the partial first line', async () => {
  const audit = makeAudit()
  for (let index = 0; index < 400; index++) await audit.append({ op: 'unit-moved', planId: `plan-${String(index).padStart(4, '0')}`, bytes: index })
  const size = statSync(audit.auditPath).size
  const small = await audit.tail(1000, { maxBytes: 2000 })
  assert.ok(small.length > 0 && small.length < 400, `window of 2000 bytes holds ${small.length} lines`)
  assert.ok(small.length * 100 <= 2000 + 100, 'not more lines than the window can hold')
  assert.equal(small.at(-1).planId, 'plan-0399')
  // Every record is whole: the partial first line of the window is gone.
  for (const record of small) assert.match(record.planId, /^plan-\d{4}$/)
  assert.equal(small[0].planId, `plan-${String(400 - small.length).padStart(4, '0')}`)
  assert.ok(size > 2000)
  // maxBytes cannot exceed the hard cap.
  assert.ok(MAX_TAIL_BYTES <= 1024 * 1024)
})

test('tail: a file much larger than the cap is not read whole', async () => {
  const dir = freshDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, 'audit.jsonl')
  const line = `${JSON.stringify({ v: 1, ts: FIXED.toISOString(), op: 'plan', planId: 'x'.repeat(100) })}\n`
  const total = Math.ceil((MAX_TAIL_BYTES * 3) / line.length)
  writeFileSync(file, line.repeat(total) + `${JSON.stringify({ v: 1, ts: FIXED.toISOString(), op: 'plan', planId: 'newest' })}\n`, { mode: 0o600 })
  const audit = makeAudit(dir)
  const reads = []
  const fsPromises = (await import('node:fs')).promises
  const originalOpen = fsPromises.open
  fsPromises.open = async (...args) => {
    const handle = await originalOpen(...args)
    const originalRead = handle.read.bind(handle)
    handle.read = async (buffer, ...rest) => {
      reads.push(buffer.length)
      return originalRead(buffer, ...rest)
    }
    return handle
  }
  try {
    const records = await audit.tail(MAX_TAIL_LINES)
    assert.equal(records.at(-1).planId, 'newest')
    assert.ok(records.length <= MAX_TAIL_LINES)
  } finally {
    fsPromises.open = originalOpen
  }
  assert.ok(reads.length > 0 && reads.every((length) => length <= MAX_TAIL_BYTES), `reads: ${reads.join(',')}`)
  assert.ok(reads.reduce((sum, length) => sum + length, 0) <= MAX_TAIL_BYTES)
})

unix('tail does not follow a symlinked audit.jsonl', async () => {
  const dir = freshDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const target = path.join(path.dirname(dir), 'other.jsonl')
  writeFileSync(target, `${JSON.stringify({ v: 1, ts: FIXED.toISOString(), op: 'plan', planId: 'foreign' })}\n`)
  symlinkSync(target, path.join(dir, 'audit.jsonl'))
  assert.deepEqual(await makeAudit(dir).tail(), [])
})

test('concurrent appends in one process keep every line whole', async () => {
  const audit = makeAudit()
  const results = await Promise.all(Array.from({ length: 50 }, (_, index) => audit.append({ op: 'unit-moved', planId: `c${index}`, bytes: index })))
  assert.ok(results.every((result) => result.ok))
  const written = lines(audit.auditPath).map((line) => JSON.parse(line))
  assert.equal(written.length, 50)
  assert.deepEqual(new Set(written.map((record) => record.planId)).size, 50)
})

test('several processes append to one file: every line survives whole', async () => {
  const dir = freshDir()
  const audit = createAudit(dir)
  await audit.append({ op: 'plan', planId: 'seed' })
  const decoyHome = path.join(TMP, `decoy-home-${++counter}`)
  mkdirSync(decoyHome)
  const script = `
    import { createAudit } from ${JSON.stringify(path.join(SRC, 'audit.js'))}
    const audit = createAudit(${JSON.stringify(dir)})
    for (let index = 0; index < 40; index++) {
      const result = await audit.append({ op: 'unit-moved', planId: 'proc' + process.argv[1] + '-' + index, bytes: index })
      if (!result.ok) process.exit(2)
    }
  `
  const run = (id) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, String(id)], {
        env: { PATH: process.env.PATH, HOME: decoyHome, DSH_HOME: decoyHome, XDG_STATE_HOME: decoyHome },
        stdio: 'ignore',
      })
      child.on('error', reject)
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child ${id} exited ${code}`))))
    })
  await Promise.all([1, 2, 3, 4].map(run))
  const written = lines(audit.auditPath).map((line) => JSON.parse(line))
  assert.equal(written.length, 1 + 4 * 40)
  assert.equal(new Set(written.map((record) => record.planId)).size, 1 + 4 * 40)
  assert.deepEqual(readdirSync(decoyHome), [])
})
