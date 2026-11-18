// Contract tests for dsh-plugin-sessions: package metadata, names, frozen
// code lists, the five response validators (positive and negative cases),
// and the deterministic fake HostFacts every engine test builds on.
// Nothing here touches the real DSH home or session store.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import * as contract from '../src/contract.js'
import {
  applyResultFixture, archivedPageFixture, createFakeHostFacts, overviewFixture, planFixture, purgeResultFixture,
  trashListFixture, unarchiveResultFixture,
} from './helpers/fixtures.mjs'

const {
  ERROR_CODES, LOCALE_NS, METHODS, NAMESPACE, PACKAGE, REFUSAL_CODES, assertApplyResult, assertArchivedPage,
  assertOverview, assertPlan, assertPurgeResult, assertRequest, assertTrashList, assertUnarchiveResult,
} = contract

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'))

test('package.json and locale files follow the router layout', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.name, 'dsh-plugin-sessions')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'src/index.host.js')
  assert.deepEqual(Object.keys(pkg.exports), ['.', './client', './cordis.patch.yml', './locale/*.json', './icon', './package.json'])
  assert.deepEqual(pkg.exports['.'], { default: './src/index.host.js' })
  assert.deepEqual(pkg.exports['./client'], { default: './src/client.js' })
  assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml')
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  assert.equal(pkg.exports['./icon'], './icon.svg')
  assert.equal(pkg.exports['./package.json'], './package.json')
  assert.deepEqual(pkg.dsh.bundle, { patch: './cordis.patch.yml' })
  assert.equal(pkg.dsh.client.platform, 'web')
  // The gateway (Remote mount) plus the two packages that own the page slots (docs/placement.md).
  assert.deepEqual([...pkg.dsh.client.inject].sort(), [
    '@deepseek-ai/dsh-api-gateway',
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-sidebar',
  ])
  assert.deepEqual(pkg.dependencies, { '@deepseek-ai/dsh-typert-protocol': '0.2.2-rc.3' })
  assert.deepEqual(Object.keys(pkg.peerDependencies), ['@deepseek-ai/cordis'])
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0)
  for (const entry of pkg.files) assert.ok(!/^(test|docs)(\/|$)/.test(entry), `files lists ${entry}`)
  assert.equal(pkg.license, 'MIT')
  assert.equal(statSync(join(root, 'LICENSE')).isFile(), true)
  assert.equal(statSync(join(root, 'icon.svg')).isFile(), true)

  const locales = readdirSync(join(root, 'locale')).sort()
  assert.deepEqual(locales, ['en.json', 'zh.json'])
  for (const file of locales) {
    const data = readJson(`locale/${file}`)
    assert.deepEqual(Object.keys(data), ['meta'])
    assert.deepEqual(Object.keys(data.meta), ['title', 'description'])
    for (const value of Object.values(data.meta)) assert.ok(typeof value === 'string' && value.length > 0)
  }
})

test('names and Remote methods are frozen', () => {
  assert.equal(NAMESPACE, 'sessionsManager')
  assert.equal(LOCALE_NS, 'sessionsManager')
  assert.notEqual(NAMESPACE, 'sessions')
  assert.equal(PACKAGE, 'dsh-plugin-sessions')
  assert.deepEqual(Object.keys(METHODS), ['overview', 'archived', 'plan', 'apply', 'unarchive', 'trash', 'restore', 'purge'])
  assert.ok(Object.isFrozen(METHODS))
  for (const [name, method] of Object.entries(METHODS)) {
    assert.ok(Object.isFrozen(method), name)
    assert.equal(method.name, name)
    assert.equal(method.unary, true)
    assert.deepEqual([...method.params], ['request'])
    assert.ok(Object.isFrozen(method.params), name)
  }
  assert.deepEqual(contract.METHOD_NAMES, Object.keys(METHODS))
})

