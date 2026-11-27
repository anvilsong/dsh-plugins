// Tests for the store index (src/store-index.js): compact rows projected from
// the persistence snapshot, the overview cards, the workspace table, the
// largest list, the archived page, unreadable rows, the store root, and the
// size and time bounds. Pure data in memory: the only file read is the
// module's own source, for the purity check. Nothing touches the real DSH home
// or session store.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { DEFAULTS } from '../src/config.js'
import { ContractError, ERROR, MAX_LARGEST, REFUSAL_CODES, assertArchivedPage, assertOverview } from '../src/contract.js'
import { buildUnits } from '../src/lineage.js'
import { ROW_KEYS, archivedPage, buildIndex, overview, storeRootOf, summarize } from '../src/store-index.js'
import { createFakeHostFacts } from './helpers/fixtures.mjs'

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0)
const MINUTE = 60_000
const DAY = 86_400_000
const MB = 1024 * 1024
const ROOT = '/store/sessions'
const CONFIG = Object.freeze({ ...DEFAULTS })
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'store-index.js')

const PROJECT = Object.freeze({ alpha: '--work-alpha--', beta: '--work-beta--', loose: '--tmp-loose--' })
const dirOf = (id, project = 'alpha') => `${ROOT}/${PROJECT[project]}/${id}`
const logOf = (id, project = 'alpha') => `${dirOf(id, project)}/session.v4.jsonl.zstd`
const lastSegment = (path) => path.slice(path.lastIndexOf('/') + 1)

/**
 * A persistence snapshot as the JSONL backend lists it (docs/store-safety.md,
 * API table): header, formatStatus, revision, sizeBytes, location; no
 * eventCount unless given, no title.
 */
const snap = (id, {
  project = 'alpha', parent = null, origin = null, createdAt = NOW - 400 * DAY, sizeBytes = MB, eventCount,
  kind = 'jsonl', formatStatus = 'current', path,
} = {}) => ({
  header: {
    version: 4,
    id,
    createdAt,
    cwd: `/work/${project}`,
    ...(parent === null ? {} : { parentSession: parent }),
    isSeeded: false,
    ...(origin === null ? {} : { origin }),
    delegationDepth: parent === null ? 0 : 1,
  },
  formatStatus,
  revision: `1:${id.length}:${sizeBytes ?? 0}:0:0`,
  ...(sizeBytes === null ? {} : { sizeBytes }), // null: the backend gave no size
  ...(eventCount === undefined ? {} : { eventCount }),
  ...(kind === null ? {} : { location: { kind, path: path ?? logOf(id, project) } }),
})

const REGISTRY_STEPS = ['unpin', 'detach', 'unarchive', 'attach', 'archive', 'pin']

/**
 * A HostFacts fake over persistence snapshots. Every call is recorded; the
 * registry steps throw, because the index must never call them. `mtimes`
 * holds the lstat mtime of each log by id (default ten days ago); `gone`
 * lists ids whose log lstat reports exists false.
 */
const hostOver = ({
  snapshots, workspaces = [], archived = [], pinned = [], live = [], mtimes = {}, titles = {}, locks = {}, gone = [],
  sync = false, throwing = {},
}) => {
  const calls = []
  const wrap = (name, fn) => (...args) => {
    calls.push([name, ...args])
    if (throwing[name]) throw new Error(`${name} failed`)
    const value = fn(...args)
    return sync ? value : Promise.resolve(value)
  }
  const statOf = (path) => {
    const name = lastSegment(path)
    const id = name.includes('.') ? lastSegment(dirname(path)) : name
    if (gone.includes(id)) return { exists: false, isSymlink: false, mtimeMs: 0, bytes: 0, dev: 0 }
    return { exists: true, isSymlink: false, mtimeMs: mtimes[id] ?? NOW - 10 * DAY, bytes: 777, dev: 1 }
  }
  const host = {
    calls,
    snapshots: wrap('snapshots', () => snapshots),
    workspaces: wrap('workspaces', () => workspaces.map((w) => ({ ...w, sessionIds: [...w.sessionIds] }))),
    archivedIds: wrap('archivedIds', () => [...archived]),
    pinnedIds: wrap('pinnedIds', () => [...pinned]),
    liveIds: wrap('liveIds', () => [...live]),
    lockState: wrap('lockState', (folder) => ({ ...(locks[lastSegment(folder)] ?? { state: 'none', pid: null }) })),
    statLog: wrap('statLog', statOf),
    titleOf: wrap('titleOf', (id) => titles[id] ?? null),
  }
  for (const name of REGISTRY_STEPS) host[name] = () => { throw new Error(`the index called the registry step ${name}`) }
  return host
}

const build = (host, extra = {}) => buildIndex(host, { config: CONFIG, now: NOW, ...extra })
const ids = (page) => page.rows.map((row) => row.id)
const reasonsOf = (row) => row.reasons.map(({ code, sessionId }) => `${code}:${sessionId}`)
const byteLength = (value) => Buffer.byteLength(JSON.stringify(value))

/** Every object reachable from `value`, for the no-reference check. */
const objectsIn = (value, found = new Set()) => {
  if (value === null || typeof value !== 'object' || found.has(value)) return found
  found.add(value)
  for (const child of value instanceof Map ? [...value.keys(), ...value.values()] : Object.values(value)) objectsIn(child, found)
  return found
}

