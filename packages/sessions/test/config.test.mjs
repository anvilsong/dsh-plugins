// Tests for src/config.js, src/paths.js and cordis.patch.yml. Every file
// system case lives in a mkdtemp folder under os.tmpdir(); HOME and DSH_HOME
// are decoys that must stay empty.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CONFIG_KEYS, ConfigError, DEFAULTS, RANGES, resolveConfig } from '../src/config.js'
import { ERROR } from '../src/contract.js'
import { PathError, SESSION_ID, assertDisjoint, assertInside, sameDevice, sessionFolderOf } from '../src/paths.js'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratch = mkdtempSync(path.join(os.tmpdir(), 'sessions-config-'))
const decoyHome = path.join(scratch, 'decoy-home')
const decoyDshHome = path.join(scratch, 'decoy-dsh')
mkdirSync(decoyHome)
mkdirSync(decoyDshHome)
const savedEnv = { HOME: process.env.HOME, DSH_HOME: process.env.DSH_HOME }
process.env.HOME = decoyHome
process.env.DSH_HOME = decoyDshHome

after(() => {
  assert.deepEqual(readdirSync(decoyHome), [])
  assert.deepEqual(readdirSync(decoyDshHome), [])
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(scratch, { recursive: true, force: true })
})

const HOME = '/dsh/home'
const code = (value) => (error) => error?.code === value

test('the patch has one sessions-manager row whose config equals the defaults', () => {
  const text = readFileSync(path.join(packageRoot, 'cordis.patch.yml'), 'utf8')
  const rows = text.match(/^\s*- id: /gm) ?? []
  assert.equal(rows.length, 1)
  assert.match(text, /^- insert:$/m)
  assert.match(text, /- id: sessions-manager$/m)
  assert.match(text, /name: dsh-plugin-sessions$/m)
  assert.match(text, /^\s+dataDir: !!js dshHomePath\('sessions-manager'\)$/m)
  assert.match(text, /trashDir/) // documented ...
  assert.doesNotMatch(text, /^\s+trashDir:/m) // ... but not set
  const configBlock = text.slice(text.indexOf('config:')).split('\n').slice(1).filter((line) => line.trim() !== '')
  const keys = configBlock.map((line) => line.trim().split(':')[0])
  assert.deepEqual(keys, [...CONFIG_KEYS])
  for (const [key, expected] of Object.entries(DEFAULTS)) {
    const line = configBlock.find((entry) => entry.trim().startsWith(`${key}:`))
    assert.equal(line.trim(), `${key}: ${expected}`, key)
  }
  assert.equal(DEFAULTS.largeSessionBytes, 50 * 1024 * 1024)
  assert.equal(DEFAULTS.indexWarnBytes, 256 * 1024 * 1024)
})

test('resolveConfig: defaults, derived paths and a frozen result', () => {
  const config = resolveConfig({}, { home: HOME, platform: 'linux' })
  assert.ok(Object.isFrozen(config))
  assert.equal(config.dataDir, '/dsh/home/sessions-manager')
  assert.equal(config.trashDir, '/dsh/home/sessions-manager/trash')
  assert.equal(config.trashDirConfigured, false)
  for (const [key, expected] of Object.entries(DEFAULTS)) assert.equal(config[key], expected, key)
  assert.deepEqual(resolveConfig(undefined, { home: HOME }), resolveConfig(null, { home: HOME }))
  assert.throws(() => { config.listLimit = 1 }, TypeError)
})

test('resolveConfig: configured paths win and the trash default follows dataDir', () => {
  const config = resolveConfig({ dataDir: '/var/data/sm/', trashDir: '/var/trash' }, { platform: 'linux' })
  assert.equal(config.dataDir, '/var/data/sm')
  assert.equal(config.trashDir, '/var/trash')
  assert.equal(config.trashDirConfigured, true)
  assert.equal(resolveConfig({ dataDir: '/var/data/sm' }, { platform: 'linux' }).trashDir, '/var/data/sm/trash')
})

test('resolveConfig: numbers are clamped to their ranges', () => {
  const low = resolveConfig({
    recentActivityMinutes: 0, listLimit: -5, largeSessionBytes: 1, indexWarnBytes: 0, refreshMs: 100, planTtlMinutes: 0, snapshotTtlMs: -1,
  }, { home: HOME })
  assert.equal(low.recentActivityMinutes, RANGES.recentActivityMinutes.min)
  assert.equal(low.listLimit, RANGES.listLimit.min)
  assert.equal(low.largeSessionBytes, RANGES.largeSessionBytes.min)
  assert.equal(low.indexWarnBytes, RANGES.indexWarnBytes.min)
  assert.equal(low.refreshMs, 5_000)
  assert.equal(low.planTtlMinutes, 1)
  assert.equal(low.snapshotTtlMs, 0)
  const high = resolveConfig({
    recentActivityMinutes: 1e9, listLimit: 1e9, largeSessionBytes: 1e18, indexWarnBytes: 1e18, refreshMs: 1e12, planTtlMinutes: 1e6, snapshotTtlMs: 1e9,
  }, { home: HOME })
  for (const key of Object.keys(RANGES)) assert.equal(high[key], RANGES[key].max, key)
  assert.equal(resolveConfig({ refreshMs: 0 }, { home: HOME }).refreshMs, 0)
  assert.equal(resolveConfig({ refreshMs: 60_000.4 }, { home: HOME }).refreshMs, 60_000)
  assert.equal(resolveConfig({ listLimit: '200' }, { home: HOME }).listLimit, 200)
  for (const bad of [NaN, Infinity, 'many', '', '  ', {}, [], true, null, undefined]) {
    assert.equal(resolveConfig({ listLimit: bad }, { home: HOME }).listLimit, DEFAULTS.listLimit, String(bad))
  }
})