test('refusal and error codes are frozen and complete', () => {
  assert.deepEqual([...REFUSAL_CODES], [
    'live', 'locked', 'recent', 'kept-descendant', 'parent-kept', 'cycle', 'path-unsafe', 'no-location', 'changed',
    'not-archived', 'cross-device', 'workspace-missing', 'conflict', 'legacy-format',
  ])
  assert.ok(Object.isFrozen(REFUSAL_CODES))
  assert.deepEqual([...ERROR_CODES], [
    'sessions-manager/forbidden', 'sessions-manager/busy', 'sessions-manager/plan-expired',
    'sessions-manager/confirmation-mismatch', 'sessions-manager/purge-disabled', 'sessions-manager/unsupported-backend',
    'sessions-manager/unsupported-platform', 'sessions-manager/trash-unusable', 'sessions-manager/batch-not-found', 'sessions-manager/invalid-request',
    'sessions-manager/store-unreadable',
  ])
  assert.ok(Object.isFrozen(ERROR_CODES))
  assert.throws(() => { REFUSAL_CODES.push('x') }, TypeError)
  assert.throws(() => { ERROR_CODES.push('x') }, TypeError)
  assert.equal(contract.ERROR.planExpired, 'sessions-manager/plan-expired')
  assert.equal(contract.ERROR.storeUnreadable, 'sessions-manager/store-unreadable')
  for (const code of Object.values(contract.ERROR)) assert.ok(ERROR_CODES.includes(code))
})

const validators = [
  ['assertOverview', assertOverview, overviewFixture],
  ['assertArchivedPage', assertArchivedPage, archivedPageFixture],
  ['assertPlan', assertPlan, planFixture],
  ['assertApplyResult', assertApplyResult, applyResultFixture],
  ['assertTrashList', assertTrashList, trashListFixture],
  ['assertUnarchiveResult', assertUnarchiveResult, unarchiveResultFixture],
  ['assertPurgeResult', assertPurgeResult, purgeResultFixture],
]

for (const [name, assertFn, make] of validators) {
  test(`${name}: accepts the fixture and rejects unknown keys, missing keys and wrong types`, () => {
    const good = make()
    assert.doesNotThrow(() => assertFn(good))
    assert.equal(assertFn(make()), undefined)

    assert.throws(() => assertFn(null), /expected an object/)
    assert.throws(() => assertFn([]), /expected an object/)
    assert.throws(() => assertFn('x'), /expected an object/)

    const extra = make()
    extra.surprise = 1
    assert.throws(() => assertFn(extra), /unknown key "surprise"/)

    const keys = Object.keys(make())
    for (const key of keys) {
      const missing = make()
      delete missing[key]
      assert.throws(() => assertFn(missing), new RegExp(`missing key "${key}"`), `missing ${key}`)

      const wrong = make()
      wrong[key] = Symbol.for('wrong')
      assert.throws(() => assertFn(wrong), TypeError, `wrong type ${key}`)
    }
  })
}

// Mutates a deep path of a fresh fixture and expects a rejection that names the path.
const rejects = (assertFn, make, mutate, pattern) => {
  const dto = make()
  mutate(dto)
  assert.throws(() => assertFn(dto), pattern)
}