// ---------------------------------------------------------------------------
// The reference store used by the card, table and page tests. Sizes in MB.
//
//   alpha (ws-a): a1 archived 10, a1c1 child 2 (registered: a bootstrapped
//                 child), a1c2 archived child 1 with grandchild a1c2g 1;
//                 a2 archived 5 with live child a2c 1; a3 kept 20, live,
//                 pinned; a4 archived 2, active five minutes ago; gk 1, the
//                 stored child of `gone` (archived, registered, no log).
//   beta (ws-b):  b1 archived 3 with b1k 1, a historical fork (parentSession
//                 without origin).
//   no workspace: u1 archived 1, u2 2, g2k 1 (child of `gone2`, archived, in
//                 no workspace, no log), all in the loose folder; n1 1 with a
//                 non-JSONL location; one snapshot without a readable header.
// ---------------------------------------------------------------------------
const referenceStore = (overrides = {}) => {
  const sub = { origin: 'subagent' }
  const snapshots = [
    snap('a1'), snap('a1c1', { parent: 'a1', ...sub, sizeBytes: 2 * MB }), snap('a1c2', { parent: 'a1', ...sub }),
    snap('a1c2g', { parent: 'a1c2', ...sub }),
    snap('a2', { sizeBytes: 5 * MB }), snap('a2c', { parent: 'a2', ...sub }),
    snap('a3', { sizeBytes: 20 * MB, eventCount: 4000 }), snap('a4', { sizeBytes: 2 * MB }),
    snap('gk', { parent: 'gone', ...sub }),
    snap('b1', { project: 'beta', sizeBytes: 3 * MB }), snap('b1k', { project: 'beta', parent: 'b1' }),
    snap('u1', { project: 'loose' }), snap('u2', { project: 'loose', sizeBytes: 2 * MB }),
    snap('g2k', { project: 'loose', parent: 'gone2', ...sub }),
    snap('n1', { kind: 'sqlite' }),
    { header: null, revision: 'x', sizeBytes: 0, location: { kind: 'jsonl', path: logOf('broken', 'loose') } },
  ]
  snapshots[0].sizeBytes = 10 * MB
  return hostOver({
    snapshots,
    workspaces: [
      { id: 'ws-a', name: 'alpha', path: '/work/alpha', sessionIds: ['a1', 'a1c1', 'a2', 'a3', 'a4', 'gone'] },
      { id: 'ws-b', name: 'beta', path: '/work/beta', sessionIds: ['b1'] },
    ],
    archived: ['a1', 'a1c2', 'a2', 'a4', 'b1', 'u1', 'gone', 'gone2'],
    pinned: ['a3'],
    live: ['a2c', 'a3'],
    mtimes: {
      a1: NOW - 40 * DAY, a1c1: NOW - 40 * DAY, a1c2: NOW - 40 * DAY, a1c2g: NOW - 40 * DAY, a2: NOW - 50 * DAY, a2c: NOW - 50 * DAY,
      a3: NOW - DAY, a4: NOW - 5 * MINUTE, gk: NOW - 60 * DAY, b1: NOW - 100 * DAY, b1k: NOW - 100 * DAY, u1: NOW - 20 * DAY,
      u2: NOW - 3 * DAY, g2k: NOW - 70 * DAY,
    },
    titles: { a1: 'Refactor parser', a3: 'Kept work', b1: 'Beta release notes', u1: 'Unassigned scratch' },
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// 1. Rows
// ---------------------------------------------------------------------------

test('buildIndex projects each persistence snapshot to a compact row with only the allow-listed keys', async () => {
  const snapshots = [
    snap('r1', { sizeBytes: 1000, eventCount: 12, createdAt: NOW - 90 * DAY }),
    snap('c1', { parent: 'r1', origin: 'subagent', sizeBytes: 500 }),
    snap('f1', { parent: 'r1' }),
    snap('m1', { formatStatus: 'migration-required', sizeBytes: null }),
  ]
  const host = hostOver({
    snapshots,
    workspaces: [{ id: 'ws-a', name: 'alpha', path: '/work/alpha', sessionIds: ['r1', 'm1'] }],
    archived: ['r1'], pinned: ['m1'], live: ['c1'],
    mtimes: { r1: NOW - 3 * DAY },
    titles: { r1: '  Fix\nthe\tparser  ', c1: '' },
  })
  const folderBytes = (dir) => (dir === dirOf('r1') ? 4096 : undefined)
  const index = await build(host, { folderBytes })
  const row = (id) => index.rows.find((r) => r.id === id)

  assert.deepEqual(index.rows.map((r) => r.id), ['c1', 'f1', 'm1', 'r1'], 'rows are sorted by id')
  for (const r of index.rows) {
    assert.deepEqual(Object.keys(r).sort(), [...ROW_KEYS].sort(), `row ${r.id} has exactly the allow-listed keys`)
    for (const [key, value] of Object.entries(r)) {
      assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value), `row ${r.id}.${key} is a primitive`)
    }
  }
  assert.deepEqual(row('r1'), {
    id: 'r1', parentId: null, createdAt: NOW - 90 * DAY, cwd: '/work/alpha', subagent: false, child: false, legacy: false,
    revision: '1:2:1000:0:0', bytes: 4096, events: 12, lastActivityMs: NOW - 3 * DAY, dir: dirOf('r1'), logPath: logOf('r1'),
    workspaceDir: '--work-alpha--', workspaceId: 'ws-a', archived: true, pinned: false, live: false, title: 'Fix the parser',
    unreadable: false,
  })
  // bytes: the folder sum wins (store-safety.md, Cost), else sizeBytes, else the log lstat.
  assert.equal(row('c1').bytes, 500)
  assert.equal(row('m1').bytes, 777)
  // events: snapshot.eventCount or null (the JSONL backend gives none).
  assert.equal(row('c1').events, null)
  // child: a parent is present and the header does not mark a non-subagent (store-safety.md, Lineage).
  assert.equal(row('c1').child, true)
  assert.equal(row('c1').subagent, true)
  assert.equal(row('f1').child, false, 'a parentSession without origin subagent is a historical fork')
  assert.equal(row('f1').parentId, 'r1')
  // Workspace: own registration, else inherited from the nearest registered ancestor.
  assert.equal(row('c1').workspaceId, 'ws-a')
  assert.equal(row('c1').live, true)
  assert.equal(row('m1').legacy, true)
  assert.equal(row('m1').pinned, true)
  assert.equal(row('c1').title, null, 'an empty title is null')
})

test('the index keeps no reference to a snapshot, its header or its location', async () => {
  const host = referenceStore()
  const snapshots = await host.snapshots()
  const inputs = new Set()
  for (const s of snapshots) for (const value of [s, s.header, s.location]) if (value) inputs.add(value)
  const index = await build(host)
  for (const value of objectsIn(index)) assert.ok(!inputs.has(value), 'no snapshot object is reachable from the index')
  const before = JSON.stringify(index.rows)
  for (const s of snapshots) if (s.header) { s.header.id = 'mutated'; s.header.parentSession = 'mutated' }
  assert.equal(JSON.stringify(index.rows), before, 'mutating a snapshot after the build changes nothing')
})

test('titles are cleaned, capped and never fail the build', async () => {
  const long = 'x'.repeat(500)
  const host = hostOver({ snapshots: [snap('t1'), snap('t2'), snap('t3')], titles: { t1: long, t2: 42 } })
  host.titleOf = (id) => {
    if (id === 't3') throw new Error('no title cache')
    return { t1: long, t2: 42 }[id] ?? null
  }
  const index = await build(host)
  const [t1, t2, t3] = index.rows
  assert.ok(t1.title.length <= 120 && t1.title.endsWith('…'), 'a long title is capped')
  assert.equal(t2.title, null, 'a non-string title is null')
  assert.equal(t3.title, null, 'a throwing titleOf gives null')
})

test('accepts the contract SessionSnapshot shape of the fake HostFacts (src/contract.js)', async () => {
  const facts = createFakeHostFacts({ seed: 3 })
  const snapshots = await facts.snapshots()
  const index = await buildIndex(facts, { config: CONFIG, now: facts.now })
  assert.equal(index.rows.length, snapshots.length)
  const first = snapshots.find((s) => !s.unreadable && s.parentId !== null)
  const row = index.rows.find((r) => r.id === first.id)
  assert.equal(row.parentId, first.parentId)
  assert.equal(row.dir, first.dir)
  assert.equal(row.logPath, first.logPath)
  assert.equal(row.workspaceDir, first.group)
  assert.equal(row.bytes, first.bytes)
  assert.equal(row.events, first.events)
  assert.equal(row.lastActivityMs, first.lastActivityAt, 'the lstat mtime of the log')
  assert.equal(row.subagent, null, 'the contract shape carries no origin')
  assert.equal(row.child, true)
  assert.equal(index.storeRoot, '/fake/store')
})

// ---------------------------------------------------------------------------
// 2. Overview
// ---------------------------------------------------------------------------

test('overview totals: the five cards over the reference store', async () => {
  const index = await build(referenceStore())
  const dto = overview(index)
  assertOverview(dto)
  assert.equal(dto.generatedAt, NOW)
  assert.equal(dto.storeDir, ROOT)
  assert.deepEqual(dto.capabilities, { prune: true, reason: null })
  assert.deepEqual(dto.config, {
    allowPermanentDelete: CONFIG.allowPermanentDelete, recentActivityMinutes: CONFIG.recentActivityMinutes, listLimit: CONFIG.listLimit,
    refreshMs: CONFIG.refreshMs, indexWarnBytes: CONFIG.indexWarnBytes,
  })
  assert.deepEqual(dto.totals, {
    sessions: 16, // 15 rows + the snapshot without a readable header
    live: 2,
    archived: 6, // a1 a1c2 a2 a4 b1 u1; gone and gone2 have no stored log
    children: 6, // a1c1 a1c2 a1c2g a2c gk g2k; b1k is a fork
    unreadable: 2, // n1 (not JSONL) and the headerless snapshot
    bytes: 52 * MB,
    archivedBytes: 29 * MB,
    archivedRoots: 7, // a1 a2 a4 b1 u1 gk g2k
    archivedChildren: 5,
    reclaimableBytes: 15 * MB, // a1 (14) and gk (1)
    reclaimableUnits: 2,
    blockedUnits: 5,
    archivedMissing: 2, // gone and gone2: archived in the registry, no stored log (index.missing)
  })
  assert.equal(dto.indexLoad, 'normal')

  const summary = summarize(index)
  assert.equal(summary.total.missing, 2)
  assert.deepEqual(summary.reclaimable, { bytes: 15 * MB, units: 2, blockedUnits: 5, blockedBytes: 14 * MB })
  assert.deepEqual(summary.archived, { bytes: 29 * MB, roots: 7, children: 5 })
  assert.deepEqual(summary.onDisk, { bytes: 52 * MB, basis: 'on-disk' })
  assert.equal(summary.largest.id, 'a3')
})

test('overview workspace table: registered rows by size, then Unassigned rows by store folder', async () => {
  const index = await build(referenceStore())
  const { workspaces } = overview(index)
  assert.deepEqual(workspaces, [
    { id: 'ws-a', name: 'alpha', path: '/work/alpha', folder: null, sessions: 9, archived: 4, bytes: 43 * MB, lastActivityAt: NOW - 5 * MINUTE },
    { id: 'ws-b', name: 'beta', path: '/work/beta', folder: null, sessions: 2, archived: 1, bytes: 4 * MB, lastActivityAt: NOW - 100 * DAY },
    { id: null, name: null, path: null, folder: '--tmp-loose--', sessions: 3, archived: 1, bytes: 4 * MB, lastActivityAt: NOW - 3 * DAY },
    { id: null, name: null, path: null, folder: null, sessions: 1, archived: 0, bytes: MB, lastActivityAt: null },
  ])
  const table = summarize(index).workspaces
  assert.deepEqual(table.map((row) => row.share), [43 / 52, 4 / 52, 4 / 52, 1 / 52], 'share of the on-disk total, for the bar')
  assert.equal(workspaces.reduce((n, row) => n + row.sessions, 0), index.rows.length, 'every row is in exactly one table row')
})

test('overview largest: top 10 by size with live, archived and child flags', async () => {
  const index = await build(referenceStore())
  const { largest } = overview(index)
  assert.equal(largest.length, MAX_LARGEST)
  assert.deepEqual(largest.map((row) => row.id), ['a3', 'a1', 'a2', 'b1', 'a1c1', 'a4', 'u2', 'a1c2', 'a1c2g', 'a2c'])
  assert.deepEqual(largest[0], {
    id: 'a3', title: 'Kept work', workspaceId: 'ws-a', bytes: 20 * MB, events: 4000, lastActivityAt: NOW - DAY, live: true, archived: false, child: false,
  })
  const kid = largest.find((row) => row.id === 'a2c')
  assert.deepEqual([kid.live, kid.archived, kid.child, kid.events], [true, false, true, null], 'unknown events are sent as null, not 0')
  assert.deepEqual(largest.find((row) => row.id === 'a1c2').archived, true)
})

test('health: warn tier from indexWarnBytes on the on-disk total; raw size is never computed', async () => {
  const warnAt = (bytes) => build(referenceStore(), { config: { ...CONFIG, indexWarnBytes: bytes } })
  const at = await warnAt(52 * MB)
  assert.deepEqual(summarize(at).health, { bytes: 52 * MB, events: 4000, tier: 'warn', basis: 'on-disk' })
  assert.equal(overview(at).indexLoad, 'high')
  const below = await warnAt(52 * MB + 1)
  assert.equal(summarize(below).health.tier, 'normal')
  assert.equal(overview(below).indexLoad, 'normal')
  const keys = new Set()
  const collect = (value) => {
    if (value === null || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) { keys.add(key); collect(child) }
  }
  collect(summarize(at))
  collect(overview(at))
  collect(at.rows)
  assert.deepEqual([...keys].filter((key) => /raw|uncompressed|decompressed/i.test(key)), [])
  const none = await build(hostOver({ snapshots: [snap('e1')] }))
  assert.equal(summarize(none).health.events, null, 'no event count anywhere gives null, not 0')
})

test('capabilities: passed through when the store root is known; validated', async () => {
  const index = await build(referenceStore())
  const platform = overview(index, { capabilities: { prune: false, reason: ERROR.unsupportedPlatform } })
  assertOverview(platform)
  assert.deepEqual(platform.capabilities, { prune: false, reason: ERROR.unsupportedPlatform })
  assert.equal(overview(index, { storeDir: '/configured/sessions' }).storeDir, '/configured/sessions')
  assert.throws(() => overview(index, { capabilities: { prune: false, reason: 'nope' } }), TypeError)
  assert.throws(() => overview(index, { capabilities: { prune: false, reason: null } }), TypeError)
  assert.deepEqual(overview(index, { capabilities: { prune: true, reason: ERROR.trashUnusable } }).capabilities, { prune: true, reason: null })
})

// ---------------------------------------------------------------------------
// 3. Archived page
// ---------------------------------------------------------------------------

test('archived page: rows are unit roots with child count, combined bytes, status and reasons', async () => {
  const index = await build(referenceStore())
  const page = archivedPage(index)
  assertArchivedPage(page)
  assert.deepEqual([page.total, page.offset, page.limit], [7, 0, CONFIG.listLimit])
  assert.deepEqual(ids(page), ['a1', 'a2', 'b1', 'a4', 'g2k', 'gk', 'u1'], 'sorted by bytes, largest first, then id')
  const row = (id) => page.rows.find((r) => r.id === id)
  assert.deepEqual(row('a1'), {
    id: 'a1', title: 'Refactor parser', workspaceId: 'ws-a', bytes: 14 * MB, childCount: 3, lastActivityAt: NOW - 40 * DAY, ageDays: 40,
    blocked: false, reasons: [], orphan: false,
  })
  assert.ok(!ids(page).includes('a1c2'), 'an archived session nested in a unit is counted in its root row only')
  assert.deepEqual(reasonsOf(row('a2')), ['live:a2c'])
  assert.deepEqual(reasonsOf(row('a4')), ['recent:a4'])
  assert.deepEqual(reasonsOf(row('b1')), ['kept-descendant:b1k'], 'a historical fork below an archived root is kept')
  assert.deepEqual(reasonsOf(row('u1')), ['workspace-missing:u1'], 'D11: sessions in no workspace are not pruned in v1')
  assert.equal(row('u1').workspaceId, null)
  assert.equal(index.missing, 2, 'archived ids with no stored log are excluded and counted')
  assert.ok(!ids(page).includes('gone') && !ids(page).includes('gone2'))
})

test('archived page: orphan units (children of an archived id with no stored log) are rows under their own root', async () => {
  const index = await build(referenceStore())
  const page = archivedPage(index)
  const gk = page.rows.find((r) => r.id === 'gk')
  assert.deepEqual([gk.workspaceId, gk.blocked, gk.childCount, gk.bytes], ['ws-a', false, 0, MB], 'the missing anchor is registered in ws-a')
  const g2k = page.rows.find((r) => r.id === 'g2k')
  assert.deepEqual([g2k.workspaceId, reasonsOf(g2k)], [null, ['workspace-missing:g2k']])
  const unit = index.units.find((u) => u.rootId === 'gk')
  assert.deepEqual([unit.orphan, unit.anchorId], [true, 'gone'])
})

test('archived page: orphan is true exactly for the rows whose unit root is an orphan unit', async () => {
  const index = await build(referenceStore())
  const page = archivedPage(index)
  assertArchivedPage(page)
  const flagged = page.rows.filter((r) => r.orphan).map((r) => r.id).sort()
  assert.deepEqual(flagged, ['g2k', 'gk'], 'children of an archived id with no stored log')
  assert.deepEqual(flagged, index.units.filter((u) => u.orphan).map((u) => u.rootId).sort())
  for (const r of page.rows) assert.equal(typeof r.orphan, 'boolean')
  assert.equal(page.rows.find((r) => r.id === 'a1').orphan, false, 'an archived root with children is not an orphan')
  // A subagent child of an archived parent that has a stored log joins that unit; no orphan row appears.
  const nested = await build(hostOver({
    snapshots: [snap('p'), snap('k', { parent: 'p', origin: 'subagent' })], workspaces: [{ id: 'w', name: 'w', path: '/w', sessionIds: ['p'] }],
    archived: ['p', 'k'],
  }))
  assert.deepEqual(archivedPage(nested).rows.map((r) => [r.id, r.orphan]), [['p', false]])
})

test('legacy rows are refused with legacy-format through the lineage engine, in the whole unit', async () => {
  const sub = { origin: 'subagent' }
  const host = hostOver({
    snapshots: [
      snap('l1'), snap('l1c', { parent: 'l1', ...sub, formatStatus: 'migration-required' }),
      snap('l2', { formatStatus: 'migration-required' }), snap('ok1'), snap('ok1c', { parent: 'ok1', ...sub }),
      snap('lk', { parent: 'gone', ...sub, formatStatus: 'migration-required' }),
    ],
    workspaces: [{ id: 'w', name: 'w', path: '/w', sessionIds: ['l1', 'l2', 'ok1', 'gone'] }],
    archived: ['l1', 'l2', 'ok1', 'gone'],
  })
  const index = await build(host)
  const page = archivedPage(index)
  assertArchivedPage(page)
  const byId = new Map(page.rows.map((r) => [r.id, r]))
  assert.deepEqual(reasonsOf(byId.get('l1')), ['legacy-format:l1c'], 'a legacy child blocks its whole unit')
  assert.deepEqual(reasonsOf(byId.get('l2')), ['legacy-format:l2'])
  assert.deepEqual(reasonsOf(byId.get('lk')), ['legacy-format:lk'], 'also an orphan unit')
  assert.deepEqual(byId.get('lk').orphan, true)
  assert.deepEqual([byId.get('ok1').blocked, byId.get('ok1').reasons], [false, []])
  for (const id of ['l1', 'l2', 'lk']) assert.equal(byId.get(id).blocked, true)
  const ready = index.units.filter((u) => u.status === 'ready').flatMap((u) => u.memberIds)
  assert.deepEqual(ready.sort(), ['ok1', 'ok1c'], 'a legacy session is never a member of a ready unit')
  assert.equal(overview(index).totals.reclaimableUnits, 1)
  assert.equal(overview(index).totals.blockedUnits, 3)
})

test('overview: storeDir is null without a store root, and prune is unsupported', async () => {
  const index = await build(hostOver({ snapshots: [snap('e1', { kind: null }), snap('e2', { kind: 'sqlite' })] }))
  assert.equal(index.storeRoot, null)
  const dto = overview(index)
  assertOverview(dto)
  assert.equal(dto.storeDir, null)
  assert.deepEqual(dto.capabilities, { prune: false, reason: ERROR.unsupportedBackend })
  assert.equal(overview(index, { storeDir: '/configured' }).storeDir, '/configured', 'the Host location still wins')
  assert.ok(dto.largest.every((row) => row.events === null), 'no event count gives null events')
  assertOverview(overview(await build(referenceStore())))
})

test('archived page: a registered subagent child does not keep its archived tree (origin decides, not membership)', async () => {
  const index = await build(referenceStore())
  assert.equal(index.rows.find((r) => r.id === 'a1c1').subagent, true)
  assert.equal(archivedPage(index).rows.find((r) => r.id === 'a1').blocked, false)
})

test('archived page filters: workspace, age, size and text (id, title, workspace name only)', async () => {
  const index = await build(referenceStore())
  const page = (request) => {
    const result = archivedPage(index, request)
    assertArchivedPage(result)
    return result
  }
  assert.deepEqual(ids(page({ workspaceId: 'ws-a' })), ['a1', 'a2', 'a4', 'gk'])
  assert.deepEqual(ids(page({ workspaceId: null })), ['g2k', 'u1'], 'null is the Unassigned filter')
  assert.deepEqual(ids(page({ workspaceId: 'ws-none' })), [])
  assert.deepEqual(ids(page({ olderThanDays: 45 })), ['a2', 'b1', 'g2k', 'gk'])
  assert.deepEqual(ids(page({ olderThanDays: 0 })).length, 7)
  assert.deepEqual(ids(page({ largerThanBytes: 4 * MB })), ['a1', 'a2'], 'strictly larger')
  assert.deepEqual(ids(page({ text: 'ALPHA' })), ['a1', 'a2', 'a4', 'gk'], 'workspace name, case-insensitive')
  assert.deepEqual(ids(page({ text: 'release' })), ['b1'], 'title')
  assert.deepEqual(ids(page({ text: 'g2' })), ['g2k'], 'id')
  assert.deepEqual(ids(page({ text: 'a1c' })), [], 'member ids are not searched')
  assert.deepEqual(ids(page({ text: 'work' })), [], 'paths, cwd and folders are not searched')
  assert.deepEqual(ids(page({ text: '   ' })).length, 7, 'blank text does not filter')
  assert.deepEqual(ids(page({ text: 'a1\nrefactor' })), [], 'a match never spans two fields')
  assert.deepEqual(ids(page({ workspaceId: 'ws-a', olderThanDays: 45, largerThanBytes: 0 })), ['a2', 'gk'])
  assert.equal(page({ text: 'alpha', offset: 1, limit: 2 }).total, 4, 'total counts every match before paging')
})

test('archived page sort and paging; limit is capped at listLimit', async () => {
  const index = await build(referenceStore())
  assert.deepEqual(ids(archivedPage(index, { sort: 'lastActivityAt' })), ['a4', 'u1', 'a1', 'a2', 'gk', 'g2k', 'b1'], 'newest first')
  assert.deepEqual(ids(archivedPage(index, { sort: 'title' })), ['a2', 'a4', 'b1', 'g2k', 'gk', 'a1', 'u1'], 'title, else id, A to Z')
  assert.deepEqual(ids(archivedPage(index, { sort: 'bytes' })), ids(archivedPage(index)))
  const second = archivedPage(index, { offset: 2, limit: 2 })
  assert.deepEqual([ids(second), second.total, second.offset, second.limit], [['b1', 'a4'], 7, 2, 2])
  assert.deepEqual(ids(archivedPage(index, { offset: 50 })), [])
  const small = await build(referenceStore(), { config: { ...CONFIG, listLimit: 3 } })
  const capped = archivedPage(small, { limit: 10 })
  assert.deepEqual([capped.rows.length, capped.limit, capped.total], [3, 3, 7])
  assert.equal(archivedPage(small).limit, 3, 'the default limit is listLimit')
})

test('archived page rejects an invalid request with invalid-request', async () => {
  const index = await build(referenceStore())
  for (const request of [{ bogus: 1 }, { sort: 'size' }, { limit: 0 }, { offset: -1 }, { text: 7 }, null]) {
    assert.throws(() => archivedPage(index, request), (error) => error instanceof ContractError && error.code === ERROR.invalidRequest, JSON.stringify(request))
  }
})

test('archived page rows carry one reason per refusal code; index units keep every reason', async () => {
  const host = hostOver({
    snapshots: [snap('r'), snap('k1', { parent: 'r', origin: 'subagent' }), snap('k2', { parent: 'r', origin: 'subagent' })],
    workspaces: [{ id: 'w', name: 'w', path: '/work/w', sessionIds: ['r'] }],
    archived: ['r'], live: ['k1', 'k2'],
  })
  const index = await build(host)
  assert.deepEqual(index.units[0].reasons.map(({ code, sessionId }) => `${code}:${sessionId}`), ['live:k1', 'live:k2'])
  assert.deepEqual(reasonsOf(archivedPage(index).rows[0]), ['live:k1'])
})

test('archived page rows are copies: changing one does not change the index', async () => {
  const index = await build(referenceStore())
  const page = archivedPage(index)
  page.rows[0].bytes = 0
  page.rows[1].reasons.push({ code: 'live', sessionId: 'x' })
  assert.deepEqual(archivedPage(index), archivedPage(await build(referenceStore())))
})

// ---------------------------------------------------------------------------
// 4. Unreadable snapshots and the store root
// ---------------------------------------------------------------------------

test('a snapshot without a JSONL location or a readable header is unreadable and never linked into a unit', async () => {
  const host = hostOver({
    snapshots: [
      snap('n1', { kind: 'sqlite' }), snap('n2', { kind: null }), snap('kid', { parent: 'n1', origin: 'subagent' }),
      { header: { version: 4 }, revision: 'r', location: { kind: 'jsonl', path: logOf('h1') } }, { revision: 'only' }, null,
    ],
    workspaces: [{ id: 'w', name: 'w', path: '/work/w', sessionIds: ['n1', 'n2', 'kid'] }],
    archived: ['n1', 'n2'],
  })
  const index = await build(host)
  assert.deepEqual(index.rows.filter((r) => r.unreadable).map((r) => r.id), ['n1', 'n2'])
  assert.equal(index.headerless.count, 3)
  const dto = overview(index)
  assertOverview(dto)
  assert.equal(dto.totals.unreadable, 5)
  assert.equal(dto.totals.sessions, 6)
  for (const unit of index.units) for (const id of unit.memberIds) assert.ok(!['n1', 'n2'].includes(id), 'unreadable rows are never members')
  // The readable child of an archived unreadable session forms its own unit, blocked by its stored parent.
  assert.deepEqual(archivedPage(index).rows.map((r) => [r.id, reasonsOf(r)]), [['kid', ['parent-kept:kid']]])
  assert.equal(index.missing, 0, 'an unreadable archived session is stored, not missing')
  assert.ok(!host.calls.some(([name, arg]) => name === 'titleOf' && ['n1', 'n2'].includes(arg)), 'no title is asked for an unreadable row')
})

test('storeRootOf: the common ancestor of the location paths, above the project folders', () => {
  assert.equal(storeRootOf([logOf('a'), logOf('b', 'beta')]), ROOT)
  assert.equal(storeRootOf([logOf('a')]), ROOT, 'one session still gives the store root, never its own folder')
  assert.equal(storeRootOf(['/s1/p/a/log', '/s2/p/b/log']), null, 'disjoint stores have no common ancestor below /')
  assert.equal(storeRootOf(['/p/a/log']), null, 'a path too short for <root>/<project>/<session>/<log>')
  assert.equal(storeRootOf([]), null)
  assert.equal(storeRootOf([logOf('a'), '/store/sessions/../etc/p/x/log', 'relative/p/a/log', `${ROOT}/p/\u0000/log`]), ROOT, 'unclean paths are ignored')
  assert.equal(storeRootOf(['/a/b/c/p/s/log', '/a/b/d/p/s/log']), '/a/b')
})

test('a null store root makes capabilities.prune false with unsupported-backend', async () => {
  const cases = {
    'no JSONL location': [snap('n1', { kind: 'sqlite' })],
    'empty store': [],
    'disjoint roots': [snap('a', { path: '/s1/p/a/log' }), snap('b', { path: '/s2/p/b/log' })],
  }
  for (const [name, snapshots] of Object.entries(cases)) {
    const index = await build(hostOver({ snapshots }))
    assert.equal(index.storeRoot, null, name)
    // An empty store is the one exception: the Host may know the sessions tree from its trash, so its verdict stands.
    const host = name === 'empty store'
    for (const capabilities of [undefined, { prune: true, reason: null }, { prune: false, reason: ERROR.unsupportedPlatform }]) {
      const dto = overview(index, { capabilities })
      assertOverview(dto)
      const expected = host && capabilities !== undefined ? capabilities : { prune: false, reason: ERROR.unsupportedBackend }
      assert.deepEqual(dto.capabilities, expected, `${name}: ${JSON.stringify(capabilities)}`)
    }
    assert.equal(overview(index, { storeDir: '/configured' }).storeDir, '/configured')
  }
  // A store that lists only headerless snapshots is not empty: no exception.
  const headerless = await build(hostOver({ snapshots: [{ revision: 'only' }] }))
  assert.deepEqual(overview(headerless, { capabilities: { prune: true, reason: null } }).capabilities, { prune: false, reason: ERROR.unsupportedBackend })
})

test('unsafe paths are never handed to the host, and their units are refused', async () => {
  const bad = `${ROOT}/--work-alpha--/../escape/x/session.v4.jsonl.zstd`
  const host = hostOver({
    snapshots: [snap('ok'), snap('x', { path: bad })],
    workspaces: [{ id: 'w', name: 'w', path: '/work/w', sessionIds: ['ok', 'x'] }],
    archived: ['x'],
  })
  const asked = []
  const index = await build(host, { folderBytes: (dir) => { asked.push(dir); return 1 } })
  assert.equal(index.storeRoot, ROOT)
  assert.ok(!host.calls.some(([, arg]) => typeof arg === 'string' && arg.includes('..')), 'no host call gets the unsafe path')
  assert.ok(!asked.some((dir) => dir.includes('..')), 'folderBytes never gets the unsafe path')
  const row = archivedPage(index).rows.find((r) => r.id === 'x')
  assert.ok(reasonsOf(row).includes('path-unsafe:x'))
})

test('failing host lookups fail safe: a throwing lock probe blocks, a throwing lstat or folder sum falls back', async () => {
  const locked = await build(referenceStore({ throwing: { lockState: true } }))
  assert.equal(overview(locked).totals.reclaimableUnits, 0)
  assert.ok(reasonsOf(archivedPage(locked).rows.find((r) => r.id === 'a1')).includes('locked:a1'))
  const unstat = await build(referenceStore({ throwing: { statLog: true } }), { folderBytes: () => { throw new Error('EACCES') } })
  const a1 = unstat.rows.find((r) => r.id === 'a1')
  assert.deepEqual([a1.lastActivityMs, a1.bytes], [null, 10 * MB])
  assert.ok(reasonsOf(archivedPage(unstat).rows.find((r) => r.id === 'a1')).includes('no-location:a1'))
  assertOverview(overview(unstat))
  assertArchivedPage(archivedPage(unstat))
  const held = await build(referenceStore({ locks: { a1c2g: { state: 'held', pid: 9 } } }))
  assert.deepEqual(reasonsOf(archivedPage(held).rows.find((r) => r.id === 'a1')), ['locked:a1c2g'])
})

// ---------------------------------------------------------------------------
// 5. Bounds
// ---------------------------------------------------------------------------

/** Deterministic id in UUID form, so sizes match real ids. */
const uuid = (n) => {
  const hex = (n * 2654435761 >>> 0).toString(16).padStart(8, '0')
  return `${hex}-${String(n % 10000).padStart(4, '0')}-4abc-8def-${String(n).padStart(12, '0')}`
}

/**
 * A synthetic store: `roots` top-level sessions in `workspaces` workspaces (every
 * seventh in none, over three loose folders), each root with up to three
 * subagent children, a third of the roots archived, a few live members.
 */
const syntheticStore = ({ roots, workspaces = 12, sync = false, title = (n) => `Session ${n}: refactor the parser and fix tests` }) => {
  const snapshots = []
  const registered = Array.from({ length: workspaces }, () => [])
  const archived = []
  const live = []
  const mtimes = {}
  const titles = {}
  let serial = 0
  const add = (parent, folder) => {
    const id = uuid(serial)
    serial += 1
    snapshots.push(snap(id, { parent, origin: parent === null ? null : 'subagent', sizeBytes: 10_000 + (serial * 7919) % 5_000_000, path: `${ROOT}/${folder}/${id}/session.v4.jsonl.zstd` }))
    mtimes[id] = NOW - (1 + (serial * 31) % 400) * DAY
    titles[id] = title(serial)
    return id
  }
  for (let n = 0; n < roots; n += 1) {
    const unassigned = n % 7 === 6
    const folder = unassigned ? `--tmp-loose-${n % 3}--` : `--work-project-${n % workspaces}--`
    const id = add(null, folder)
    if (!unassigned) registered[n % workspaces].push(id)
    if (n % 3 === 1) archived.push(id)
    for (let c = 0; c < n % 4; c += 1) {
      const kid = add(id, folder)
      if (n % 3 === 1 && c === 0) archived.push(kid)
      if (n % 50 === 1 && c === 1) live.push(kid)
    }
  }
  return hostOver({
    snapshots,
    workspaces: registered.map((sessionIds, w) => ({ id: uuid(900_000 + w), name: `project-${w}`, path: `/Users/me/projects/project-${w}`, sessionIds })),
    archived, live, mtimes, titles, sync,
  })
}

test('bounds: aggregating 5,000 synthetic rows takes less than 1 s (best of three)', async (t) => {
  const times = []
  let rows = 0
  for (let run = 0; run < 3; run += 1) {
    const host = syntheticStore({ roots: 2000, sync: true }) // 2,000 roots + 3,000 children
    const start = performance.now()
    const index = await build(host, { folderBytes: (dir) => dir.length * 100 })
    const dto = overview(index)
    const page = archivedPage(index)
    archivedPage(index, { sort: 'title', text: 'session 1' })
    times.push(performance.now() - start)
    rows = index.rows.length
    assertOverview(dto)
    assertArchivedPage(page)
  }
  t.diagnostic(`rows ${rows}; build + overview + two archived pages: ${times.map((ms) => ms.toFixed(1)).join(', ')} ms`)
  assert.equal(rows, 5000)
  // Best of three: one slow run on a shared CI runner (842 ms seen) is noise; a real regression is slow every time.
  assert.ok(Math.min(...times) < 1000, `the best run is under 1000 ms (${times.map((ms) => ms.toFixed(1)).join(', ')})`)
})

test('bounds: the overview JSON for 500 sessions is under 64 KB', async (t) => {
  const host = syntheticStore({ roots: 200, workspaces: 40 }) // 200 roots + 300 children
  const index = await build(host)
  assert.equal(index.rows.length, 500)
  const dto = overview(index)
  assertOverview(dto)
  const size = byteLength(dto)
  t.diagnostic(`overview of ${index.rows.length} sessions in ${dto.workspaces.length} table rows: ${size} bytes`)
  assert.ok(size < 64 * 1024, `${size} bytes`)
})

test('bounds: the Unassigned rows are capped, so many loose folders cannot grow the overview', async () => {
  const snapshots = Array.from({ length: 200 }, (_, n) => snap(`s${n}`, { path: `${ROOT}/--folder-${String(n).padStart(3, '0')}--/s${n}/log` }))
  const index = await build(hostOver({ snapshots }))
  const { workspaces } = overview(index)
  assert.ok(workspaces.length <= 50, `${workspaces.length} table rows`)
  assert.equal(workspaces.reduce((n, row) => n + row.sessions, 0), 200, 'the overflow is folded, not dropped')
  assert.equal(workspaces.at(-1).folder, null)
})

test('bounds: an archived page of 500 rows is under 300 KB, even with long titles', async (t) => {
  const host = syntheticStore({ roots: 1500, title: (n) => `${'A long, descriptive session title '.repeat(10)}${n}` })
  const index = await build(host)
  const page = archivedPage(index, { limit: 500 })
  assertArchivedPage(page)
  assert.equal(page.rows.length, 500)
  const size = byteLength(page)
  t.diagnostic(`archived page of ${page.rows.length} rows (${page.total} roots): ${size} bytes`)
  assert.ok(size < 300 * 1024, `${size} bytes`)
})

// ---------------------------------------------------------------------------
// 6. Contract and purity
// ---------------------------------------------------------------------------

test('outputs over the seeded fake HostFacts pass the contract validators and match an independent count', async () => {
  for (const seed of [1, 2, 7]) {
    const facts = createFakeHostFacts({ seed })
    const snapshots = await facts.snapshots()
    const archived = new Set(await facts.archivedIds())
    const index = await buildIndex(facts, { config: CONFIG, now: facts.now })
    const dto = overview(index)
    assertOverview(dto)
    assert.equal(dto.totals.sessions, snapshots.length)
    assert.equal(dto.totals.unreadable, snapshots.filter((s) => s.unreadable).length)
    assert.equal(dto.totals.children, snapshots.filter((s) => !s.unreadable && s.parentId !== null).length)
    assert.equal(dto.totals.archived, snapshots.filter((s) => archived.has(s.id)).length)
    assert.equal(dto.totals.bytes, snapshots.reduce((n, s) => n + s.bytes, 0))
    assert.equal(dto.workspaces.reduce((n, row) => n + row.sessions, 0), snapshots.length)
    const units = buildUnits(snapshots, archived)
    assert.equal(dto.totals.archivedRoots, units.length)
    assert.equal(dto.totals.reclaimableUnits + dto.totals.blockedUnits, units.length)
    const page = archivedPage(index, { limit: 500 })
    assertArchivedPage(page)
    assert.equal(page.total, units.length)
    assert.deepEqual(new Set(ids(page)), new Set(units.map((u) => u.rootId)))
    const fork = page.rows.find((r) => r.id === facts.specials.forkParent)
    if (fork) assert.ok(reasonsOf(fork).includes(`kept-descendant:${facts.specials.fork}`), 'the registered user fork keeps its tree')
    for (const sort of ['bytes', 'lastActivityAt', 'title']) assertArchivedPage(archivedPage(index, { sort, text: 'session', offset: 3, limit: 40 }))
  }
})

test('output does not depend on the order of the snapshots', async () => {
  const host = referenceStore()
  const snapshots = await host.snapshots()
  const reversed = referenceStore({ snapshots: [...snapshots].reverse() })
  const [a, b] = await Promise.all([build(host), build(reversed)])
  assert.deepEqual(overview(a), overview(b))
  assert.deepEqual(archivedPage(a, { sort: 'title' }), archivedPage(b, { sort: 'title' }))
  assert.deepEqual(a.rows, b.rows)
})

test('buildIndex calls only the read methods of HostFacts and never a registry step', async () => {
  const host = referenceStore()
  await build(host)
  const used = new Set(host.calls.map(([name]) => name))
  for (const name of used) assert.ok(['snapshots', 'workspaces', 'archivedIds', 'pinnedIds', 'liveIds', 'lockState', 'statLog', 'titleOf'].includes(name), name)
  assert.equal(host.calls.filter(([name]) => name === 'snapshots').length, 1, 'one listing per build')
  for (const [name, arg] of host.calls.filter(([n]) => n === 'lockState')) assert.ok(arg.startsWith(`${ROOT}/`), `${name} ${arg}`)
})

test('buildIndex validates its inputs', async () => {
  const host = referenceStore()
  await assert.rejects(buildIndex(host, { now: NOW }), TypeError, 'config is required')
  await assert.rejects(buildIndex(host, { config: { ...CONFIG, listLimit: 0 } , now: NOW }), TypeError)
  await assert.rejects(buildIndex(host, { config: { ...CONFIG, allowPermanentDelete: 'yes' }, now: NOW }), TypeError)
  await assert.rejects(buildIndex(host, { config: CONFIG }), TypeError, 'now is required')
  await assert.rejects(buildIndex(host, { config: CONFIG, now: NOW, folderBytes: 'x' }), TypeError)
  await assert.rejects(buildIndex({ ...host, titleOf: undefined }, { config: CONFIG, now: NOW }), TypeError)
  await assert.rejects(buildIndex(hostOver({ snapshots: 'nope' }), { config: CONFIG, now: NOW }), TypeError)
  assert.throws(() => overview({}), TypeError)
  assert.throws(() => archivedPage(null), TypeError)
})

test('the module imports only ./contract.js and ./lineage.js and reads no environment', () => {
  const source = readFileSync(SOURCE, 'utf8')
  const imports = source.split('\n').filter((line) => /^import\b/.test(line))
  assert.ok(imports.length > 0)
  for (const line of imports) assert.match(line, /from '\.\/(contract|lineage)\.js'$/)
  assert.doesNotMatch(source, /process[.]env|homedir|require\(|import\(/)
  assert.doesNotMatch(source, /\.open\(|search\(/, 'no log open and no search call')
})

test('every refusal code a page row carries is a contract code', async () => {
  const index = await build(referenceStore())
  for (const row of archivedPage(index).rows) for (const { code } of row.reasons) assert.ok(REFUSAL_CODES.includes(code), code)
})
