// Tests for src/guard.js, the pure compatibility guard of the host entry.
// Run: node --test packages/session-search-patched/test/guard.test.mjs   (Node 24)
//
// HOME, DSH_HOME and the XDG roots of this process are decoys that must stay empty.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { installDecoys } from './helpers/decoys.mjs'

const decoys = installDecoys('guard')
after(() => decoys.restore())

const guard = await import('../src/guard.js').catch((error) => {
  decoys.restore()
  throw error
})
const {
  checkHost, checkScope, describeError, ENGINE_PACKAGE, formatLine, isProviderClash,
  ISOLATED_SCOPE, LOG_PREFIX, PINNED_SOURCES, PINNED_VERSION, PINNED_VERSIONS,
} = guard

const PKG = path.resolve(import.meta.dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(PKG, ...parts), 'utf8')
const RC3 = Object.freeze({ ...PINNED_SOURCES })
const okInput = () => ({ version: '0.2.2-rc.3', sources: { ...RC3 } })
const other = (hex) => hex.replace(/^./, (c) => (c === '0' ? '1' : '0'))

test('pinned values equal the spike evidence (decision table and guard-inputs.txt)', () => {
  assert.deepEqual([...PINNED_VERSIONS], ['0.2.2-rc.3', '0.2.2-rc.5'])
  assert.equal(ENGINE_PACKAGE, '@deepseek-ai/dsh-session-query-sqlite')
  assert.equal(ISOLATED_SCOPE, 'sessionQuery#optional-session-search')
  assert.equal(LOG_PREFIX, 'session-search-patched:')

  const evidence = read('docs', 'spike', 'guard-inputs.txt')
  const seen = {}
  for (const match of evidence.matchAll(/"(src\/[a-z]+\.ts)": \{\s*"bytes": \d+,\s*"sha256": "([0-9a-f]{64})"/g)) seen[match[1]] = match[2]
  assert.deepEqual(seen, { ...PINNED_SOURCES }, 'the guard pins exactly the three src files the probe hashed inside app.asar')
  assert.match(evidence, /"packageOfEngine": "0\.2\.2-rc\.3"/)
  assert.match(evidence, /"sessionQuery": "sessionQuery#optional-session-search"/)

  const doc = read('docs', 'composition-spike.md')
  assert.ok(doc.includes("ctx.get('pluginPackages')?.packageOf('@deepseek-ai/dsh-session-query-sqlite', import.meta.url)?.version"))
  assert.ok(doc.includes("ctx[Symbol.for('cordis.isolate')]?.sessionQuery?.description"))
  assert.ok(doc.includes(`'${ISOLATED_SCOPE}'`))
  assert.ok(Object.isFrozen(PINNED_SOURCES), 'the pinned table cannot be changed at run time')
  assert.throws(() => { PINNED_SOURCES['src/index.ts'] = 'x' }, TypeError)
})

test('checkHost: the pinned version with matching source hashes passes', () => {
  const result = checkHost(okInput())
  assert.equal(result.ok, true)
  assert.match(result.reason, /0\.2\.2-rc\.3/)
  assert.match(result.reason, /src\/index\.ts/)
  assert.ok(Object.isFrozen(result))
})

test('checkHost: both pinned host versions pass with the pinned sources', () => {
  for (const version of ['0.2.2-rc.3', '0.2.2-rc.5']) {
    const result = checkHost({ version, sources: { ...RC3 } })
    assert.equal(result.ok, true, `${version}: ${result.reason}`)
    assert.match(result.reason, new RegExp(`host @deepseek-ai/dsh-session-query-sqlite ${version.replace(/\./g, '\\.')}`))
  }
})

test('checkHost: every version other than a pinned string fails', () => {
  const cases = [
    ['0.2.2-rc.4', /0\.2\.2-rc\.4.*not one of the pinned/],
    ['0.2.2-rc.6', /not one of the pinned/],
    ['0.2.3', /not one of the pinned/],
    ['0.2.2', /not one of the pinned/],
    ['0.2.2-rc.3 ', /not one of the pinned/],
    [' 0.2.2-rc.3', /not one of the pinned/],
    ['v0.2.2-rc.3', /not one of the pinned/],
    ['0.2.2-RC.3', /not one of the pinned/],
    ['', /unknown/],
    [undefined, /unknown/],
    [null, /unknown/],
    [32, /unknown/],
    [{ error: 'the pluginPackages service is not available' }, /unknown.*pluginPackages service is not available/],
    [new String('0.2.2-rc.3'), /unknown/],
    [{ toString: () => '0.2.2-rc.3' }, /unknown/],
    [['0.2.2-rc.3'], /unknown/],
  ]
  for (const [version, reason] of cases) {
    const result = checkHost({ ...okInput(), version })
    assert.equal(result.ok, false, `version ${String(version)} must fail`)
    assert.match(result.reason, /^compatibility guard failed: /)
    assert.match(result.reason, reason)
    assert.ok(!result.reason.includes('\n'))
  }
})

test('checkHost: a missing, unreadable or different source hash fails', () => {
  const cases = [
    [{ ...RC3, 'src/query.ts': other(RC3['src/query.ts']) }, /src\/query\.ts sha256 .* is not the pinned/],
    [{ ...RC3, 'src/index.ts': RC3['src/index.ts'].toUpperCase() }, /src\/index\.ts sha256/],
    [{ ...RC3, 'src/schema.ts': undefined }, /src\/schema\.ts unreadable/],
    [{ 'src/index.ts': RC3['src/index.ts'], 'src/query.ts': RC3['src/query.ts'] }, /src\/schema\.ts unreadable/],
    [{ ...RC3, 'src/index.ts': { error: 'ERR_MODULE_NOT_FOUND: no such package' } }, /src\/index\.ts unreadable \(ERR_MODULE_NOT_FOUND: no such package\)/],
    [{ error: 'readShippedSources failed' }, /unreadable \(readShippedSources failed\)/],
    [undefined, /src\/index\.ts unreadable/],
    [null, /unreadable/],
    ['72868e4a', /unreadable/],
    [Object.assign(Object.create({ ...RC3 }), {}), /unreadable/],
  ]
  for (const [sources, reason] of cases) {
    const result = checkHost({ version: '0.2.2-rc.3', sources })
    assert.equal(result.ok, false, `sources ${JSON.stringify(sources)} must fail`)
    assert.match(result.reason, reason)
  }
  const both = checkHost({ version: '0.2.2-rc.4', sources: { ...RC3, 'src/index.ts': other(RC3['src/index.ts']) } })
  assert.equal(both.ok, false)
  assert.match(both.reason, /0\.2\.2-rc\.4/, 'every failed input is named')
  assert.match(both.reason, /src\/index\.ts sha256/)
  const extra = checkHost({ version: '0.2.2-rc.3', sources: { ...RC3, 'lib/index.js': 'anything' } })
  assert.equal(extra.ok, true, 'files the guard does not pin are ignored')
})

test('checkHost: no extra key, polluted prototype or odd input can switch the guard off', () => {
  const bypassKeys = { ok: true, force: true, bypass: true, skipGuard: true, guard: false, compatible: true, enabled: true, allowAnyVersion: true }
  const mismatch = checkHost({ version: '0.2.2-rc.4', sources: { ...RC3 }, ...bypassKeys })
  assert.equal(mismatch.ok, false)
  const noHash = checkHost({ version: '0.2.2-rc.3', sources: {}, ...bypassKeys })
  assert.equal(noHash.ok, false)

  const inherited = checkHost(Object.create(okInput()))
  assert.equal(inherited.ok, false, 'inherited properties are not inputs')

  Object.prototype.version = '0.2.2-rc.3'
  for (const [file, hex] of Object.entries(RC3)) Object.prototype[file] = hex
  try {
    assert.equal(checkHost({}).ok, false, 'a polluted Object.prototype is not an input')
    assert.equal(checkHost({ sources: {} }).ok, false)
  } finally {
    delete Object.prototype.version
    for (const file of Object.keys(RC3)) delete Object.prototype[file]
  }

  for (const input of [undefined, null, 'version=0.2.2-rc.3', 42, [], () => okInput(), Symbol('x')]) {
    assert.equal(checkHost(input).ok, false)
  }
  const hostile = {
    get version() { throw new Error('getter exploded') },
    sources: { ...RC3 },
  }
  const result = checkHost(hostile)
  assert.equal(result.ok, false)
  assert.match(result.reason, /getter exploded/)
  const proxy = new Proxy({}, { get() { throw new Error('proxy trap') }, has() { throw new Error('proxy trap') }, getOwnPropertyDescriptor() { throw new Error('proxy trap') } })
  assert.equal(checkHost(proxy).ok, false)
  assert.equal(checkHost(proxy).ok, false)
})

test('checkHost is pure: same answer every time, the input is not changed, no I/O or environment in the module', () => {
  const input = okInput()
  const frozen = Object.freeze({ version: input.version, sources: Object.freeze({ ...input.sources }) })
  const first = checkHost(frozen)
  for (let i = 0; i < 5; i++) assert.deepEqual(checkHost(frozen), first)
  assert.equal(checkHost.length, 1)
  for (const key of ['SESSION_SEARCH_PATCHED_FORCE', 'SESSION_SEARCH_PATCHED_SKIP_GUARD', 'DSH_SESSION_SEARCH_PATCHED']) process.env[key] = '1'
  try {
    assert.equal(checkHost({ version: '0.2.2-rc.4', sources: { ...RC3 } }).ok, false, 'environment variables change nothing')
  } finally {
    for (const key of ['SESSION_SEARCH_PATCHED_FORCE', 'SESSION_SEARCH_PATCHED_SKIP_GUARD', 'DSH_SESSION_SEARCH_PATCHED']) delete process.env[key]
  }

  const source = read('src', 'guard.js')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /^\s*import\b/m, 'guard.js imports nothing')
  assert.doesNotMatch(code, /\bimport\s*\(/, 'no dynamic import')
  assert.doesNotMatch(code, /\brequire\s*\(/)
  for (const word of ['process', 'globalThis', 'Date', 'Math.random', 'fetch', 'console', 'setTimeout', 'Buffer', 'import.meta']) {
    assert.ok(!code.includes(word), `guard.js code does not use ${word}`)
  }
})

test('checkScope: only the isolated scope label of the session-search group passes', () => {
  const okResult = checkScope('sessionQuery#optional-session-search')
  assert.equal(okResult.ok, true)
  assert.ok(Object.isFrozen(okResult))
  for (const description of ['sessionQuery', 'sessionQuery#other-group', 'sessionQuery#optional-session-search ', '', undefined, null, 7, Symbol('sessionQuery#optional-session-search')]) {
    const result = checkScope(description)
    assert.equal(result.ok, false, `scope ${String(description)} must fail`)
    assert.match(result.reason, /not inside the isolated sessionQuery scope sessionQuery#optional-session-search/)
    assert.match(result.reason, /nothing is mounted/)
    assert.ok(!result.reason.includes('\n'))
  }
  assert.match(checkScope('sessionQuery').reason, /found: "sessionQuery"/)
  assert.match(checkScope(undefined).reason, /found: none/)
})

test('isProviderClash: recognises the cordis error of a second sessionQuery provider in one scope', () => {
  const ctx = new Context()
  ctx.provide('sessionQuery', { first: true })
  let clash
  try {
    ctx.provide('sessionQuery', { second: true })
  } catch (error) {
    clash = error
  }
  assert.ok(clash instanceof Error, 'cordis throws on the second provider (reflect.ts:303-305)')
  assert.equal(isProviderClash(clash), true)
  assert.equal(isProviderClash(new Error('service "sessions" has been registered at <x>')), false, 'only sessionQuery counts')
  assert.equal(isProviderClash(new Error('boom')), false)
  assert.equal(isProviderClash(undefined), false)
  assert.equal(isProviderClash(null), false)
  assert.equal(isProviderClash({ get message() { throw new Error('no') } }), false)
})

test('describeError and formatLine always give one bounded line', () => {
  const coded = Object.assign(new Error('Cannot find module x'), { code: 'ERR_MODULE_NOT_FOUND' })
  assert.equal(describeError(coded), 'ERR_MODULE_NOT_FOUND: Cannot find module x')
  assert.equal(describeError(new Error('invalid config:\n  - a\n  - b')), 'invalid config: | - a | - b')
  assert.equal(describeError('plain text'), 'plain text')
  assert.equal(describeError(undefined), 'undefined')
  assert.equal(describeError(Symbol('s')), 'Symbol(s)')
  assert.equal(describeError(Object.create(null)), 'an unreadable error')
  assert.equal(describeError({ get message() { throw new Error('x') } }), 'an unreadable error')
  assert.ok(describeError(new Error('x'.repeat(5000))).length <= 600)

  const line = formatLine('patched FakeEngine', 'first\nsecond')
  assert.equal(line, 'session-search-patched: active engine: patched FakeEngine; reason: first | second')
  assert.ok(formatLine('x', 'y'.repeat(10000)).length < 2200)
  assert.ok(!formatLine('a\nb', 'c\r\nd').includes('\n'))
  assert.ok(formatLine(undefined, undefined).startsWith(LOG_PREFIX))
})

test('no process.env in the files of the host entry (index.host.js, guard.js, host/)', () => {
  const files = ['src/index.host.js', 'src/guard.js']
  const hostDir = path.join(PKG, 'src', 'host')
  if (fs.existsSync(hostDir)) for (const name of fs.readdirSync(hostDir, { recursive: true })) files.push(path.join('src', 'host', String(name)))
  for (const file of files) {
    const full = path.join(PKG, file)
    if (!fs.statSync(full).isFile()) continue
    assert.ok(!fs.readFileSync(full, 'utf8').includes('process.env'), `${file} has no process.env`)
  }
})

test('the decoy HOME, DSH_HOME and XDG folders stayed empty', () => {
  assert.equal(process.env.HOME, decoys.folders.HOME)
  assert.equal(process.env.DSH_HOME, decoys.folders.DSH_HOME)
  assert.deepEqual(decoys.touched(), [])
})