test('assertOverview: nested negative cases', () => {
  rejects(assertOverview, overviewFixture, (d) => { d.capabilities.extra = true }, /capabilities: unknown key "extra"/)
  rejects(assertOverview, overviewFixture, (d) => { d.config.extra = true }, /config: unknown key "extra"/)
  rejects(assertOverview, overviewFixture, (d) => { d.config.allowPermanentDelete = 'yes' }, /config\.allowPermanentDelete: expected a boolean/)
  rejects(assertOverview, overviewFixture, (d) => { d.config.refreshMs = -1 }, /config\.refreshMs: expected a non-negative integer/)
  rejects(assertOverview, overviewFixture, (d) => { d.config.indexWarnBytes = 1.5 }, /config\.indexWarnBytes/)
  rejects(assertOverview, overviewFixture, (d) => { d.capabilities.prune = 1 }, /capabilities\.prune: expected a boolean/)
  rejects(assertOverview, overviewFixture, (d) => { d.capabilities.prune = true; d.capabilities.reason = 'sessions-manager/trash-unusable' }, /reason must be null when prune is true/)
  rejects(assertOverview, overviewFixture, (d) => { d.capabilities.prune = false; d.capabilities.reason = null }, /reason is required when prune is false/)
  rejects(assertOverview, overviewFixture, (d) => { d.capabilities.prune = false; d.capabilities.reason = 'nope' }, /capabilities\.reason/)
  rejects(assertOverview, overviewFixture, (d) => { d.totals.sessions = '3' }, /totals\.sessions: expected a non-negative integer/)
  // archivedMissing: archived ids of the registry without a stored log (an integer, always present).
  assert.equal(overviewFixture().totals.archivedMissing, 1)
  rejects(assertOverview, overviewFixture, (d) => { delete d.totals.archivedMissing }, /totals: missing key "archivedMissing"/)
  rejects(assertOverview, overviewFixture, (d) => { d.totals.archivedMissing = -1 }, /totals\.archivedMissing: expected a non-negative integer/)
  rejects(assertOverview, overviewFixture, (d) => { d.totals.archivedMissing = 1.5 }, /totals\.archivedMissing: expected a non-negative integer/)
  rejects(assertOverview, overviewFixture, (d) => { d.totals.archivedMissing = null }, /totals\.archivedMissing: expected a non-negative integer/)
  rejects(assertOverview, overviewFixture, (d) => { d.workspaces[0].bytes = null }, /workspaces\[0\]\.bytes/)
  rejects(assertOverview, overviewFixture, (d) => { d.workspaces[0].title = 'x' }, /workspaces\[0\]: unknown key "title"/)
  rejects(assertOverview, overviewFixture, (d) => { d.largest[0].title = 5 }, /largest\[0\]\.title: expected a string or null/)
  rejects(assertOverview, overviewFixture, (d) => { d.largest[0].body = 'text' }, /largest\[0\]: unknown key "body"/)
  rejects(assertOverview, overviewFixture, (d) => { d.indexLoad = 'extreme' }, /indexLoad/)
  assert.doesNotThrow(() => assertOverview({ ...overviewFixture(), largest: overviewFixture().largest.map((r) => ({ ...r, title: null })) }))
  assert.equal(overviewFixture().largest.length <= 10, true)
  rejects(assertOverview, overviewFixture, (d) => { d.largest = Array.from({ length: 11 }, () => d.largest[0]) }, /largest: at most 10 rows/)
})

test('assertArchivedPage: nested negative cases', () => {
  rejects(assertArchivedPage, archivedPageFixture, (d) => { d.rows[0].extra = 1 }, /rows\[0\]: unknown key "extra"/)
  rejects(assertArchivedPage, archivedPageFixture, (d) => { d.rows[0].bytes = '10' }, /rows\[0\]\.bytes: expected a non-negative integer/)
  rejects(assertArchivedPage, archivedPageFixture, (d) => { d.rows[0].blocked = 'no' }, /rows\[0\]\.blocked: expected a boolean/)
  rejects(assertArchivedPage, archivedPageFixture, (d) => { d.rows[0].title = 12 }, /rows\[0\]\.title/)
  rejects(assertArchivedPage, archivedPageFixture, (d) => { d.rows[0].id = '' }, /rows\[0\]\.id: expected a non-empty string/)
  rejects(assertArchivedPage, archivedPageFixture, (d) => { d.rows[0].blocked = true; d.rows[0].reasons = [] }, /blocked rows need at least one reason/)
  rejects(assertArchivedPage, archivedPageFixture, (d) => { d.rows[0].blocked = false; d.rows[0].reasons = [{ code: 'live', sessionId: 'x' }] }, /unblocked rows have no reasons/)
  rejects(assertArchivedPage, archivedPageFixture, (d) => { d.rows[0].reasons = [{ code: 'bogus', sessionId: 'x' }]; d.rows[0].blocked = true }, /reasons\[0\]\.code/)
  rejects(assertArchivedPage, archivedPageFixture, (d) => { d.rows[0].reasons = [{ code: 'live' }]; d.rows[0].blocked = true }, /missing key "sessionId"/)
  rejects(assertArchivedPage, archivedPageFixture, (d) => { d.total = -1 }, /total/)
  rejects(assertArchivedPage, archivedPageFixture, (d) => { d.rows = 'none' }, /rows: expected an array/)
})

