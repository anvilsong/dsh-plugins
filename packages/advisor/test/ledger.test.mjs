// Tests for the plugin-owned ledger (src/ledger.js): dataDir resolution, the
// ledger object, and the cross-process guarantees several hosts rely on
// (one O_APPEND write per line, exclusive reply files, no read cache).
// Everything is written under a temp dir; child processes get decoy HOME,
// XDG_STATE_HOME, DSH_HOME and ADVISOR_LEDGER, which must stay empty.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, promises as fsPromises, readdirSync, readFileSync, realpathSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as ledgerModule from '../src/ledger.js'
import {
  createLedger,
  fileSha256Sync,
  LEDGER_FILE,
  REPLIES_DIR,
  resolveDataDir,
  sha256,
} from '../src/ledger.js'

const TMP = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'advisor-ledger-test-')))
after(() => rmSync(TMP, { recursive: true, force: true }))

const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const PLAN_ID = 'abcdef012345'
const PLAN_ID_B = '0123456789ab'
const hash = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
const LEDGER_KEYS = ['appendLedger', 'dir', 'idInUse', 'ledgerEntriesFor', 'ledgerPath', 'recentLedger', 'replyPath', 'repliesDir', 'writableProblem', 'writeReply'].sort()
const UNSAFE_MESSAGE = /must not contain control, line or paragraph separator, bidirectional control, or backtick characters/
// Every Unicode Bidi_Control character.
const BIDI_CONTROLS = ['\u061c', '\u200e', '\u200f', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069']
// Permission bits do not bind root, and POSIX owners do not exist everywhere.
const ROOT = process.getuid?.() === 0
const POSIX_OWNERS = typeof process.getuid === 'function'

/** Every file and folder under a directory, relative, folders with a trailing slash, sorted. */
function tree(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const relative = path.relative(dir, path.join(entry.parentPath ?? entry.path, entry.name)).split(path.sep).join('/')
      return entry.isDirectory() ? `${relative}/` : relative
    })
    .sort()
}

// ---------------------------------------------------------------------------
// resolveDataDir

test('resolveDataDir: a configured absolute dataDir wins over home; unset means <home>/advisor', () => {
  const home = path.join(TMP, 'dsh-home')
  const configured = path.join(TMP, 'configured', 'advisor-data')
  assert.equal(resolveDataDir({ dataDir: configured }, { home }), configured)
  assert.equal(resolveDataDir({ dataDir: `${configured}/` }, { home }), configured, 'a trailing separator is dropped')
  assert.equal(resolveDataDir({ dataDir: configured }, {}), configured, 'no home needed')
  assert.equal(resolveDataDir({ dataDir: configured }), configured)
  assert.throws(() => resolveDataDir({ dataDir: '/' }, { home }), /must not be a filesystem root/, 'a root is never a dataDir')
  for (const config of [{}, undefined, null, { dataDir: undefined }, { other: 1 }]) {
    assert.equal(resolveDataDir(config, { home }), path.join(home, 'advisor'), JSON.stringify(config))
  }
  assert.equal(resolveDataDir({}, { home: `${home}/` }), path.join(home, 'advisor'))
})

test('resolveDataDir: without a dataDir or an absolute home it throws "Advisor dataDir is not configured"', () => {
  for (const options of [undefined, null, {}, { home: undefined }, { home: '' }, { home: 'relative/home' }, { home: '~/.dsh' }, { home: 42 }, { home: null }]) {
    assert.throws(() => resolveDataDir({}, options), { message: 'Advisor dataDir is not configured' }, JSON.stringify(options))
  }
  assert.throws(() => resolveDataDir(undefined, undefined), { message: 'Advisor dataDir is not configured' })
})

test('resolveDataDir: relative, empty, ~, .., non-string, control-character and unnormalized values are rejected, never replaced by home', () => {
  const home = path.join(TMP, 'dsh-home')
  const cases = [
    ['', /non-empty string/],
    ['relative', /absolute path/],
    ['./data', /absolute path/],
    ['data/advisor', /absolute path/],
    ['..', /absolute path/],
    ['~', /absolute path/],
    ['~/x', /absolute path/],
    ['~/.dsh/advisor', /absolute path/],
    ['~root/advisor', /absolute path/],
    ['/a/../b', /"\.\." segments/],
    ['/a/..', /"\.\." segments/],
    ['/..', /"\.\." segments/],
    [`${TMP}/../escape`, /"\.\." segments/],
    ['/a/./b', /normalized path/],
    ['/a//b', /normalized path/],
    ['/a/b/.', /normalized path/],
    [42, /non-empty string/],
    [true, /non-empty string/],
    [null, /non-empty string/],
    [{}, /non-empty string/],
    [['/a'], /non-empty string/],
    [Buffer.from('/a'), /non-empty string/],
    ['/a/b\u0000c', UNSAFE_MESSAGE],
    ['/a\nb', UNSAFE_MESSAGE],
    ['/a\rb', UNSAFE_MESSAGE],
    ['/a\tb', UNSAFE_MESSAGE],
    ['/a\u001fb', UNSAFE_MESSAGE],
    ['/a\u007fb', UNSAFE_MESSAGE],
  ]
  for (const [dataDir, message] of cases) {
    assert.throws(() => resolveDataDir({ dataDir }, { home }), message, JSON.stringify(dataDir))
  }
})

test('resolveDataDir: filesystem roots, C1 controls, separators, bidi controls, backticks and surrounding whitespace are rejected', () => {
  const home = path.join(TMP, 'dsh-home')
  const cases = [
    ['/', /must not be a filesystem root/],
    ['//', /must not be a filesystem root/],
    ['///', /must not be a filesystem root/],
    ['/a\u0080b', UNSAFE_MESSAGE],
    ['/a\u0085b', UNSAFE_MESSAGE],
    ['/a\u009fb', UNSAFE_MESSAGE],
    ['/a\u2028b', UNSAFE_MESSAGE],
    ['/a\u2029b', UNSAFE_MESSAGE],
    ...BIDI_CONTROLS.map((bidi) => [`/a${bidi}b`, UNSAFE_MESSAGE]),
    ['/a`b', UNSAFE_MESSAGE],
    ['/data`', UNSAFE_MESSAGE],
    [' /a', /must not start or end with whitespace/],
    ['/a ', /must not start or end with whitespace/],
    ['/a/ ', /must not start or end with whitespace/],
    ['/a\u00a0', /must not start or end with whitespace/],
    ['\u3000/a', /must not start or end with whitespace/],
    ['/a\ufeff', /must not start or end with whitespace/],
    ['/x//', /must be a normalized path such as "\/x"/],
    [`${TMP}/data///`, /must be a normalized path/],
  ]
  for (const [dataDir, message] of cases) {
    assert.throws(() => resolveDataDir({ dataDir }, { home }), message, JSON.stringify(dataDir))
  }
  assert.equal(resolveDataDir({ dataDir: `${TMP}/data/` }, { home }), path.join(TMP, 'data'), 'one trailing separator is dropped')
  assert.equal(resolveDataDir({ dataDir: path.join(TMP, 'with inner space') }, { home }), path.join(TMP, 'with inner space'), 'inner spaces are fine')
})