test('resolveConfig: allowPermanentDelete accepts only booleans', () => {
  assert.equal(resolveConfig({ allowPermanentDelete: false }, { home: HOME }).allowPermanentDelete, false)
  assert.equal(resolveConfig({ allowPermanentDelete: true }, { home: HOME }).allowPermanentDelete, true)
  for (const bad of ['false', 0, 1, null, {}]) {
    assert.throws(() => resolveConfig({ allowPermanentDelete: bad }, { home: HOME }), (error) => error instanceof ConfigError && error.field === 'allowPermanentDelete')
  }
})

test('resolveConfig: an invalid path throws a typed error and never falls back', () => {
  const invalid = [
    '', '   ', 5, null, {}, 'relative/dir', '~/sessions', '/', '/a/../b', '/a/./b', '/a//b', '/a/b//', ' /a', '/a ', '/a\nb', '/a\u0000b', '/a\u0085b',
    '/a\u202eb', '/a\u200fb', '/a\u2066b', '/a\u2028b', '/a`b', '/a\tb',
  ]
  for (const field of ['dataDir', 'trashDir']) {
    for (const value of invalid) {
      assert.throws(
        () => resolveConfig({ dataDir: '/ok/data', [field]: value }, { home: HOME, platform: 'linux' }),
        (error) => error instanceof ConfigError && error.field === field && error.code === 'invalid-config',
        `${field}=${JSON.stringify(value)}`,
      )
    }
  }
})

test('resolveConfig: Windows path rules', () => {
  const win = (raw) => resolveConfig(raw, { platform: 'win32', home: 'C:\\dsh' })
  assert.equal(win({}).dataDir, 'C:\\dsh\\sessions-manager')
  assert.equal(win({ dataDir: 'D:\\data' }).dataDir, 'D:\\data')
  for (const bad of ['C:\\', '\\data', 'C:data', 'D:\\a\\..\\b', 'data']) {
    assert.throws(() => win({ dataDir: bad }), ConfigError, bad)
  }
})

test('resolveConfig: an unusable home gives a typed error, not a guess', () => {
  for (const home of [undefined, '', 'relative', '/a/../b', '/', 5, '/x\ny']) {
    assert.throws(() => resolveConfig({}, { home, platform: 'linux' }), (error) => error instanceof ConfigError && error.field === 'dataDir', String(home))
  }
  assert.throws(() => resolveConfig({}), ConfigError)
  // the home is never read from the process: decoy env values are not used
  assert.throws(() => resolveConfig({}, {}), ConfigError)
})

test('SESSION_ID accepts one path segment only', () => {
  for (const id of ['s0001', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'abc.def_1', '0']) assert.match(id, SESSION_ID)
  for (const id of ['', '.', '..', '.hidden', '-x', 'a/b', 'a\\b', 'a b', 'a\u0000b', 'a\nb', 'x'.repeat(129), '../x']) assert.doesNotMatch(id, SESSION_ID, JSON.stringify(id))
})

test('sessionFolderOf returns the folder only when it is named like the id', () => {
  assert.equal(sessionFolderOf('/store/2026/s0001/session.jsonl.gz', 's0001'), '/store/2026/s0001')
  assert.equal(sessionFolderOf('/store/s0001/events.log', 's0001'), '/store/s0001')
  assert.equal(sessionFolderOf('/store/2026/s0002/session.jsonl.gz', 's0001'), null)
  assert.equal(sessionFolderOf('/store/2026/session.jsonl.gz', 's0001'), null)
  assert.equal(sessionFolderOf('/s0001/log', 's0001'), null)
  assert.equal(sessionFolderOf('/store/s0001/log', '../s0001'), null)
  assert.equal(sessionFolderOf('/store/../s0001/log', 's0001'), null)
  assert.equal(sessionFolderOf('/store/a/../s0001/log', 's0001'), null)
  assert.equal(sessionFolderOf('store/s0001/log', 's0001'), null)
  assert.equal(sessionFolderOf(undefined, 's0001'), null)
  assert.equal(sessionFolderOf('/store/s0001/log', undefined), null)
  assert.equal(sessionFolderOf('/store/.hidden/log', '.hidden'), null)
})

const tree = (name) => {
  const root = path.join(scratch, name)
  mkdirSync(root, { recursive: true })
  return root
}