test('assertPlan: nested negative cases and invariants', () => {
  rejects(assertPlan, planFixture, (d) => { d.planId = 7 }, /planId: expected a non-empty string/)
  rejects(assertPlan, planFixture, (d) => { d.expiresAt = 'soon' }, /expiresAt: expected a non-negative integer/)
  rejects(assertPlan, planFixture, (d) => { d.digest = '' }, /digest: expected a non-empty string/)
  rejects(assertPlan, planFixture, (d) => { d.units[0].extra = 1 }, /units\[0\]: unknown key "extra"/)
  rejects(assertPlan, planFixture, (d) => { delete d.units[0].memberIds }, /units\[0\]: missing key "memberIds"/)
  rejects(assertPlan, planFixture, (d) => { d.units[0].memberIds = [1] }, /units\[0\]\.memberIds\[0\]/)
  rejects(assertPlan, planFixture, (d) => { d.units[0].memberIds = d.units[0].memberIds.filter((id) => id !== d.units[0].rootId) }, /memberIds must include rootId/)
  rejects(assertPlan, planFixture, (d) => { d.units[0].status = 'maybe' }, /units\[0\]\.status/)
  rejects(assertPlan, planFixture, (d) => { d.units[0].workspaceId = 4 }, /units\[0\]\.workspaceId: expected a string or null/)
  rejects(assertPlan, planFixture, (d) => { d.units[0].reasons = [{ code: 'live', sessionId: 'x' }] }, /ready units have no reasons/)
  const blockedIndex = (d) => d.units.findIndex((u) => u.status === 'blocked')
  rejects(assertPlan, planFixture, (d) => { d.units[blockedIndex(d)].reasons = [] }, /blocked units need at least one reason/)
  rejects(assertPlan, planFixture, (d) => { d.units[blockedIndex(d)].reasons[0].code = 'nope' }, /reasons\[0\]\.code/)
  rejects(assertPlan, planFixture, (d) => { d.units[blockedIndex(d)].reasons[0].extra = 1 }, /reasons\[0\]: unknown key "extra"/)
  rejects(assertPlan, planFixture, (d) => { d.totals.extra = 1 }, /totals: unknown key "extra"/)
  rejects(assertPlan, planFixture, (d) => { d.totals.bytes = 'big' }, /totals\.bytes/)
  rejects(assertPlan, planFixture, (d) => { d.byWorkspace[0].workspaceId = 3 }, /byWorkspace\[0\]\.workspaceId/)
  rejects(assertPlan, planFixture, (d) => { d.byWorkspace[0].path = '/x' }, /byWorkspace\[0\]: unknown key "path"/)
  rejects(assertPlan, planFixture, (d) => { d.totals.readySessions += 1 }, /totals\.readySessions does not match the units/)
  rejects(assertPlan, planFixture, (d) => { d.totals.units += 1 }, /totals\.units does not match the units/)
})

test('assertApplyResult: nested negative cases', () => {
  rejects(assertApplyResult, applyResultFixture, (d) => { d.moved.extra = 1 }, /moved: unknown key "extra"/)
  rejects(assertApplyResult, applyResultFixture, (d) => { d.moved.sessions = '3' }, /moved\.sessions/)
  rejects(assertApplyResult, applyResultFixture, (d) => { d.state = 'done' }, /state/)
  rejects(assertApplyResult, applyResultFixture, (d) => { d.skipped[0].reasons[0].code = 'bogus' }, /skipped\[0\]\.reasons\[0\]\.code/)
  rejects(assertApplyResult, applyResultFixture, (d) => { d.skipped[0].reasons = [] }, /skipped\[0\]\.reasons: at least one reason is required/)
  rejects(assertApplyResult, applyResultFixture, (d) => { d.warnings[0].code = 5 }, /warnings\[0\]\.code/)
  rejects(assertApplyResult, applyResultFixture, (d) => { d.warnings[0].message = 'text' }, /warnings\[0\]: unknown key "message"/)
  rejects(assertApplyResult, applyResultFixture, (d) => { d.batchId = 4 }, /batchId: expected a batch id/)
  rejects(assertApplyResult, applyResultFixture, (d) => { d.trashDir = null }, /trashDir/)
})

test('assertTrashList: nested negative cases', () => {
  rejects(assertTrashList, trashListFixture, (d) => { d.batches[0].state = 'weird' }, /batches\[0\]\.state/)
  rejects(assertTrashList, trashListFixture, (d) => { d.batches[0].extra = 1 }, /batches\[0\]: unknown key "extra"/)
  rejects(assertTrashList, trashListFixture, (d) => { d.batches[0].bytes = -4 }, /batches\[0\]\.bytes/)
  rejects(assertTrashList, trashListFixture, (d) => { d.batches[0].createdAt = null }, /batches\[0\]\.createdAt/)
  rejects(assertTrashList, trashListFixture, (d) => { d.batches[0].batchId = 3 }, /batches\[0\]\.batchId/)
  rejects(assertTrashList, trashListFixture, (d) => { d.trashDir = '' }, /trashDir/)
  rejects(assertTrashList, trashListFixture, (d) => { d.batches = {} }, /batches: expected an array/)
})