test('resolveDataDir: the raw DSH home is checked as given, before advisor is joined: "..", control characters and the other string rules', () => {
  const homeError = (message) => (error) => error.message.startsWith('The DSH home ') && message.test(error.message)
    && error.message.endsWith('(needed for the default dataDir)')
  for (const [home, message] of [
    [`${TMP}/x/../dsh-home`, /must not contain "\.\." segments/],
    [`${TMP}/..`, /must not contain "\.\." segments/],
    ['/..', /must not contain "\.\." segments/],
    [`${TMP}/dsh\u0000home`, UNSAFE_MESSAGE],
    [`${TMP}/dsh\nhome`, UNSAFE_MESSAGE],
    [`${TMP}/dsh\u0085home`, UNSAFE_MESSAGE],
    [`${TMP}/x\`y`, UNSAFE_MESSAGE],
    [`${TMP}/x\u202ey`, UNSAFE_MESSAGE],
    [`${TMP}/x\u2028y`, UNSAFE_MESSAGE],
    ...BIDI_CONTROLS.map((bidi) => [`${TMP}/x${bidi}y`, UNSAFE_MESSAGE]),
    [`${TMP}/dsh-home `, /must not start or end with whitespace/],
    [`${TMP}/dsh-home//`, /must be a normalized path/],
    ['/', /must not be a filesystem root/],
    ['//', /must not be a filesystem root/],
    ['///', /must not be a filesystem root/],
    [`${TMP}//dsh-home`, /must be a normalized path/],
    [`${TMP}/./dsh-home`, /must be a normalized path/],
  ]) {
    assert.throws(() => resolveDataDir({}, { home }), homeError(message), JSON.stringify(home))
  }
  // join() would have normalized these into a plausible folder; they are refused instead.
  assert.throws(() => resolveDataDir({}, { home: '/tmp/../etc' }), /The DSH home must not contain "\.\." segments/)
  assert.equal(resolveDataDir({}, { home: `${TMP}/dsh-home/` }), path.join(TMP, 'dsh-home', 'advisor'), 'a trailing separator is tolerated')
})

test('resolveDataDir: win32 paths need a drive or UNC share, accept either separator, and reject roots', () => {
  const win = { platform: 'win32' }
  for (const [dataDir, expected] of [
    ['C:\\Users\\me\\advisor', 'C:\\Users\\me\\advisor'],
    ['C:/Users/me/advisor', 'C:\\Users\\me\\advisor'],
    ['C:\\Users\\me\\advisor\\', 'C:\\Users\\me\\advisor'],
    ['c:\\data', 'c:\\data'],
    ['\\\\server\\share\\advisor', '\\\\server\\share\\advisor'],
    ['//server/share/advisor', '\\\\server\\share\\advisor'],
  ]) {
    assert.equal(resolveDataDir({ dataDir }, win), expected, dataDir)
  }
  for (const [dataDir, message] of [
    ['C:', /absolute path/],
    ['C:advisor', /absolute path/],
    ['advisor', /absolute path/],
    ['~\\advisor', /absolute path/],
    ['\\advisor', /must name a drive or UNC share/],
    ['/advisor', /must name a drive or UNC share/],
    ['C:\\', /must not be a filesystem root/],
    ['C:/', /must not be a filesystem root/],
    ['\\\\server\\share', /must not be a filesystem root/],
    ['\\\\server\\share\\', /must not be a filesystem root/],
    ['C:\\a\\..\\b', /"\.\." segments/],
    ['C:/a/../b', /"\.\." segments/],
    ['C:\\a\\.\\b', /normalized path/],
    ['C:\\a\\\\b', /normalized path/],
    ['C:/a//b', /normalized path/],
    ['C:\\a\\\\', /normalized path/],
    ['C:/a//', /normalized path/],
    ['C:\\a`b', UNSAFE_MESSAGE],
  ]) {
    assert.throws(() => resolveDataDir({ dataDir }, win), message, JSON.stringify(dataDir))
  }
  assert.equal(resolveDataDir({}, { ...win, home: 'C:\\Users\\me\\.dsh' }), 'C:\\Users\\me\\.dsh\\advisor')
  assert.throws(() => resolveDataDir({}, { ...win, home: '\\Users\\me\\.dsh' }), /^Error: The DSH home must name a drive or UNC share.*\(needed for the default dataDir\)$/)
  assert.throws(() => resolveDataDir({}, { ...win, home: 'C:\\Users\\..\\me' }), /The DSH home must not contain "\.\." segments/)
  assert.throws(() => resolveDataDir({}, { ...win, home: 'C:\\Users\\\\me' }), /The DSH home must be a normalized path/)
  assert.equal(resolveDataDir({}, { ...win, home: 'C:/Users/me/.dsh' }), 'C:\\Users\\me\\.dsh\\advisor', 'either separator')
  assert.throws(() => resolveDataDir({}, { ...win, home: 'Users\\me' }), { message: 'Advisor dataDir is not configured' })
  assert.throws(() => resolveDataDir({}, { ...win, home: 'C:\\' }), /The DSH home must not be a filesystem root/)
})

test('resolveDataDir: checks strings only; an existing folder\'s owner, mode and type are left to the probe, which recovers once fixed', { skip: !POSIX_OWNERS && 'no POSIX owners on this platform' }, (t) => {
  const base = path.join(TMP, 'owned')
  mkdirSync(base, { mode: 0o700 })
  t.after(() => chmodSync(base, 0o700))
  for (const mode of [0o700, 0o750, 0o755, 0o711, 0o775, 0o770, 0o777, 0o702, 0o720]) {
    chmodSync(base, mode)
    assert.equal(resolveDataDir({ dataDir: base }), base, `mode 0${mode.toString(8)} resolves`)
    const expected = (mode & 0o022) === 0 ? undefined : `unsafe: ${base} is writable by group or others (mode 0${mode.toString(8)})`
    assert.equal(createLedger(base).writableProblem(), expected, `mode 0${mode.toString(8)} probe`)
  }
  chmodSync(base, 0o700)
  assert.equal(createLedger(base).writableProblem(), undefined, 'fixed: usable again without resolving anew')

  const home = path.join(TMP, 'unsafe-home')
  mkdirSync(path.join(home, 'advisor'), { recursive: true, mode: 0o700 })
  chmodSync(path.join(home, 'advisor'), 0o777)
  assert.equal(resolveDataDir({}, { home }), path.join(home, 'advisor'), 'the default resolves too')
  assert.equal(createLedger(path.join(home, 'advisor')).writableProblem(), `unsafe: ${path.join(home, 'advisor')} is writable by group or others (mode 0777)`)
  chmodSync(path.join(home, 'advisor'), 0o700)
  assert.equal(createLedger(path.join(home, 'advisor')).writableProblem(), undefined)
  if (!ROOT) {
    assert.equal(resolveDataDir({ dataDir: '/usr' }), '/usr')
    assert.match(createLedger('/usr').writableProblem(), /^unsafe: \/usr belongs to another user \(uid 0, this process runs as \d+\)$/)
  }
  assert.equal(resolveDataDir({ dataDir: '/dev/null' }), '/dev/null')
  assert.equal(createLedger('/dev/null').writableProblem(), 'not writable: /dev/null is not a directory')
})

// ---------------------------------------------------------------------------
// Static: no environment-derived location remains in the plugin source.

test('exports: only the dataDir API remains; stateDir, ledgerPath, replyPath and the module-level helpers are gone', () => {
  assert.deepEqual(Object.keys(ledgerModule).sort(), ['LEDGER_FILE', 'REPLIES_DIR', 'createLedger', 'fileSha256Sync', 'resolveDataDir', 'sha256'])
})