test('assertInside: accepts real descendants and returns the real path', async () => {
  const root = tree('inside-ok')
  mkdirSync(path.join(root, 'a', 's0001'), { recursive: true })
  writeFileSync(path.join(root, 'a', 's0001', 'log'), 'x')
  const real = await assertInside(root, path.join(root, 'a', 's0001'))
  assert.match(real, /s0001$/)
  await assertInside(root, path.join(root, 'a', 's0001', 'log'))
  await assertInside(root, root)
  // a symlinked root (or ancestor) is the reference, not an error
  const link = path.join(scratch, 'inside-ok-link')
  symlinkSync(root, link)
  await assertInside(link, path.join(link, 'a', 's0001'))
})

test('assertInside: rejects outside targets, symlinked components and missing paths', async () => {
  const root = tree('inside-bad')
  const outside = tree('inside-outside')
  mkdirSync(path.join(root, 'real', 's0001'), { recursive: true })
  mkdirSync(path.join(outside, 's0009'), { recursive: true })
  symlinkSync(outside, path.join(root, 'linked'))
  symlinkSync(path.join(root, 'real'), path.join(root, 'alias'))
  symlinkSync(path.join(outside, 's0009'), path.join(root, 'real', 's0002'))
  const rejects = (target, options) => assert.rejects(assertInside(root, target, options), (error) => error instanceof PathError && error.code === 'path-unsafe', target)
  await rejects(outside)
  await rejects(path.join(root, '..', 'inside-outside'))
  await rejects(`${root}-sibling`)
  await rejects(path.join(root, 'linked'))
  await rejects(path.join(root, 'linked', 's0009'))
  await rejects(path.join(root, 'alias', 's0001')) // a symlink to a folder inside the root is still a symlinked component
  await rejects(path.join(root, 'real', 's0002'))
  await rejects(path.join(root, 'real', 'missing'))
  await rejects('relative/path')
  await rejects(path.join(root, 'real', 'a\0b'))
  await assert.rejects(assertInside(path.join(root, 'nope'), path.join(root, 'nope', 'x')), PathError)
  // a missing tail below a clean parent is allowed only on request
  const projected = await assertInside(root, path.join(root, 'real', 'new', 'deeper'), { allowMissing: true })
  assert.match(projected, /real[\\/]new[\\/]deeper$/)
  await assert.rejects(assertInside(root, path.join(root, 'linked', 'new'), { allowMissing: true }), PathError)
})

test('assertDisjoint: rejects overlap in both directions, equality and symlinks', async () => {
  const base = tree('disjoint')
  const store = path.join(base, 'sessions')
  const trash = path.join(base, 'trash')
  mkdirSync(store)
  mkdirSync(trash)
  await assertDisjoint(store, trash)
  await assertDisjoint(store, path.join(base, 'not-yet', 'trash')) // a missing folder is judged by its parent
  const rejects = (a, b) => assert.rejects(assertDisjoint(a, b), (error) => error instanceof PathError && error.code === ERROR.trashUnusable, `${a} | ${b}`)
  await rejects(store, path.join(store, 'trash'))
  await rejects(store, path.join(store, 'a', 'b', 'trash')) // not yet created, inside the tree
  await rejects(store, store)
  await rejects(trash, trash)
  await rejects(path.join(trash, 'store'), trash) // the store inside the trash
  await rejects(base, trash) // trash inside the store
  // symlinks cannot hide an overlap
  symlinkSync(store, path.join(base, 'store-link'))
  await rejects(store, path.join(base, 'store-link', 'trash'))
  symlinkSync(path.join(store, 'inner'), path.join(base, 'dangling'))
  mkdirSync(path.join(store, 'inner'))
  await rejects(store, path.join(base, 'dangling'))
  await rejects('relative', trash)
  await rejects(store, 'relative')
  // a prefix that is not a parent is fine
  mkdirSync(path.join(base, 'sessions-old'))
  await assertDisjoint(store, path.join(base, 'sessions-old'))
})

test('sameDevice compares stat.dev through an injected stat', async () => {
  const stats = { '/a': { dev: 1 }, '/b': { dev: 1 }, '/c': { dev: 2 }, '/big1': { dev: 10n }, '/big2': { dev: 10n }, '/odd': {}, '/odd2': { dev: undefined } }
  const stat = async (target) => {
    if (!(target in stats)) throw Object.assign(new Error('no such file'), { code: 'ENOENT' })
    return stats[target]
  }
  assert.equal(await sameDevice('/a', '/b', stat), true)
  assert.equal(await sameDevice('/a', '/c', stat), false)
  assert.equal(await sameDevice('/big1', '/big2', stat), true)
  assert.equal(await sameDevice('/a', '/big1', stat), false)
  assert.equal(await sameDevice('/a', '/missing', stat), false)
  assert.equal(await sameDevice('/odd', '/odd2', stat), false)
  // the default stat works on real folders
  const dir = tree('device')
  assert.equal(await sameDevice(dir, scratch), true)
  assert.equal(await sameDevice(dir, path.join(dir, 'missing')), false)
})

test('the modules read no environment variable and no home directory', () => {
  for (const file of ['config.js', 'paths.js']) {
    const text = readFileSync(path.join(packageRoot, 'src', file), 'utf8')
    assert.doesNotMatch(text, /process\.env|homedir/, file)
  }
})