test('assertUnarchiveResult and assertPurgeResult: nested negative cases', () => {
  rejects(assertUnarchiveResult, unarchiveResultFixture, (d) => { d.unarchived = [3] }, /unarchived\[0\]/)
  rejects(assertUnarchiveResult, unarchiveResultFixture, (d) => { d.skipped[0].code = 'bogus' }, /skipped\[0\]\.code/)
  rejects(assertPurgeResult, purgeResultFixture, (d) => { d.removedBytes = 'x' }, /removedBytes/)
})

test('assertRequest: validates each method request and names invalid-request', () => {
  const ok = {
    overview: {},
    archived: { workspaceId: 'ws-1', olderThanDays: 30, largerThanBytes: 1024, text: 'abc', sort: 'bytes', offset: 0, limit: 50 },
    plan: { scope: 'olderThan', olderThanDays: 30 },
    apply: { planId: 'plan-1', confirmCount: 3 },
    unarchive: { ids: ['a', 'b'] },
    trash: {},
    restore: { batchId: 'b1' },
    purge: { batchId: 'b1', confirm: 'b1' },
  }
  assert.deepEqual(Object.keys(ok), contract.METHOD_NAMES)
  for (const [method, request] of Object.entries(ok)) assert.doesNotThrow(() => assertRequest(method, request), method)
  assert.doesNotThrow(() => assertRequest('plan', { scope: 'all' }))
  for (const method of ['overview', 'trash']) {
    assert.doesNotThrow(() => assertRequest(method, { fresh: true }), `${method} fresh`)
    assert.doesNotThrow(() => assertRequest(method, { fresh: false }), `${method} fresh false`)
    for (const bad of [{ fresh: 'yes' }, { fresh: 1 }, { stale: true }, { fresh: true, extra: 1 }]) {
      assert.throws(() => assertRequest(method, bad), (err) => err.code === 'sessions-manager/invalid-request', `${method} ${JSON.stringify(bad)}`)
    }
  }
  assert.doesNotThrow(() => assertRequest('plan', { scope: 'selection', rootIds: ['a'] }))

  const bad = [
    ['overview', { x: 1 }],
    ['overview', null],
    ['archived', { limit: 'ten' }],
    ['archived', { sort: 'random' }],
    ['archived', { offset: -1 }],
    ['plan', {}],
    ['plan', { scope: 'selection' }],
    ['plan', { scope: 'olderThan' }],
    ['plan', { scope: 'all', rootIds: ['a'] }],
    ['apply', { planId: 'p' }],
    ['apply', { planId: 'p', confirmCount: 'three' }],
    ['apply', { planId: 'p', confirmCount: 3, ids: ['a'] }],
    ['unarchive', { ids: [] }],
    ['unarchive', { ids: [1] }],
    ['restore', {}],
    ['restore', { batchId: '../etc' }],
    ['purge', { batchId: 'b1' }],
    ['purge', { batchId: 'b1', confirm: '' }],
    ['nonsense', {}],
  ]
  for (const [method, request] of bad) {
    assert.throws(() => assertRequest(method, request), (err) => err.code === 'sessions-manager/invalid-request', `${method} ${JSON.stringify(request)}`)
  }
})