test('static: no src/*.js references XDG_STATE_HOME, ADVISOR_LEDGER, .local/state or homedir', () => {
  const files = readdirSync(SRC).filter((name) => name.endsWith('.js')).sort()
  for (const name of ['index.host.js', 'ledger.js', 'planner.js', 'verifier.js']) assert.ok(files.includes(name), name)
  for (const name of files) {
    const text = readFileSync(path.join(SRC, name), 'utf8')
    assert.doesNotMatch(text, /XDG_STATE_HOME|ADVISOR_LEDGER|\.local\/state|homedir/, name)
    assert.doesNotMatch(text, /process\.env|['"]node:os['"]|['"]\.local['"]/, `${name}: no other environment or OS-home lookup`)
  }
})

// ---------------------------------------------------------------------------
// createLedger

test('createLedger: needs an absolute directory; returns a frozen object with fixed paths and touches no file', () => {
  for (const dir of [undefined, null, '', 'relative', './x', '~/x', 42, {}, ['/a']]) {
    assert.throws(() => createLedger(dir), /absolute data directory/, JSON.stringify(dir))
  }
  assert.equal(LEDGER_FILE, 'sessions.jsonl')
  assert.equal(REPLIES_DIR, 'replies')
  const dir = path.join(TMP, 'shape')
  const ledger = createLedger(dir)
  assert.equal(Object.isFrozen(ledger), true)
  assert.deepEqual(Object.keys(ledger).sort(), LEDGER_KEYS)
  assert.equal(ledger.dir, dir)
  assert.equal(ledger.ledgerPath, path.join(dir, 'sessions.jsonl'))
  assert.equal(ledger.repliesDir, path.join(dir, 'replies'))
  assert.equal(ledger.replyPath(PLAN_ID), path.join(dir, 'replies', `${PLAN_ID}.md`))
  assert.throws(() => { ledger.ledgerPath = '/elsewhere' }, TypeError)
  assert.equal(ledger.ledgerPath, path.join(dir, 'sessions.jsonl'))
  assert.equal(createLedger(`${dir}/`).dir, dir, 'a trailing separator is dropped')
  assert.equal(existsSync(dir), false, 'creating a ledger creates nothing')
})

test('createLedger: replyPath rejects every id that is not 12 lowercase hex', async () => {
  const ledger = createLedger(path.join(TMP, 'ids'))
  for (const id of ['', 'abc', 'ABCDEF012345', 'abcdef01234', 'abcdef0123456', 'abcdef01234g', 'abcdef012345\n', ' abcdef012345',
    '../../../../etc', '0123456789ab/..', '..', '.', '0123456789ab.md', undefined, null, 123456789012, ['abcdef012345']]) {
    assert.throws(() => ledger.replyPath(id), /12 lowercase hex/, JSON.stringify(id))
    assert.throws(() => ledger.idInUse(id), /12 lowercase hex/, `idInUse ${JSON.stringify(id)}`)
    await assert.rejects(ledger.writeReply(id, 'x'), /12 lowercase hex/, `writeReply ${JSON.stringify(id)}`)
  }
  assert.equal(existsSync(ledger.dir), false, 'a rejected id creates no folder or file')
})

test('ledger: appendLedger writes exactly one 0600 line per call into a 0700 folder', async () => {
  const ledger = createLedger(path.join(TMP, 'append', 'state'))
  await ledger.appendLedger({ consult_id: 'a1', note: 'multi\nline\r\ntext' })
  await Promise.all(Array.from({ length: 20 }, (_, index) => ledger.appendLedger({ consult_id: `c${index}`, pad: 'x'.repeat(2000) })))
  const text = readFileSync(ledger.ledgerPath, 'utf8')
  assert.ok(text.endsWith('\n'))
  const lines = text.slice(0, -1).split('\n')
  assert.equal(lines.length, 21)
  assert.deepEqual(JSON.parse(lines[0]), { consult_id: 'a1', note: 'multi\nline\r\ntext' })
  assert.deepEqual(
    lines.slice(1).map((line) => JSON.parse(line).consult_id).sort(),
    Array.from({ length: 20 }, (_, index) => `c${index}`).sort(),
  )
  assert.equal(statSync(ledger.ledgerPath).mode & 0o777, 0o600)
  assert.equal(statSync(ledger.dir).mode & 0o777, 0o700)
  assert.equal(statSync(path.dirname(ledger.dir)).mode & 0o777, 0o700, 'missing parents are created 0700 too')
})

test('ledger: writeReply is exclusive, 0600 in a 0700 replies folder, and hashes the exact bytes', async () => {
  const ledger = createLedger(path.join(TMP, 'reply'))
  const text = '{\n  "plan": "h\u00e9llo \u2013 \u{1F680}"\n}\n'
  const reply = await ledger.writeReply(PLAN_ID, text)
  assert.deepEqual(Object.keys(reply).sort(), ['file', 'sha256'])
  assert.equal(reply.file, ledger.replyPath(PLAN_ID))
  assert.equal(reply.sha256, hash(text))
  assert.equal(reply.sha256, sha256(readFileSync(reply.file)))
  assert.equal(readFileSync(reply.file, 'utf8'), text)
  assert.equal(statSync(reply.file).mode & 0o777, 0o600)
  assert.equal(statSync(ledger.repliesDir).mode & 0o777, 0o700)
  assert.equal(statSync(ledger.dir).mode & 0o777, 0o700)
  await assert.rejects(ledger.writeReply(PLAN_ID, 'replacement'), { code: 'EEXIST' })
  assert.equal(readFileSync(reply.file, 'utf8'), text, 'the first reply is kept')
  assert.equal(fileSha256Sync(reply.file), reply.sha256)
  assert.equal(fileSha256Sync(path.join(ledger.repliesDir, 'missing.md')), undefined)
  assert.equal(existsSync(ledger.ledgerPath), false, 'a reply adds no ledger line')
})

test('ledger: ledgerEntriesFor and idInUse read the whole file each time and skip torn and foreign lines', async () => {
  const ledger = createLedger(path.join(TMP, 'entries'))
  assert.deepEqual(ledger.ledgerEntriesFor(PLAN_ID), [])
  assert.equal(ledger.idInUse(PLAN_ID), false)
  mkdirSync(ledger.dir, { recursive: true, mode: 0o700 }) // explicit modes: a writer runs below, under any umask
  writeFileSync(ledger.ledgerPath, [
    JSON.stringify({ consult_id: PLAN_ID, status: 'started' }),
    JSON.stringify({ consult_id: `${PLAN_ID}6`, status: 'ok' }),
    JSON.stringify({ consult_id: 'other', topic: `mentions ${PLAN_ID}` }),
    `{"consult_id":"${PLAN_ID}","status":"ok"`,
    `not json ${PLAN_ID}`,
    '',
    JSON.stringify({ consult_id: PLAN_ID, status: 'failed' }),
  ].join('\n'), { mode: 0o600 })
  assert.deepEqual(ledger.ledgerEntriesFor(PLAN_ID).map((entry) => entry.status), ['started', 'failed'])
  assert.deepEqual(ledger.ledgerEntriesFor(`${PLAN_ID}6`).map((entry) => entry.status), ['ok'])
  assert.deepEqual(ledger.ledgerEntriesFor(PLAN_ID.slice(0, 11)), [])
  assert.equal(ledger.idInUse(PLAN_ID), true)
  assert.equal(ledger.idInUse(PLAN_ID_B), false)
  await ledger.writeReply(PLAN_ID_B, 'reply')
  assert.equal(ledger.idInUse(PLAN_ID_B), true, 'a reply file alone marks the id as used')
  writeFileSync(ledger.ledgerPath, '')
  assert.deepEqual(ledger.ledgerEntriesFor(PLAN_ID), [], 'no cache: a rewritten file is read again')
})

test('ledger: recentLedger skips started and torn lines, labels plan and advice entries, and keeps the last runs', async () => {
  const ledger = createLedger(path.join(TMP, 'recent'))
  assert.equal(await ledger.recentLedger(), 'No consults recorded.')
  mkdirSync(ledger.dir, { recursive: true })
  writeFileSync(ledger.ledgerPath, `${JSON.stringify({ consult_id: 's1', advisor: 'dsh', kind: 'plan', status: 'started' })}\n`)
  assert.equal(await ledger.recentLedger(), 'No consults recorded.')
  writeFileSync(ledger.ledgerPath, [
    JSON.stringify({ consult_id: 'a0', advisor: 'dsh', kind: 'advice', status: 'ok', topic: 'first' }),
    JSON.stringify({ consult_id: 's1', advisor: 'dsh', kind: 'plan', status: 'started', topic: 'unset' }),
    JSON.stringify({ consult_id: 'c1', advisor: 'fable', status: 'ok', topic: 'review' }),
    '{"consult_id":"torn"',
    JSON.stringify({ consult_id: 'p1', advisor: 'dsh', kind: 'plan', status: 'ok', topic: 'unset' }),
    JSON.stringify({ consult_id: 'p2', advisor: 'dsh', kind: 'plan', status: 'started', topic: 'unset' }),
    JSON.stringify({ consult_id: 'p2', advisor: 'dsh', kind: 'plan', status: 'failed', topic: 'unset' }),
    '',
  ].join('\n'))
  assert.equal(await ledger.recentLedger(), ['c1 fable ok review', 'p1 dsh plan ok unset', 'p2 dsh plan failed unset'].join('\n'))
  assert.equal(await ledger.recentLedger(1), 'p2 dsh plan failed unset')
  assert.equal(await ledger.recentLedger(10), ['a0 dsh advice ok first', 'c1 fable ok review', 'p1 dsh plan ok unset', 'p2 dsh plan failed unset'].join('\n'))
})

// ---------------------------------------------------------------------------
// writableProblem: the synchronous, write-free probe run before advisor runs.

test('writableProblem: a writable folder, or one that can be created under a writable parent, has no problem; the probe writes nothing', async () => {
  const fresh = createLedger(path.join(TMP, 'probe-fresh', 'nested', 'data'))
  assert.equal(fresh.writableProblem(), undefined)
  assert.equal(existsSync(path.join(TMP, 'probe-fresh')), false, 'probing creates nothing')
  await fresh.appendLedger({ consult_id: PLAN_ID, status: 'started' })
  await fresh.writeReply(PLAN_ID, 'reply')
  assert.equal(fresh.writableProblem(), undefined, 'an existing 0700 folder with its ledger file and replies folder')
})

test('writableProblem: a regular file, /dev/null, a file parent, symlinks and wrong kinds are not writable', () => {
  const base = mkdtempSync(path.join(TMP, 'probe-'))
  const file = path.join(base, 'plain-file')
  writeFileSync(file, 'x')
  assert.equal(createLedger(file).writableProblem(), `not writable: ${file} is not a directory`)
  assert.equal(createLedger('/dev/null').writableProblem(), 'not writable: /dev/null is not a directory')
  assert.equal(createLedger(path.join(file, 'data')).writableProblem(), `not writable: ${file} is not a directory`, 'a file in the parent chain')

  const linked = createLedger(path.join(base, 'linked'))
  mkdirSync(linked.dir, { mode: 0o700 })
  const target = path.join(base, 'target.jsonl')
  writeFileSync(target, '')
  symlinkSync(target, linked.ledgerPath)
  assert.equal(linked.writableProblem(), `not writable: ${linked.ledgerPath} is a symbolic link`)
  rmSync(linked.ledgerPath)
  symlinkSync(path.join(base, 'missing.jsonl'), linked.ledgerPath)
  assert.equal(linked.writableProblem(), `not writable: ${linked.ledgerPath} is a symbolic link`, 'a dangling symlink too')
  rmSync(linked.ledgerPath)
  mkdirSync(linked.ledgerPath)
  assert.equal(linked.writableProblem(), `not writable: ${linked.ledgerPath} is not a regular file`)
  rmSync(linked.ledgerPath, { recursive: true })
  writeFileSync(linked.repliesDir, 'x')
  assert.equal(linked.writableProblem(), `not writable: ${linked.repliesDir} is not a directory`)
  rmSync(linked.repliesDir)
  symlinkSync(base, linked.repliesDir)
  assert.equal(linked.writableProblem(), `not writable: ${linked.repliesDir} is a symbolic link`)
  rmSync(linked.repliesDir)
  assert.equal(linked.writableProblem(), undefined)
})

test('writableProblem: a dangling symlink on the way up to a missing folder is reported, not left to fail at mkdir', async () => {
  const base = mkdtempSync(path.join(TMP, 'probe-dangling-'))
  const dangling = path.join(base, 'dangling')
  symlinkSync(path.join(base, 'missing-target'), dangling)
  for (const dir of [path.join(dangling, 'data'), path.join(dangling, 'x', 'y', 'data')]) {
    const ledger = createLedger(dir)
    assert.equal(ledger.writableProblem(), `not writable: ${dangling} is a symbolic link to a missing target`, dir)
    await assert.rejects(ledger.appendLedger({ consult_id: PLAN_ID, status: 'started' }), (error) => error instanceof Error, 'the writer fails as well')
  }
  assert.equal(existsSync(path.join(base, 'missing-target')), false, 'nothing was created through the link')
  assert.equal(createLedger(path.join(base, 'fine', 'data')).writableProblem(), undefined, 'an ordinary missing parent is still creatable')
})

test('assertUsable: a folder that vanished right after the writer\'s mkdir is a failure, not "can be created"', async (t) => {
  const realMkdir = fsPromises.mkdir
  t.after(() => { fsPromises.mkdir = realMkdir })
  const ledger = createLedger(path.join(mkdtempSync(path.join(TMP, 'vanish-')), 'data'))
  fsPromises.mkdir = async (target, ...rest) => {
    const made = await realMkdir(target, ...rest)
    rmSync(target, { recursive: true, force: true }) // gone again before the check
    return made
  }
  await assert.rejects(ledger.appendLedger({ consult_id: PLAN_ID, status: 'started' }), {
    message: `Advisor data directory is not writable: ${ledger.dir} vanished after it was created`,
  })
  await assert.rejects(ledger.writeReply(PLAN_ID, 'reply'), {
    message: `Advisor data directory is not writable: ${ledger.repliesDir} vanished after it was created`,
  })
  fsPromises.mkdir = realMkdir
  assert.equal(existsSync(ledger.ledgerPath), false)
  assert.equal(existsSync(ledger.replyPath(PLAN_ID)), false)
  assert.equal(ledger.writableProblem(), undefined, 'the plain probe still treats a missing folder as creatable')
  await ledger.appendLedger({ consult_id: PLAN_ID, status: 'started' })
  assert.equal(ledger.idInUse(PLAN_ID), true, 'and the next ordinary write works')
})

test('writableProblem: permission-denied folders and files are not writable; the ledger file must be readable too', { skip: ROOT && 'root ignores permission bits' }, async (t) => {
  const base = mkdtempSync(path.join(TMP, 'probe-perm-'))
  const locked = createLedger(path.join(base, 'locked'))
  mkdirSync(locked.dir, { mode: 0o700 })
  t.after(() => chmodSync(locked.dir, 0o700))
  chmodSync(locked.dir, 0o500)
  assert.equal(locked.writableProblem(), `not writable: ${locked.dir} denies writes (EACCES)`)
  assert.equal(createLedger(path.join(locked.dir, 'data')).writableProblem(), `not writable: ${path.join(locked.dir, 'data')} cannot be created in ${locked.dir} (EACCES)`)
  chmodSync(locked.dir, 0o700)

  writeFileSync(locked.ledgerPath, '', { mode: 0o400 })
  assert.equal(locked.writableProblem(), `not writable: ${locked.ledgerPath} denies reading or writing (EACCES)`, 'read-only')
  chmodSync(locked.ledgerPath, 0o200)
  assert.equal(locked.writableProblem(), `not writable: ${locked.ledgerPath} denies reading or writing (EACCES)`, 'write-only: the guards could not read it')
  await assert.rejects(locked.appendLedger({ consult_id: PLAN_ID, status: 'started' }), { message: `Advisor data directory is not writable: ${locked.ledgerPath} denies reading or writing (EACCES)` })
  assert.equal(statSync(locked.ledgerPath).size, 0, 'nothing appended to a ledger the guards cannot read')
  chmodSync(locked.ledgerPath, 0o600)
  assert.equal(locked.writableProblem(), undefined)
  rmSync(locked.ledgerPath)
  mkdirSync(locked.repliesDir, { mode: 0o500 })
  t.after(() => chmodSync(locked.repliesDir, 0o700))
  assert.equal(locked.writableProblem(), `not writable: ${locked.repliesDir} denies writes (EACCES)`)
})

test('writableProblem: a folder that group or others may write to is unsafe', { skip: !POSIX_OWNERS && 'no POSIX owners on this platform' }, (t) => {
  const ledger = createLedger(mkdtempSync(path.join(TMP, 'probe-mode-')))
  t.after(() => chmodSync(ledger.dir, 0o700))
  chmodSync(ledger.dir, 0o770)
  assert.equal(ledger.writableProblem(), `unsafe: ${ledger.dir} is writable by group or others (mode 0770)`)
  chmodSync(ledger.dir, 0o755)
  assert.equal(ledger.writableProblem(), undefined)
})

test('writers: an existing 0755 folder is written into as it is; the files stay 0600 and no mode is changed', { skip: !POSIX_OWNERS && 'no POSIX owners on this platform' }, async (t) => {
  const base = mkdtempSync(path.join(TMP, 'open-mode-'))
  const dir = path.join(base, 'data')
  mkdirSync(path.join(dir, REPLIES_DIR), { recursive: true, mode: 0o755 })
  chmodSync(dir, 0o755)
  chmodSync(path.join(dir, REPLIES_DIR), 0o755)
  t.after(() => { chmodSync(dir, 0o700); chmodSync(path.join(dir, REPLIES_DIR), 0o700) })
  const ledger = createLedger(dir)
  assert.equal(ledger.writableProblem(), undefined)
  await ledger.appendLedger({ consult_id: 'aaaaaaaaaaaa', status: 'started' })
  const { file } = await ledger.writeReply('aaaaaaaaaaaa', 'reply text\n')
  assert.equal(statSync(ledger.ledgerPath).mode & 0o777, 0o600)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(statSync(dir).mode & 0o777, 0o755)
  assert.equal(statSync(path.join(dir, REPLIES_DIR)).mode & 0o777, 0o755)
  assert.equal(ledger.writableProblem(), undefined)
})

test('appendLedger: never follows a symlinked ledger file, neither an existing one nor one planted after its own check', async (t) => {
  const base = mkdtempSync(path.join(TMP, 'nofollow-'))
  const ledger = createLedger(path.join(base, 'data'))
  mkdirSync(ledger.dir, { mode: 0o700 })
  const target = path.join(base, 'elsewhere.txt')
  writeFileSync(target, 'untouched\n')
  symlinkSync(target, ledger.ledgerPath)
  await assert.rejects(ledger.appendLedger({ consult_id: PLAN_ID, status: 'started' }), {
    message: `Advisor data directory is not writable: ${ledger.ledgerPath} is a symbolic link`,
  })
  rmSync(ledger.ledgerPath)
  // Planted between the writer's check and its open: O_NOFOLLOW refuses it.
  const realOpen = fsPromises.open
  t.after(() => { fsPromises.open = realOpen })
  fsPromises.open = (file, ...rest) => {
    if (file === ledger.ledgerPath) symlinkSync(target, ledger.ledgerPath)
    return realOpen(file, ...rest)
  }
  await assert.rejects(ledger.appendLedger({ consult_id: PLAN_ID, status: 'started' }), { code: 'ELOOP' })
  fsPromises.open = realOpen
  assert.equal(readFileSync(target, 'utf8'), 'untouched\n')
})

// ---------------------------------------------------------------------------
// Writers re-check the folder themselves (assertUsable after mkdir, before
// open/writeFile); symlink and owner rules for dataDir, sessions.jsonl and replies/.

/** Run fn while process.getuid reports a different user; always restored. */
async function asOtherUser(fn) {
  const realGetuid = process.getuid
  const real = realGetuid.call(process)
  const other = real + 1
  process.getuid = () => other
  try {
    return await fn({ real, other })
  } finally {
    process.getuid = realGetuid
  }
}

test('writers: a 0777 or foreign-owned directory appearing after the probe makes appendLedger and writeReply reject and write nothing', { skip: !POSIX_OWNERS && 'no POSIX owners on this platform' }, async (t) => {
  const ledger = createLedger(path.join(mkdtempSync(path.join(TMP, 'gap-')), 'data'))
  assert.equal(ledger.writableProblem(), undefined, 'probe: missing, but creatable')
  mkdirSync(ledger.dir) // created by someone else between the probe and the writer's mkdir
  chmodSync(ledger.dir, 0o777)
  t.after(() => chmodSync(ledger.dir, 0o700))
  const unsafe = `Advisor data directory is unsafe: ${ledger.dir} is writable by group or others (mode 0777)`
  await assert.rejects(ledger.appendLedger({ consult_id: PLAN_ID, status: 'started' }), { message: unsafe })
  assert.deepEqual(tree(ledger.dir), [], 'no ledger file')
  await assert.rejects(ledger.writeReply(PLAN_ID, 'reply'), { message: unsafe })
  assert.deepEqual(tree(ledger.dir), ['replies/'], 'only the folder its mkdir made before the check; no reply file')

  const foreign = createLedger(path.join(mkdtempSync(path.join(TMP, 'gap-owner-')), 'data'))
  assert.equal(foreign.writableProblem(), undefined)
  mkdirSync(foreign.dir, { mode: 0o700 })
  await asOtherUser(async ({ real, other }) => {
    const owned = `Advisor data directory is unsafe: ${foreign.dir} belongs to another user (uid ${real}, this process runs as ${other})`
    await assert.rejects(foreign.appendLedger({ consult_id: PLAN_ID, status: 'started' }), { message: owned })
    await assert.rejects(foreign.writeReply(PLAN_ID, 'reply'), { message: owned })
  })
  assert.deepEqual(tree(foreign.dir), ['replies/'], 'no file was written into the foreign folder')
})

test('writers: a symlinked replies/ planted after the probe makes writeReply reject; nothing lands in its target', async () => {
  const ledger = createLedger(mkdtempSync(path.join(TMP, 'replies-link-')))
  assert.equal(ledger.writableProblem(), undefined)
  const elsewhere = mkdtempSync(path.join(TMP, 'replies-target-'))
  symlinkSync(elsewhere, ledger.repliesDir)
  const linked = `Advisor data directory is not writable: ${ledger.repliesDir} is a symbolic link`
  await assert.rejects(ledger.writeReply(PLAN_ID, 'reply'), { message: linked })
  await assert.rejects(ledger.appendLedger({ consult_id: PLAN_ID, status: 'started' }), { message: linked }, 'the whole folder is refused')
  assert.deepEqual(tree(elsewhere), [])
  assert.equal(existsSync(ledger.ledgerPath), false)
})

test('writers: a symlinked dataDir owned by this user works; its target is judged like any folder', async (t) => {
  const base = mkdtempSync(path.join(TMP, 'link-ok-'))
  const real = path.join(base, 'real')
  mkdirSync(real, { mode: 0o700 })
  const link = path.join(base, 'link')
  symlinkSync(real, link)
  const ledger = createLedger(link)
  assert.equal(ledger.writableProblem(), undefined)
  await ledger.appendLedger({ consult_id: PLAN_ID, status: 'started' })
  const reply = await ledger.writeReply(PLAN_ID, 'reply')
  assert.equal(reply.file, path.join(link, 'replies', `${PLAN_ID}.md`))
  assert.deepEqual(tree(real), ['replies/', `replies/${PLAN_ID}.md`, 'sessions.jsonl'], 'the files land in the link target')
  assert.equal(ledger.idInUse(PLAN_ID), true)

  const dangling = path.join(base, 'dangling')
  symlinkSync(path.join(base, 'missing'), dangling)
  assert.equal(createLedger(dangling).writableProblem(), `not writable: ${dangling} is a symbolic link to a missing target`)
  if (POSIX_OWNERS) {
    t.after(() => chmodSync(real, 0o700))
    chmodSync(real, 0o777)
    assert.equal(ledger.writableProblem(), `unsafe: ${link} is writable by group or others (mode 0777)`, 'the target is judged')
    await assert.rejects(ledger.appendLedger({ consult_id: PLAN_ID_B, status: 'started' }), /is writable by group or others/)
  }
})

test('writers: a symlinked dataDir owned by another uid is refused', { skip: (!POSIX_OWNERS || ROOT) && 'needs POSIX owners and a non-root user' }, async () => {
  const base = mkdtempSync(path.join(TMP, 'link-foreign-'))
  const real = path.join(base, 'real')
  mkdirSync(real, { mode: 0o700 })
  const link = path.join(base, 'link')
  symlinkSync(real, link)
  const ledger = createLedger(link)
  await asOtherUser(async ({ real: uid, other }) => {
    const problem = `unsafe: ${link} is a symbolic link owned by another user (uid ${uid}, this process runs as ${other})`
    assert.equal(ledger.writableProblem(), problem, 'the link owner is checked before its target')
    await assert.rejects(ledger.appendLedger({ consult_id: PLAN_ID, status: 'started' }), { message: `Advisor data directory is ${problem}` })
    await assert.rejects(ledger.writeReply(PLAN_ID, 'reply'), { message: `Advisor data directory is ${problem}` })
  })
  assert.equal(existsSync(path.join(real, 'sessions.jsonl')), false)
  assert.equal(existsSync(path.join(real, 'replies', `${PLAN_ID}.md`)), false)
  assert.equal(ledger.writableProblem(), undefined, 'restored: the link is this user\'s again')
})

test('writableProblem: an existing foreign-writable sessions.jsonl or replies/ is refused, and the writers reject', { skip: !POSIX_OWNERS && 'no POSIX owners on this platform' }, async (t) => {
  const ledger = createLedger(mkdtempSync(path.join(TMP, 'entries-mode-')))
  await ledger.appendLedger({ consult_id: PLAN_ID, status: 'started' })
  t.after(() => chmodSync(ledger.ledgerPath, 0o600))
  for (const mode of [0o666, 0o620, 0o602]) {
    chmodSync(ledger.ledgerPath, mode)
    const problem = `unsafe: ${ledger.ledgerPath} is writable by group or others (mode 0${mode.toString(8)})`
    assert.equal(ledger.writableProblem(), problem)
    await assert.rejects(ledger.appendLedger({ consult_id: PLAN_ID_B, status: 'started' }), { message: `Advisor data directory is ${problem}` })
  }
  chmodSync(ledger.ledgerPath, 0o644)
  assert.equal(ledger.writableProblem(), undefined, 'readable by others is fine')
  assert.equal(readFileSync(ledger.ledgerPath, 'utf8').split('\n').filter(Boolean).length, 1, 'no line was added')

  mkdirSync(ledger.repliesDir, { mode: 0o700 })
  t.after(() => chmodSync(ledger.repliesDir, 0o700))
  for (const mode of [0o777, 0o770, 0o703]) {
    chmodSync(ledger.repliesDir, mode)
    const problem = `unsafe: ${ledger.repliesDir} is writable by group or others (mode 0${mode.toString(8)})`
    assert.equal(ledger.writableProblem(), problem)
    await assert.rejects(ledger.writeReply(PLAN_ID, 'reply'), { message: `Advisor data directory is ${problem}` })
  }
  assert.deepEqual(readdirSync(ledger.repliesDir), [], 'no reply was written')
  chmodSync(ledger.repliesDir, 0o755)
  assert.equal(ledger.writableProblem(), undefined)
  await asOtherUser(async ({ real, other }) => {
    assert.equal(ledger.writableProblem(), `unsafe: ${ledger.dir} belongs to another user (uid ${real}, this process runs as ${other})`, 'the folder owner is checked first')
  })
})

test('writers: first-run creation still works and yields 0700 folders and 0600 files', async () => {
  const base = mkdtempSync(path.join(TMP, 'first-run-'))
  const ledger = createLedger(path.join(base, 'a', 'b', 'data'))
  assert.equal(ledger.writableProblem(), undefined)
  await ledger.appendLedger({ consult_id: PLAN_ID, status: 'started' })
  const reply = await ledger.writeReply(PLAN_ID, 'reply')
  for (const dir of [path.join(base, 'a'), path.join(base, 'a', 'b'), ledger.dir, ledger.repliesDir]) {
    assert.equal(statSync(dir).mode & 0o777, 0o700, dir)
  }
  assert.equal(statSync(ledger.ledgerPath).mode & 0o777, 0o600)
  assert.equal(statSync(reply.file).mode & 0o777, 0o600)
  assert.equal(ledger.writableProblem(), undefined, 'what the plugin creates passes its own probe')
  assert.deepEqual(tree(ledger.dir), ['replies/', `replies/${PLAN_ID}.md`, 'sessions.jsonl'])
})

// ---------------------------------------------------------------------------
// Short appends: a fragment never swallows the next line.

/** Make the next file handles' writes misbehave: `first` replaces the first write, `next` the later ones. */
function patchWrites(t, { first, next }) {
  const realOpen = fsPromises.open
  t.after(() => { fsPromises.open = realOpen })
  const calls = []
  fsPromises.open = async (...args) => {
    const handle = await realOpen(...args)
    const write = handle.write.bind(handle)
    let count = 0
    handle.write = (buffer, ...rest) => {
      calls.push(buffer.length)
      count++
      if (count === 1 && first) return first(write, buffer, ...rest)
      if (count > 1 && next) return next(write, buffer, ...rest)
      return write(buffer, ...rest)
    }
    return handle
  }
  return { calls, restore: () => { fsPromises.open = realOpen } }
}

test('appendLedger: a short write is ended with a newline and still fails; the next line stays whole', async (t) => {
  const ledger = createLedger(path.join(TMP, 'short-newline'))
  const torn = { consult_id: 'torn-one', pad: 'x'.repeat(500) }
  const patch = patchWrites(t, { first: (write, buffer) => write(buffer.subarray(0, 40)) })
  await assert.rejects(ledger.appendLedger(torn), { message: 'short ledger append' })
  patch.restore()
  assert.deepEqual(patch.calls, [JSON.stringify(torn).length + 1, 1], 'one short write, then one newline')
  await ledger.appendLedger({ consult_id: PLAN_ID, status: 'started' })
  const lines = readFileSync(ledger.ledgerPath, 'utf8').split('\n')
  assert.deepEqual(lines, [JSON.stringify(torn).slice(0, 40), JSON.stringify({ consult_id: PLAN_ID, status: 'started' }), ''])
  assert.equal(ledger.idInUse(PLAN_ID), true)
  assert.deepEqual(ledger.ledgerEntriesFor(PLAN_ID).map((entry) => entry.status), ['started'])
})

test('appendLedger: when even the newline fails, the next whole line glued to the fragment is still read', async (t) => {
  const ledger = createLedger(path.join(TMP, 'short-glued'))
  const patch = patchWrites(t, {
    first: (write, buffer) => write(buffer.subarray(0, 64)),
    next: () => Promise.reject(Object.assign(new Error('EFBIG: file too large'), { code: 'EFBIG' })),
  })
  await assert.rejects(ledger.appendLedger({ consult_id: 'torn-two', pad: 'y'.repeat(500) }), { message: 'short ledger append' })
  patch.restore()
  assert.equal(ledger.idInUse(PLAN_ID), false)
  await ledger.appendLedger({ consult_id: PLAN_ID, kind: 'plan', advisor: 'dsh', status: 'started', topic: 'unset' })
  await ledger.appendLedger({ consult_id: PLAN_ID, kind: 'plan', advisor: 'dsh', status: 'ok', topic: 'glued' })
  const lines = readFileSync(ledger.ledgerPath, 'utf8').split('\n')
  assert.equal(lines.length, 3, 'the started line is glued behind the fragment')
  assert.throws(() => JSON.parse(lines[0]))
  assert.equal(ledger.idInUse(PLAN_ID), true)
  assert.deepEqual(ledger.ledgerEntriesFor(PLAN_ID).map((entry) => entry.status), ['started', 'ok'])
  assert.equal(await ledger.recentLedger(), `${PLAN_ID} dsh plan ok glued`)
})

test('ledger: readers recover a whole line behind any fragment, nested objects included, and skip fragments alone', async () => {
  const ledger = createLedger(path.join(TMP, 'glued-lines'))
  mkdirSync(ledger.dir, { recursive: true })
  const started = JSON.stringify({ consult_id: PLAN_ID, kind: 'plan', advisor: 'dsh', status: 'started', topic: 'unset' })
  const ok = JSON.stringify({ consult_id: PLAN_ID, kind: 'plan', advisor: 'dsh', status: 'ok', topic: 'glued' })
  const nested = JSON.stringify({ consult_id: PLAN_ID_B, advisor: 'cli', status: 'ok', topic: 'nested', usage: { input: 1, detail: { cached: 2 } } })
  writeFileSync(ledger.ledgerPath, [
    `{"consult_id":"torn-a","pad":"${'x'.repeat(300)}${started}`,
    `{"consult_id":"torn-b","note":{"a":"x${ok}`,
    `{"consult_id":"tor${nested}`,
    '{"consult_id":"torn-only","note":{"a":',
    `{"consult_id":"other","topic":"mentions ${PLAN_ID}"}`,
    '',
  ].join('\n'))
  assert.deepEqual(ledger.ledgerEntriesFor(PLAN_ID).map((entry) => entry.status), ['started', 'ok'])
  assert.equal(ledger.idInUse(PLAN_ID), true)
  assert.deepEqual(ledger.ledgerEntriesFor(PLAN_ID_B), [JSON.parse(nested)])
  assert.equal(await ledger.recentLedger(), [`${PLAN_ID} dsh plan ok glued`, `${PLAN_ID_B} cli ok nested`, 'other unknown unknown mentions abcdef012345'].join('\n'))
})

// ---------------------------------------------------------------------------
// Cross-process: separate Node processes sharing one dataDir.

const padSize = (seq) => (seq % 25 === 0 ? 70_000 : seq % 5 === 0 ? 9_000 + seq * 13 : 100 + (seq % 7) * 50)

const WORKER = path.join(TMP, 'ledger-worker.mjs')
writeFileSync(WORKER, `import { once } from 'node:events'
import { createLedger } from ${JSON.stringify(pathToFileURL(path.join(SRC, 'ledger.js')).href)}

const padSize = ${padSize.toString()}
const [mode, dir, ...rest] = process.argv.slice(2)
const ledger = createLedger(dir)
process.stdout.write('ready\\n')
await once(process.stdin, 'data') // barrier: every worker starts writing together
process.stdin.destroy()
if (mode === 'append') {
  const count = Number(rest[0])
  for (let seq = 0; seq < count; seq += 8) {
    // Eight appends in flight per process as well as across processes.
    await Promise.all(Array.from({ length: Math.min(8, count - seq) }, (_, offset) => ledger.appendLedger({
      consult_id: 'cross-process', pid: process.pid, seq: seq + offset, pad: 'x'.repeat(padSize(seq + offset)),
    })))
  }
} else if (mode === 'reply') {
  const results = []
  for (const id of rest) {
    try {
      const { file, sha256 } = await ledger.writeReply(id, \`reply from \${process.pid} for \${id}\\n\`)
      results.push({ id, ok: true, file, sha256 })
    } catch (error) {
      results.push({ id, ok: false, code: error.code })
    }
  }
  process.stdout.write(\`\${JSON.stringify(results)}\\n\`)
} else if (mode === 'started') {
  await ledger.appendLedger({ consult_id: rest[0], kind: 'plan', advisor: 'dsh', status: 'started', pid: process.pid })
} else if (mode === 'big') {
  try {
    await ledger.appendLedger({ consult_id: 'too-big', pad: 'z'.repeat(100_000) })
    process.stdout.write(\`\${JSON.stringify({ ok: true })}\\n\`)
  } catch (error) {
    process.stdout.write(\`\${JSON.stringify({ error: error.message })}\\n\`)
  }
} else {
  throw new Error(\`unknown mode \${mode}\`)
}
`)

/** Decoy locations a stray default would write to; each test checks they stay empty. */
function decoys(label) {
  const root = path.join(TMP, `decoys-${label}`)
  const env = {
    HOME: path.join(root, 'home'),
    XDG_STATE_HOME: path.join(root, 'xdg-state'),
    DSH_HOME: path.join(root, 'dsh-home'),
    ADVISOR_LEDGER: path.join(root, 'advisor-ledger', 'sessions.jsonl'),
  }
  for (const dir of [env.HOME, env.XDG_STATE_HOME, env.DSH_HOME, path.dirname(env.ADVISOR_LEDGER)]) mkdirSync(dir, { recursive: true })
  return { root, env, assertEmpty: () => assert.deepEqual(tree(root), ['advisor-ledger/', 'dsh-home/', 'home/', 'xdg-state/'], 'decoys stay empty') }
}

/**
 * Spawn workers, release them together once all are ready, and collect their exits.
 * A spec is the worker's argv, or { argv, fileSizeBlocks } to run it under
 * `ulimit -f` with SIGXFSZ ignored, so writes past the limit come back short.
 */
async function runWorkers(t, specs, env) {
  const childEnv = { ...process.env, ...env }
  delete childEnv.NODE_TEST_CONTEXT // plain scripts, not test files
  const workers = specs.map((spec) => {
    const argv = Array.isArray(spec) ? spec : spec.argv
    const child = Array.isArray(spec)
      ? spawn(process.execPath, [WORKER, ...argv], { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv })
      : spawn('/bin/sh', ['-c', `ulimit -f ${Number(spec.fileSizeBlocks)} && trap '' XFSZ && exec "$0" "$@"`, process.execPath, WORKER, ...argv], {
        stdio: ['pipe', 'pipe', 'pipe'], env: childEnv,
      })
    const worker = { child, pid: child.pid, stdout: '', stderr: '' }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { worker.stderr += chunk })
    worker.exit = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })))
    worker.ready = new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => {
        worker.stdout += chunk
        if (worker.stdout.startsWith('ready\n')) resolve()
      })
      worker.exit.then(({ code }) => reject(new Error(`worker exited (${code}) before it was ready: ${worker.stderr}`)))
    })
    return worker
  })
  t.after(() => { for (const { child } of workers) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  await Promise.all(workers.map((worker) => worker.ready))
  for (const { child } of workers) child.stdin.end('go\n')
  for (const worker of workers) {
    const { code, signal } = await worker.exit
    assert.equal(code, 0, `worker ${worker.pid} exited with ${code ?? signal}: ${worker.stderr}`)
    worker.output = worker.stdout.slice('ready\n'.length)
  }
  return workers
}

test('cross-process: 4 processes appending 200 lines each (some over 8 KB) leave 800 intact lines, each (pid, seq) once', { timeout: 120_000 }, async (t) => {
  const box = decoys('append')
  const dir = path.join(TMP, 'shared-append')
  const workers = await runWorkers(t, Array.from({ length: 4 }, () => ['append', dir, '200']), box.env)
  const text = readFileSync(path.join(dir, 'sessions.jsonl'), 'utf8')
  assert.ok(text.endsWith('\n'), 'the file ends with a complete line')
  const lines = text.slice(0, -1).split('\n')
  assert.equal(lines.length, 4 * 200)
  const seen = new Set()
  for (const [index, line] of lines.entries()) {
    let entry
    assert.doesNotThrow(() => { entry = JSON.parse(line) }, `line ${index + 1} parses (${line.length} chars)`)
    assert.equal(entry.consult_id, 'cross-process')
    assert.equal(entry.pad, 'x'.repeat(padSize(entry.seq)), `line ${index + 1} is whole`)
    const key = `${entry.pid}:${entry.seq}`
    assert.equal(seen.has(key), false, `${key} appears once`)
    seen.add(key)
  }
  for (const { pid } of workers) {
    for (let seq = 0; seq < 200; seq++) assert.ok(seen.has(`${pid}:${seq}`), `${pid}:${seq} is present`)
  }
  assert.equal(seen.size, 800)
  const large = lines.filter((line) => Buffer.byteLength(line) > 8 * 1024).length
  assert.equal(large, 4 * 40, 'each process wrote 40 lines over 8 KB')
  assert.ok(lines.some((line) => Buffer.byteLength(line) > 64 * 1024), 'some lines exceed 64 KB')
  assert.equal(statSync(path.join(dir, 'sessions.jsonl')).mode & 0o777, 0o600)
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.deepEqual(tree(dir), ['sessions.jsonl'])
  box.assertEmpty()
})

test('cross-process: two processes racing writeReply on one id: one wins, the other gets EEXIST', { timeout: 60_000 }, async (t) => {
  const box = decoys('reply')
  const dir = path.join(TMP, 'shared-replies')
  const ids = Array.from({ length: 16 }, (_, index) => `${index.toString(16).padStart(2, '0')}${'a1b2c3d4e5'}`)
  const workers = await runWorkers(t, [['reply', dir, ...ids], ['reply', dir, ...ids]], box.env)
  const [first, second] = workers.map((worker) => JSON.parse(worker.output))
  const ledger = createLedger(dir)
  for (const [index, id] of ids.entries()) {
    const outcomes = [first[index], second[index]]
    assert.deepEqual(outcomes.map((outcome) => outcome.id), [id, id])
    const winners = outcomes.filter((outcome) => outcome.ok)
    const losers = outcomes.filter((outcome) => !outcome.ok)
    assert.equal(winners.length, 1, `${id}: exactly one winner`)
    assert.deepEqual(losers.map((outcome) => outcome.code), ['EEXIST'], `${id}: the other gets EEXIST`)
    const [winner] = winners
    const winnerPid = workers[outcomes.indexOf(winner)].pid
    assert.equal(winner.file, ledger.replyPath(id))
    assert.equal(readFileSync(winner.file, 'utf8'), `reply from ${winnerPid} for ${id}\n`, `${id}: the winner's bytes`)
    assert.equal(winner.sha256, sha256(readFileSync(winner.file)))
    assert.equal(statSync(winner.file).mode & 0o777, 0o600)
  }
  assert.deepEqual(tree(dir), ['replies/', ...ids.map((id) => `replies/${id}.md`)].sort())
  assert.equal(statSync(path.join(dir, 'replies')).mode & 0o777, 0o700)
  box.assertEmpty()
})

test('cross-process: a started line appended by one ledger instance makes idInUse true in another at once', { timeout: 60_000 }, async (t) => {
  const dir = path.join(TMP, 'visibility')
  const writer = createLedger(dir)
  const reader = createLedger(dir)
  assert.notEqual(writer, reader)
  assert.equal(reader.idInUse(PLAN_ID), false)
  await writer.appendLedger({ consult_id: PLAN_ID, kind: 'plan', advisor: 'dsh', status: 'started' })
  assert.equal(reader.idInUse(PLAN_ID), true, 'the next synchronous read sees it; nothing is cached')
  assert.deepEqual(reader.ledgerEntriesFor(PLAN_ID).map((entry) => entry.status), ['started'])

  const box = decoys('started')
  assert.equal(reader.idInUse(PLAN_ID_B), false)
  const [worker] = await runWorkers(t, [['started', dir, PLAN_ID_B]], box.env)
  assert.equal(reader.idInUse(PLAN_ID_B), true, 'a line from another process is visible as soon as it exits')
  assert.deepEqual(reader.ledgerEntriesFor(PLAN_ID_B).map((entry) => [entry.status, entry.pid]), [['started', worker.pid]])
  assert.equal(writer.idInUse(PLAN_ID_B), true)
  box.assertEmpty()
})

test('cross-process: a size-limited process leaves an unterminated fragment; a started line from another process is still found', {
  timeout: 60_000, skip: process.platform === 'win32' && 'needs /bin/sh and ulimit',
}, async (t) => {
  const box = decoys('short-write')
  const dir = path.join(TMP, 'short-write')
  // ulimit -f 64: the 100 KB append is cut short and the newline then fails with EFBIG.
  const [limited] = await runWorkers(t, [{ argv: ['big', dir], fileSizeBlocks: 64 }], box.env)
  assert.deepEqual(JSON.parse(limited.output), { error: 'short ledger append' })
  const ledgerFile = path.join(dir, 'sessions.jsonl')
  const fragment = statSync(ledgerFile).size
  assert.ok(fragment > 0 && fragment < 100_000, `a fragment of ${fragment} bytes is left`)
  const reader = createLedger(dir)
  assert.equal(reader.idInUse(PLAN_ID), false)

  const [writer] = await runWorkers(t, [['started', dir, PLAN_ID]], box.env)
  const lines = readFileSync(ledgerFile, 'utf8').split('\n')
  assert.equal(lines.length, 2, 'the started line was glued behind the unterminated fragment')
  assert.equal(lines[0].length, fragment + JSON.stringify({ consult_id: PLAN_ID, kind: 'plan', advisor: 'dsh', status: 'started', pid: writer.pid }).length)
  assert.throws(() => JSON.parse(lines[0]), 'the merged physical line does not parse as a whole')
  assert.equal(reader.idInUse(PLAN_ID), true, 'idInUse still sees the started line')
  assert.deepEqual(reader.ledgerEntriesFor(PLAN_ID).map((entry) => [entry.status, entry.pid]), [['started', writer.pid]])
  box.assertEmpty()
})