test('HostFacts: fake is deterministic, seeded and covers the whole surface', async () => {
  const a = createFakeHostFacts()
  const b = createFakeHostFacts()
  const snapA = await a.snapshots()
  const snapB = await b.snapshots()
  assert.ok(snapA.length >= 400, `forest has ${snapA.length} sessions`)
  assert.deepEqual(snapA, snapB)
  assert.notDeepEqual(snapA, await createFakeHostFacts({ seed: 99 }).snapshots())

  for (const method of [
    'snapshots', 'workspaces', 'archivedIds', 'pinnedIds', 'liveIds', 'lockState', 'statLog', 'titleOf', 'unpin', 'detach',
    'unarchive', 'attach', 'archive', 'pin',
  ]) assert.equal(typeof a[method], 'function', method)

  const ids = new Set(snapA.map((s) => s.id))
  assert.equal(ids.size, snapA.length)
  assert.ok(snapA.some((s) => s.parentId !== null), 'has children')
  for (const s of snapA) {
    if (s.parentId !== null) assert.ok(ids.has(s.parentId), `parent of ${s.id} exists`)
    assert.ok(Number.isSafeInteger(s.bytes) && s.bytes >= 0)
  }

  const workspaces = await a.workspaces()
  assert.ok(workspaces.length >= 3)
  for (const w of workspaces) {
    assert.deepEqual(Object.keys(w).sort(), ['id', 'name', 'path', 'sessionIds'])
    for (const id of w.sessionIds) assert.ok(ids.has(id))
  }
  assert.ok(snapA.some((s) => !workspaces.some((w) => w.sessionIds.includes(s.id))), 'has unassigned sessions')

  const archived = await a.archivedIds()
  const live = await a.liveIds()
  const pinned = await a.pinnedIds()
  assert.ok(archived.length > 0 && live.length > 0 && pinned.length > 0)
  for (const id of [...archived, ...live, ...pinned]) assert.ok(ids.has(id))

  const first = snapA[0]
  const stat = await a.statLog(first.logPath)
  assert.deepEqual(Object.keys(stat).sort(), ['bytes', 'dev', 'exists', 'isSymlink', 'mtimeMs'])
  assert.deepEqual(await a.statLog('/fake/missing/events.jsonl'), { exists: false, isSymlink: false, mtimeMs: 0, bytes: 0, dev: 0 })
  const lock = await a.lockState(first.dir)
  assert.ok(['none', 'held', 'stale'].includes(lock.state))
  const title = await a.titleOf(first.id)
  assert.ok(title === null || typeof title === 'string')
  assert.equal(await a.titleOf('no-such-id'), null)

  // Registry steps mutate the fake's own state and are recorded in order.
  const target = archived[0]
  await a.unarchive(target)
  assert.ok(!(await a.archivedIds()).includes(target))
  await a.archive(target)
  assert.ok((await a.archivedIds()).includes(target))
  await a.pin(target)
  assert.ok((await a.pinnedIds()).includes(target))
  await a.unpin(target)
  assert.ok(!(await a.pinnedIds()).includes(target))
  const ws = workspaces.find((w) => w.sessionIds.includes(target))
  await a.detach(target)
  assert.ok(!(await a.workspaces()).some((w) => w.sessionIds.includes(target)))
  if (ws) {
    await a.attach(target, ws.id)
    assert.ok((await a.workspaces()).find((w) => w.id === ws.id).sessionIds.includes(target))
  }
  assert.deepEqual(a.calls.map((c) => c[0]), ['unarchive', 'archive', 'pin', 'unpin', 'detach', ...(ws ? ['attach'] : [])])

  // The fake never touches the real environment.
  const fresh = createFakeHostFacts()
  assert.equal(JSON.stringify(await fresh.snapshots()).includes(process.env.HOME ?? '\0'), false)
})

test('the engine surface is documented as a HostFacts typedef', () => {
  const source = readFileSync(join(root, 'src/contract.js'), 'utf8')
  assert.match(source, /@typedef \{object\} HostFacts/)
  for (const name of ['snapshots', 'workspaces', 'archivedIds', 'pinnedIds', 'liveIds', 'lockState', 'statLog', 'titleOf', 'unpin', 'detach', 'unarchive', 'attach', 'archive', 'pin']) {
    assert.match(source, new RegExp(`@property \\{[^}]*\\} ${name}\\b`), name)
  }
})

test('remote-contract.md lists every method, error code, refusal code and a source for every response field', () => {
  const doc = readFileSync(join(root, 'docs/remote-contract.md'), 'utf8')
  for (const name of contract.METHOD_NAMES) assert.match(doc, new RegExp(`^### \`${name}\``, 'm'), name)
  for (const code of ERROR_CODES) assert.ok(doc.includes(`\`${code}\``), code)
  for (const code of REFUSAL_CODES) assert.ok(doc.includes(`\`${code}\``), code)
  for (const source of ['persistence snapshot', 'registry', 'live-session service', 'lstat', 'computed']) assert.ok(doc.includes(source), source)
})

test('no file under src reads process.env or os.homedir', () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
  for (const file of walk(join(root, 'src'))) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /process[.]env|homedir/, file)
  }
})
