// Tests for the lineage engine (src/lineage.js): prune units over arbitrary
// parent graphs, the refusal rules, the scope filter, the plan digest and the
// plan diff, plus seeded property tests and parity with the reference cascade
// (docs/reference/prune-archived-sessions.py:70-81, re-implemented below).
// Pure data in memory: the only file read is the module's own source, for the
// purity check. Nothing touches the real DSH home or session store.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { ContractError, ERROR, REFUSAL_CODES, assertApplyResult, assertPlan } from '../src/contract.js'
import { buildUnits, collectFacts, diffPlan, evaluate, planDigest, selectScope, unitDigest } from '../src/lineage.js'
import { createFakeHostFacts } from './helpers/fixtures.mjs'

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0)
const MINUTE = 60_000
const DAY = 86_400_000
const STORE = '/store'
const CONFIG = Object.freeze({ recentActivityMinutes: 30 })
const OLD = NOW - 10 * DAY

const dirOf = (id) => `${STORE}/ws/${id}`
const logOf = (id) => `${dirOf(id)}/session.jsonl`
const row = (id, parentId = null, extra = {}) => ({
  id, parentId, dir: dirOf(id), logPath: logOf(id), bytes: 100, mtimeMs: OLD, revision: 1, ...extra,
})
const members = (units) => units.map((unit) => unit.memberIds)
const reasonsOf = (unit) => unit.reasons.map(({ code, sessionId }) => `${code}:${sessionId}`)

/** Facts under which no refusal applies; `overrides` replaces single members. */
const benignFacts = (overrides = {}) => ({
  liveIds: [],
  workspaces: [],
  storeRoot: STORE,
  lockState: () => ({ state: 'none', pid: null }),
  statLog: () => ({ exists: true, isSymlink: false, mtimeMs: OLD, bytes: 1, dev: 1 }),
  ...overrides,
})

// ---------------------------------------------------------------------------
// The reference cascade, line for line (prune-archived-sessions.py:70-81).
// `info` holds the stored ids, `parent` maps a child to its parentSession.
// It also returns `seen` before the intersection, for the orphan checks.
// ---------------------------------------------------------------------------
const cascade = (archived, info, parent) => {
  const kids = new Map()
  for (const [child, par] of parent) {
    if (!kids.has(par)) kids.set(par, [])
    kids.get(par).push(child)
  }
  const seen = new Set()
  const stack = [...archived]
  while (stack.length > 0) {
    const sid = stack.pop()
    if (seen.has(sid)) continue
    seen.add(sid)
    stack.push(...(kids.get(sid) ?? []))
  }
  return { result: new Set([...seen].filter((sid) => info.has(sid))), seen }
}

const referenceFor = (rows, archivedIds) => {
  const readable = rows.filter((r) => r.unreadable !== true)
  const info = new Set(readable.map((r) => r.id))
  const parent = new Map(readable.filter((r) => r.parentId).map((r) => [r.id, r.parentId]))
  return cascade(archivedIds, info, parent)
}

// ---------------------------------------------------------------------------
// Criterion 1: buildUnits
// ---------------------------------------------------------------------------

test('buildUnits: a unit is the top-most archived root plus every descendant, root first, parents before children', () => {
  const rows = [row('c2', 'r'), row('g1', 'c1'), row('r'), row('c1', 'r'), row('x'), row('x1', 'x')]
  const units = buildUnits(rows, ['r'])
  assert.equal(units.length, 1)
  const [unit] = units
  assert.equal(unit.rootId, 'r')
  assert.deepEqual(unit.memberIds, ['r', 'c1', 'g1', 'c2'])
  assert.deepEqual(unit.members.map((m) => m.id), unit.memberIds)
  assert.equal(unit.bytes, 400)
  assert.equal(unit.cycle, false)
  assert.deepEqual(unit.cycleIds, [])
  assert.equal(unit.orphan, false)
  assert.equal(unit.anchorId, 'r')
  assert.deepEqual(unit.externalParents, [])
  assert.equal(unit.lastActivityMs, OLD)
  const child = unit.members.find((m) => m.id === 'c1')
  assert.deepEqual(child, {
    id: 'c1', parentId: 'r', dir: dirOf('c1'), logPath: logOf('c1'), bytes: 100, mtimeMs: OLD, revision: 1, archived: false,
    duplicate: false,
    legacy: false,
  })
})

test('buildUnits: an archived session below another archived session joins the ancestor unit', () => {
  const rows = [row('r'), row('c', 'r'), row('g', 'c'), row('h', 'g')]
  const units = buildUnits(rows, ['g', 'c', 'r'])
  assert.deepEqual(members(units), [['r', 'c', 'g', 'h']])
  assert.deepEqual(units[0].members.map((m) => m.archived), [true, true, true, false])
})

test('buildUnits: separate trees give disjoint units sorted by root id', () => {
  const rows = [row('b'), row('b1', 'b'), row('a'), row('a1', 'a'), row('c'), row('c1', 'c')]
  const units = buildUnits(rows, ['c', 'a'])
  assert.deepEqual(members(units), [['a', 'a1'], ['c', 'c1']])
})

test('buildUnits: an archived child of a non-archived parent is its own unit and records the existing parent', () => {
  const rows = [row('p'), row('k', 'p'), row('k1', 'k'), row('p2', 'p')]
  const units = buildUnits(rows, ['k'])
  assert.deepEqual(members(units), [['k', 'k1']])
  assert.deepEqual(units[0].externalParents, [{ sessionId: 'k', parentId: 'p' }])
})

test('buildUnits: a self-parent gives a unit marked cycle', () => {
  const units = buildUnits([row('s', 's'), row('s1', 's'), row('t', 't')], ['s'])
  assert.equal(units.length, 1, 'a non-archived self-parent is not a unit')
  assert.equal(units[0].rootId, 's')
  assert.equal(units[0].cycle, true)
  assert.deepEqual(units[0].cycleIds, ['s'])
  assert.deepEqual(units[0].memberIds, ['s', 's1'])
  assert.deepEqual(units[0].externalParents, [], 'the self link is inside the unit')
})

test('buildUnits: a ring gives one cycle unit rooted at its smallest archived member, with the hanging descendants', () => {
  // m -> n -> o -> m, with d hanging below n and e below d.
  const rows = [row('n', 'm'), row('o', 'n'), row('m', 'o'), row('d', 'n'), row('e', 'd')]
  const units = buildUnits(rows, ['o', 'n'])
  assert.equal(units.length, 1)
  const [unit] = units
  assert.equal(unit.cycle, true)
  assert.equal(unit.rootId, 'n')
  assert.deepEqual(unit.cycleIds, ['m', 'n', 'o'])
  assert.deepEqual(unit.memberIds, ['n', 'd', 'e', 'o', 'm'])
  // A two-node ring.
  const pair = buildUnits([row('u', 'v'), row('v', 'u')], ['v'])
  assert.deepEqual(members(pair), [['v', 'u']])
  assert.equal(pair[0].cycle, true)
})

test('buildUnits: a ring above an archived session does not mark its unit; the root keeps its parent outside', () => {
  const rows = [row('p', 'q'), row('q', 'p'), row('a', 'p'), row('a1', 'a')]
  const units = buildUnits(rows, ['a'])
  assert.deepEqual(members(units), [['a', 'a1']])
  assert.equal(units[0].cycle, false)
  assert.deepEqual(units[0].externalParents, [{ sessionId: 'a', parentId: 'p' }])
})

test('buildUnits: ids missing from rows are ignored, as in the reference cascade', () => {
  // ghost is archived but has no stored log; its stored children still go, as in the reference.
  const rows = [row('a'), row('k1', 'ghost'), row('kk', 'k1'), row('k2', 'ghost'), row('b', 'nobody'), row('z', 'ghost2')]
  const archived = ['ghost', 'a', 'b', 'missing-without-children']
  const units = buildUnits(rows, archived)
  assert.deepEqual(members(units), [['a'], ['b'], ['k1', 'kk'], ['k2']])
  const all = units.flatMap((u) => u.memberIds)
  for (const id of ['ghost', 'missing-without-children', 'nobody', 'ghost2', 'z']) assert.ok(!all.includes(id), id)
  const k1 = units.find((u) => u.rootId === 'k1')
  assert.equal(k1.orphan, true)
  assert.equal(k1.anchorId, 'ghost')
  assert.deepEqual(k1.externalParents, [], 'a missing parent is not an existing parent')
  const b = units.find((u) => u.rootId === 'b')
  assert.equal(b.orphan, false)
  assert.deepEqual(b.externalParents, [])
  assert.deepEqual(new Set(all), referenceFor(rows, archived).result)
})

test('buildUnits: unreadable rows are never members but count as existing parents', () => {
  const rows = [
    row('u', null, { unreadable: true }), row('uc', 'u'), // unreadable archived parent with a readable child
    row('r'), row('ru', 'r', { unreadable: true }), // unreadable child of an archived root: its parent link is unknown
  ]
  const units = buildUnits(rows, ['u', 'r'])
  assert.deepEqual(members(units), [['r'], ['uc']])
  const uc = units.find((u) => u.rootId === 'uc')
  assert.equal(uc.orphan, true)
  assert.equal(uc.anchorId, 'u')
  assert.deepEqual(uc.externalParents, [{ sessionId: 'uc', parentId: 'u' }])
})

test('buildUnits: a duplicated id keeps one canonical row whatever the input order and is flagged', () => {
  const first = row('d', 'r', { dir: '/store/b/d', logPath: '/store/b/d/session.jsonl', bytes: 7 })
  const second = row('d', 'r', { dir: '/store/a/d', logPath: '/store/a/d/session.jsonl', bytes: 9 })
  const forward = buildUnits([row('r'), first, second], ['r'])
  const backward = buildUnits([second, row('r'), first], ['r'])
  assert.deepEqual(forward, backward)
  const member = forward[0].members.find((m) => m.id === 'd')
  assert.equal(member.dir, '/store/a/d')
  assert.equal(member.duplicate, true)
  // Two copies with different parents link both trees into one unit, never two.
  const split = buildUnits([row('r'), row('s'), row('d', 'r'), row('d', 's', { dir: '/store/x/d', logPath: '/store/x/d/l' })], ['r', 's'])
  assert.equal(split.length, 1)
  assert.deepEqual(split[0].memberIds, ['r', 'd', 's'])
})

test('buildUnits: traversal is iterative (a chain of 100,000 sessions and a ring of 100,000)', () => {
  const n = 100_000
  const chain = Array.from({ length: n }, (_, i) => row(`c${i}`, i === 0 ? null : `c${i - 1}`))
  const [unit] = buildUnits(chain, ['c0'])
  assert.equal(unit.memberIds.length, n)
  assert.equal(unit.memberIds[n - 1], `c${n - 1}`)
  const ring = Array.from({ length: n }, (_, i) => row(`r${i}`, `r${(i + 1) % n}`))
  const [loop] = buildUnits(ring, [`r${n - 1}`])
  assert.equal(loop.cycle, true)
  assert.equal(loop.memberIds.length, n)
  assert.equal(loop.cycleIds.length, n)
  const [evaluated] = evaluate([unit], benignFacts(), CONFIG, NOW)
  assert.equal(evaluated.status, 'ready')
})

test('buildUnits: input is not mutated, and bad input is refused', () => {
  const rows = [row('r'), row('c', 'r')]
  const archived = ['r']
  const before = JSON.stringify([rows, archived])
  buildUnits(rows, archived)
  assert.equal(JSON.stringify([rows, archived]), before)
  assert.throws(() => buildUnits(null, []), TypeError)
  assert.throws(() => buildUnits([], 'r'), TypeError)
  assert.throws(() => buildUnits([], null), TypeError)
  assert.deepEqual(buildUnits([], new Set(['r'])), [])
  // Rows without a usable id are skipped; non-string archived ids are ignored.
  assert.deepEqual(members(buildUnits([null, { id: 7 }, { id: '' }, row('r')], ['r', 42])), [['r']])
})

// ---------------------------------------------------------------------------
// Criterion 2: evaluate, one case per refusal code
// ---------------------------------------------------------------------------

/** Unit r (r -> c -> g, archived root in ws-a) and an unrelated unit q (q -> q1). */
const scenario = ({ rows: mutateRows = (rows) => rows, facts = {} } = {}) => {
  const rows = mutateRows([row('r'), row('c', 'r'), row('g', 'c'), row('q'), row('q1', 'q')])
  const units = buildUnits(rows, ['r', 'q'])
  const out = evaluate(units, benignFacts({ workspaces: [{ id: 'ws-a', sessionIds: ['r', 'q'] }], ...facts }), CONFIG, NOW)
  return { r: out.find((u) => u.rootId === 'r'), q: out.find((u) => u.rootId === 'q'), out }
}
const expectBlocked = (unit, reasons) => {
  assert.equal(unit.status, 'blocked')
  assert.deepEqual(reasonsOf(unit), reasons)
}
const expectReady = (unit) => {
  assert.equal(unit.status, 'ready')
  assert.deepEqual(unit.reasons, [])
}

test('evaluate: no refusal leaves both units ready, with the root workspace', () => {
  const { r, q } = scenario()
  expectReady(r)
  expectReady(q)
  assert.equal(r.workspaceId, 'ws-a')
})

test('evaluate: live (a member is in liveIds) blocks the whole unit', () => {
  const { r, q } = scenario({ facts: { liveIds: ['g'] } })
  expectBlocked(r, ['live:g'])
  expectReady(q)
})

test('evaluate: locked (lockState held, or unknown) blocks; a stale lock does not', () => {
  const lockOf = (map) => (folder) => ({ state: map[folder] ?? 'none', pid: 1 })
  const held = scenario({ facts: { lockState: lockOf({ [dirOf('g')]: 'held' }) } })
  expectBlocked(held.r, ['locked:g'])
  expectReady(held.q)
  expectReady(scenario({ facts: { lockState: lockOf({ [dirOf('g')]: 'stale' }) } }).r)
  expectBlocked(scenario({ facts: { lockState: lockOf({ [dirOf('g')]: 'mystery' }) } }).r, ['locked:g'])
  expectBlocked(scenario({ facts: { lockState: () => null } }).r, ['locked:r', 'locked:c', 'locked:g'])
  // The lock is asked for the session folder.
  const asked = []
  scenario({ facts: { lockState: (folder) => { asked.push(folder); return { state: 'none', pid: null } } } })
  assert.ok(asked.includes(dirOf('g')))
})

test('evaluate: recent (log mtime within recentActivityMinutes) blocks; the window edge and the future count', () => {
  const statAt = (mtimeMs) => (path) => ({ exists: true, isSymlink: false, mtimeMs: path === logOf('g') ? mtimeMs : OLD, bytes: 1, dev: 1 })
  const recent = scenario({ facts: { statLog: statAt(NOW - 5 * MINUTE) } })
  expectBlocked(recent.r, ['recent:g'])
  expectReady(recent.q)
  expectBlocked(scenario({ facts: { statLog: statAt(NOW - 30 * MINUTE + 1) } }).r, ['recent:g'])
  expectReady(scenario({ facts: { statLog: statAt(NOW - 30 * MINUTE) } }).r)
  expectBlocked(scenario({ facts: { statLog: statAt(NOW + DAY) } }).r, ['recent:g']) // a future mtime is recent
  // The row's own mtime counts too (the newer of row and lstat wins).
  expectBlocked(scenario({ rows: (rows) => rows.map((r) => (r.id === 'g' ? { ...r, mtimeMs: NOW - MINUTE } : r)) }).r, ['recent:g'])
  // The evaluated unit carries its newest activity.
  assert.equal(recent.r.lastActivityMs, NOW - 5 * MINUTE)
})

test('evaluate: kept-descendant (a registered, non-archived member) blocks; an archived registered member does not', () => {
  const fork = scenario({ facts: { workspaces: [{ id: 'ws-a', sessionIds: ['r', 'q', 'g'] }] } })
  expectBlocked(fork.r, ['kept-descendant:g'])
  expectReady(fork.q)
  const rows = [row('r'), row('c', 'r'), row('g', 'c')]
  const archivedFork = evaluate(buildUnits(rows, ['r', 'g']), benignFacts({ workspaces: [{ id: 'w', sessionIds: ['r', 'g'] }] }), CONFIG, NOW)
  expectReady(archivedFork[0])
  // The discriminator can be replaced (T3): keptIds wins over workspace membership.
  const replaced = evaluate(buildUnits(rows, ['r']), benignFacts({ workspaces: [{ id: 'w', sessionIds: ['r', 'g'] }], keptIds: ['c'] }), CONFIG, NOW)
  expectBlocked(replaced[0], ['kept-descendant:c'])
  // An orphan root (under a missing archived parent) that is registered is a kept fork too.
  const orphan = evaluate(buildUnits([row('k', 'ghost')], ['ghost']), benignFacts({ workspaces: [{ id: 'w', sessionIds: ['k'] }] }), CONFIG, NOW)
  expectBlocked(orphan[0], ['kept-descendant:k'])
})

test('evaluate: parent-kept (the root has an existing parent outside the unit) blocks', () => {
  const { r, q } = scenario({ rows: (rows) => [...rows.map((x) => (x.id === 'r' ? { ...x, parentId: 'p' } : x)), row('p')] })
  expectBlocked(r, ['parent-kept:r'])
  expectReady(q)
  // A parent that is not stored does not block.
  expectReady(scenario({ rows: (rows) => rows.map((x) => (x.id === 'r' ? { ...x, parentId: 'gone' } : x)) }).r)
})

test('evaluate: cycle blocks, with one reason per ring member', () => {
  const ring = scenario({ rows: (rows) => rows.map((x) => (x.id === 'r' ? { ...x, parentId: 'g' } : x)) })
  expectBlocked(ring.r, ['cycle:r', 'cycle:c', 'cycle:g'])
  expectReady(ring.q)
  const self = scenario({ rows: (rows) => rows.map((x) => (x.id === 'r' ? { ...x, parentId: 'r' } : x)) })
  expectBlocked(self.r, ['cycle:r'])
})

test('evaluate: path-unsafe blocks every unsafe location', () => {
  const variants = {
    'dot-dot segment': { dir: '/store/ws/../ws/g', logPath: '/store/ws/../ws/g/session.jsonl' },
    'relative dir': { dir: 'store/ws/g', logPath: 'store/ws/g/session.jsonl' },
    'log outside the folder': { logPath: '/store/ws/other/session.jsonl' },
    'folder not named by the id': { dir: '/store/ws/h', logPath: '/store/ws/h/session.jsonl' },
    'outside the store root': { dir: '/elsewhere/g', logPath: '/elsewhere/g/session.jsonl' },
    'double slash': { dir: '/store//ws/g', logPath: '/store//ws/g/session.jsonl' },
    'trailing slash': { dir: '/store/ws/g/', logPath: '/store/ws/g/session.jsonl' },
    'control character': { dir: '/store/ws\n/g', logPath: '/store/ws\n/g/session.jsonl' },
    backslash: { dir: '/store/ws\\x/g', logPath: '/store/ws\\x/g/session.jsonl' },
  }
  for (const [name, change] of Object.entries(variants)) {
    const { r, q } = scenario({ rows: (rows) => rows.map((x) => (x.id === 'g' ? { ...x, ...change } : x)) })
    assert.equal(r.status, 'blocked', name)
    assert.deepEqual(reasonsOf(r), ['path-unsafe:g'], name)
    expectReady(q)
  }
  const ids = { separator: 'g/x', 'dot-dot': 'g..x', 'leading dot': '.g' }
  for (const [name, id] of Object.entries(ids)) {
    const rows = [row('r'), { ...row('c', 'r'), id }]
    const [unit] = evaluate(buildUnits(rows, ['r']), benignFacts(), CONFIG, NOW)
    assert.deepEqual(reasonsOf(unit), [`path-unsafe:${id}`], name)
  }
  // A symlinked log or session folder (lstat), a log stat without isSymlink, a duplicated id.
  const symlinked = (target) => (path) => ({ exists: true, isSymlink: path === target, mtimeMs: OLD, bytes: 1, dev: 1 })
  expectBlocked(scenario({ facts: { statLog: symlinked(logOf('g')) } }).r, ['path-unsafe:g'])
  expectBlocked(scenario({ facts: { statLog: symlinked(dirOf('g')) } }).r, ['path-unsafe:g'])
  expectBlocked(scenario({ facts: { statLog: (path) => ({ exists: true, mtimeMs: OLD, bytes: 1, dev: 1, ...(path === logOf('g') ? {} : { isSymlink: false }) }) } }).r, ['path-unsafe:g'])
  const copy = row('g', 'c', { dir: '/store/zz/g', logPath: '/store/zz/g/session.jsonl' })
  expectBlocked(scenario({ rows: (rows) => [...rows, copy] }).r, ['path-unsafe:g'])
  // A store root that is not a clean absolute path makes every location unsafe.
  const badRoot = scenario({ facts: { storeRoot: 'relative' } })
  expectBlocked(badRoot.q, ['path-unsafe:q', 'path-unsafe:q1'])
  // Without a store root, containment is not checked, everything else is.
  expectReady(scenario({ facts: { storeRoot: null } }).r)
})

test('evaluate: no-location blocks a member without a folder or log, or whose log is gone', () => {
  for (const change of [{ dir: null }, { logPath: null }, { dir: '' }, { logPath: undefined }]) {
    const { r, q } = scenario({ rows: (rows) => rows.map((x) => (x.id === 'g' ? { ...x, ...change } : x)) })
    expectBlocked(r, ['no-location:g'])
    expectReady(q)
  }
  const gone = (path) => ({ exists: path !== logOf('g'), isSymlink: false, mtimeMs: OLD, bytes: 1, dev: 1 })
  expectBlocked(scenario({ facts: { statLog: gone } }).r, ['no-location:g'])
  expectBlocked(scenario({ facts: { statLog: (path) => (path === logOf('g') ? null : benignFacts().statLog(path)) } }).r, ['no-location:g'])
})

test('evaluate: legacy-format blocks the whole unit of a member row flagged legacy (migration-required, D14)', () => {
  const { r, q } = scenario({ rows: (rows) => rows.map((x) => (x.id === 'g' ? { ...x, legacy: true } : x)) })
  expectBlocked(r, ['legacy-format:g'])
  expectReady(q)
  assert.ok(r.members.find((m) => m.id === 'g').legacy)
  // A legacy root and a legacy orphan root are refused too; `legacy: false` or no flag is not.
  expectBlocked(scenario({ rows: (rows) => rows.map((x) => (x.id === 'r' ? { ...x, legacy: true } : x)) }).r, ['legacy-format:r'])
  const orphan = evaluate(buildUnits([row('k', 'ghost', { legacy: true })], ['ghost']), benignFacts(), CONFIG, NOW)
  expectBlocked(orphan[0], ['legacy-format:k'])
  expectReady(scenario({ rows: (rows) => rows.map((x) => (x.id === 'g' ? { ...x, legacy: false } : x)) }).r)
  // It sorts by member, then by code order, next to the other refusals.
  const mixed = scenario({ rows: (rows) => rows.map((x) => (x.id === 'c' ? { ...x, legacy: true } : x)), facts: { liveIds: ['c', 'g'] } })
  expectBlocked(mixed.r, ['live:c', 'legacy-format:c', 'live:g'])
  // The flag is part of the plan digest: a log that turns legacy changes the plan.
  const plain = buildUnits([row('r'), row('c', 'r')], ['r'])
  const flagged = buildUnits([row('r'), row('c', 'r', { legacy: true })], ['r'])
  assert.notEqual(planDigest(plain), planDigest(flagged))
  assert.deepEqual(diffPlan(plain, flagged).map((d) => d.rootId), ['r'])
})

test('evaluate: all or nothing, reasons sorted by member then code, deduplicated, valid against the contract', () => {
  const lockOf = (folder) => ({ state: folder === dirOf('c') ? 'held' : 'none', pid: 1 })
  const { r, q, out } = scenario({
    rows: (rows) => [...rows.map((x) => (x.id === 'r' ? { ...x, parentId: 'p' } : x)), row('p')],
    facts: { liveIds: ['g', 'c', 'g'], lockState: lockOf, workspaces: [{ id: 'ws-a', sessionIds: ['r', 'q', 'g'] }, { id: 'ws-b', sessionIds: ['g'] }] },
  })
  expectBlocked(r, ['parent-kept:r', 'live:c', 'locked:c', 'live:g', 'kept-descendant:g'])
  expectReady(q)
  for (const reason of r.reasons) {
    assert.ok(REFUSAL_CODES.includes(reason.code))
    assert.deepEqual(Object.keys(reason), ['code', 'sessionId'])
  }
  // The evaluated units map straight onto the Plan DTO.
  const dtoUnits = out.map((u) => ({ rootId: u.rootId, memberIds: u.memberIds, bytes: u.bytes, workspaceId: u.workspaceId, status: u.status, reasons: u.reasons }))
  const ready = dtoUnits.filter((u) => u.status === 'ready')
  const sum = (list, pick) => list.reduce((n, u) => n + pick(u), 0)
  assertPlan({
    planId: 'p1', expiresAt: NOW, digest: planDigest(out), units: dtoUnits,
    totals: {
      units: dtoUnits.length, ready: ready.length, blocked: dtoUnits.length - ready.length, sessions: sum(dtoUnits, (u) => u.memberIds.length),
      readySessions: sum(ready, (u) => u.memberIds.length), bytes: sum(dtoUnits, (u) => u.bytes), readyBytes: sum(ready, (u) => u.bytes),
    },
    byWorkspace: [],
  })
})

test('evaluate: does not mutate its input and is idempotent', () => {
  const units = buildUnits([row('r'), row('c', 'r')], ['r'])
  const before = JSON.stringify(units)
  const once = evaluate(units, benignFacts({ liveIds: ['c'] }), CONFIG, NOW)
  assert.equal(JSON.stringify(units), before)
  assert.equal(units[0].status, undefined)
  assert.deepEqual(evaluate(once, benignFacts({ liveIds: ['c'] }), CONFIG, NOW), once)
  assert.deepEqual(evaluate(once, benignFacts(), CONFIG, NOW)[0].reasons, [], 'old reasons are not carried over')
})

test('evaluate: refuses promises from facts and bad config or clock', () => {
  const units = buildUnits([row('r')], ['r'])
  assert.throws(() => evaluate(units, benignFacts({ lockState: async () => ({ state: 'none' }) }), CONFIG, NOW), /collectFacts/)
  assert.throws(() => evaluate(units, benignFacts({ statLog: async () => ({}) }), CONFIG, NOW), /collectFacts/)
  assert.throws(() => evaluate(units, benignFacts(), CONFIG, undefined), TypeError)
  assert.throws(() => evaluate(units, benignFacts(), CONFIG, Number.NaN), TypeError)
  assert.throws(() => evaluate(units, benignFacts(), {}, NOW), TypeError)
  assert.throws(() => evaluate(units, benignFacts(), { recentActivityMinutes: -1 }, NOW), TypeError)
  assert.throws(() => evaluate(units, null, CONFIG, NOW), TypeError)
  assert.throws(() => evaluate(units, benignFacts({ lockState: undefined }), CONFIG, NOW), TypeError)
  assert.throws(() => evaluate(units, benignFacts({ workspaces: undefined }), CONFIG, NOW), TypeError)
  assert.throws(() => evaluate(units, benignFacts({ liveIds: undefined }), CONFIG, NOW), TypeError)
  assert.throws(() => evaluate('units', benignFacts(), CONFIG, NOW), TypeError)
})

test('collectFacts + evaluate over the fake HostFacts: the user fork, live, held and stale locks, recent activity', async () => {
  const host = createFakeHostFacts()
  const [snapshots, archivedIds] = await Promise.all([host.snapshots(), host.archivedIds()])
  const units = buildUnits(snapshots, archivedIds)
  // In the fixture only top-level sessions start archived trees: one unit per readable archived root.
  const archivedRoots = snapshots.filter((s) => s.parentId === null && !s.unreadable && archivedIds.includes(s.id)).map((s) => s.id)
  assert.ok(archivedRoots.length >= 40)
  assert.deepEqual(units.map((u) => u.rootId), archivedRoots.sort())
  const facts = await collectFacts(host, units, { storeRoot: '/fake/store' })
  const out = evaluate(units, facts, CONFIG, host.now)
  assert.deepEqual(out.map((u) => u.rootId), units.map((u) => u.rootId))

  // Independent oracle over the fake's own state.
  const live = new Set(await host.liveIds())
  const registered = new Set((await host.workspaces()).flatMap((w) => w.sessionIds))
  const archived = new Set(archivedIds)
  const byId = new Map(snapshots.map((s) => [s.id, s]))
  const held = snapshots[40].id
  const recent = snapshots[60].id
  let refusals = 0
  for (const unit of out) {
    const expected = []
    for (const id of unit.memberIds) {
      if (live.has(id)) expected.push(`live:${id}`)
      if (id === held) expected.push(`locked:${id}`)
      if (id === recent) expected.push(`recent:${id}`)
      if (registered.has(id) && !archived.has(id)) expected.push(`kept-descendant:${id}`)
    }
    assert.deepEqual(reasonsOf(unit), expected, unit.rootId)
    assert.equal(unit.status, expected.length ? 'blocked' : 'ready')
    refusals += expected.length
    for (const id of unit.memberIds) assert.equal(byId.get(id).unreadable, false, 'unreadable snapshots are never members')
  }
  assert.ok(host.specials.fork, 'the fixture holds a user fork')
  const forkUnit = out.find((u) => u.memberIds.includes(host.specials.fork))
  assert.equal(forkUnit.rootId, host.specials.forkParent)
  assert.ok(reasonsOf(forkUnit).includes(`kept-descendant:${host.specials.fork}`))
  assert.ok(refusals >= 1)
  // The stale lock never blocks.
  const stale = snapshots[41].id
  for (const unit of out) assert.ok(!reasonsOf(unit).includes(`locked:${stale}`))
  // The reference cascade agrees on the membership.
  assert.deepEqual(new Set(units.flatMap((u) => u.memberIds)), referenceFor(snapshots, archivedIds).result)
  // Read-only: collectFacts made no registry call.
  assert.deepEqual(host.calls, [])
})

test('collectFacts never hands an unsafe path to the host and fails safe for paths it did not collect', async () => {
  const asked = []
  const host = {
    liveIds: () => ['x'],
    workspaces: async () => [{ id: 'w', name: 'w', path: '/w', sessionIds: ['r'] }],
    lockState: async (folder) => { asked.push(['lock', folder]); return { state: 'none', pid: null } },
    statLog: async (path) => { asked.push(['stat', path]); return { exists: true, isSymlink: false, mtimeMs: OLD, bytes: 1, dev: 1 } },
  }
  const rows = [row('r'), row('c', 'r', { dir: '/store/../c', logPath: '/store/../c/l' }), row('d', 'r')]
  const units = buildUnits(rows, ['r'])
  const facts = await collectFacts(host, units, { storeRoot: STORE })
  for (const [, path] of asked) assert.ok(!path.includes('..'), path)
  assert.deepEqual(asked.filter(([kind]) => kind === 'lock').map(([, p]) => p), [dirOf('r'), dirOf('d')])
  assert.deepEqual(facts.liveIds, ['x'])
  assert.equal(facts.storeRoot, STORE)
  assert.notEqual(facts.lockState('/never/asked').state, 'none')
  assert.equal(facts.statLog('/never/asked').exists, false)
  const [unit] = evaluate(units, facts, CONFIG, NOW)
  assert.deepEqual(reasonsOf(unit), ['path-unsafe:c'])
})

// ---------------------------------------------------------------------------
// Criterion 3: selectScope
// ---------------------------------------------------------------------------

const scopeUnits = () => {
  const rows = [
    row('a', null, { mtimeMs: NOW - 40 * DAY }), row('a1', 'a', { mtimeMs: NOW - 2 * DAY }), // old root, recent child
    row('b', null, { mtimeMs: NOW - 40 * DAY }), row('b1', 'b', { mtimeMs: NOW - 31 * DAY }),
    row('c', null, { mtimeMs: NOW - 30 * DAY }),
    row('d', null, { mtimeMs: null, lastActivityAt: undefined }),
  ]
  return buildUnits(rows, ['a', 'b', 'c', 'd'])
}

test('selectScope: all returns every unit', () => {
  const units = scopeUnits()
  const all = selectScope(units, { scope: 'all' }, NOW)
  assert.deepEqual(all, units)
  assert.notEqual(all, units, 'a new array')
})

test("selectScope: olderThan is measured on the unit's newest activity", () => {
  const units = scopeUnits()
  const roots = (scope, now = NOW) => selectScope(units, scope, now).map((u) => u.rootId)
  assert.deepEqual(roots({ scope: 'olderThan', olderThanDays: 30 }), ['b', 'c'], 'a: its child is 2 days old; d: unknown activity')
  assert.deepEqual(roots({ scope: 'olderThan', olderThanDays: 31 }), ['b'])
  assert.deepEqual(roots({ scope: 'olderThan', olderThanDays: 30 }, NOW - 1), ['b'], 'the edge: exactly N days counts')
  assert.deepEqual(roots({ scope: 'olderThan', olderThanDays: 0 }), ['a', 'b', 'c'])
  assert.deepEqual(roots({ scope: 'olderThan', olderThanDays: 365 }), [])
  // Evaluated units use the lstat activity as well (b1 was just touched; d has no log, so its activity stays unknown).
  const statLog = (path) => ({ exists: path !== logOf('d'), isSymlink: false, mtimeMs: path === logOf('b1') ? NOW - DAY : 0, bytes: 1, dev: 1 })
  const evaluated = evaluate(units, benignFacts({ statLog }), CONFIG, NOW)
  assert.deepEqual(selectScope(evaluated, { scope: 'olderThan', olderThanDays: 30 }, NOW).map((u) => u.rootId), ['c'])
  assert.throws(() => selectScope(units, { scope: 'olderThan', olderThanDays: -1 }, NOW), (e) => e instanceof ContractError && e.code === ERROR.invalidRequest)
  assert.throws(() => selectScope(units, { scope: 'olderThan', olderThanDays: 1.5 }, NOW), ContractError)
  assert.throws(() => selectScope(units, { scope: 'olderThan', olderThanDays: 1 }, undefined), TypeError)
})

test('selectScope: selection takes unit root ids only; any other id is rejected and never expanded', () => {
  const units = scopeUnits()
  const roots = units.map((u) => u.rootId)
  assert.deepEqual(roots, ['a', 'b', 'c', 'd'])
  assert.deepEqual(selectScope(units, { scope: 'selection', rootIds: ['c', 'a', 'c'] }, NOW).map((u) => u.rootId), ['a', 'c'])
  assert.deepEqual(selectScope(units, { scope: 'selection', rootIds: [] }, NOW), [])
  for (const rootIds of [['a', 'a1'], ['a1'], ['nope'], ['a', 7], ['b1', 'a1', 'b']]) {
    assert.throws(
      () => selectScope(units, { scope: 'selection', rootIds }, NOW),
      (error) => {
        assert.ok(error instanceof ContractError)
        assert.equal(error.code, ERROR.invalidRequest)
        assert.deepEqual(error.rejectedIds, rootIds.filter((id) => !roots.includes(id)).map(String).sort())
        return true
      },
    )
  }
  assert.throws(() => selectScope(units, { scope: 'selection' }, NOW), ContractError)
  assert.throws(() => selectScope(units, { scope: 'everything' }, NOW), ContractError)
  assert.throws(() => selectScope(units, null, NOW), ContractError)
  assert.throws(() => selectScope('units', { scope: 'all' }, NOW), TypeError)
})

// ---------------------------------------------------------------------------
// Criterion 6: planDigest and diffPlan
// ---------------------------------------------------------------------------

const digestRows = () => [row('r', null, { revision: 3 }), row('c', 'r', { revision: 5 }), row('s'), row('s1', 's')]

test('planDigest covers id, bytes, mtimeMs and revision of every member, and ignores unit and member order', () => {
  const units = buildUnits(digestRows(), ['r', 's'])
  const digest = planDigest(units)
  assert.match(digest, /^sha256-[0-9a-f]{64}$/)
  assert.equal(planDigest(buildUnits([...digestRows()].reverse(), ['s', 'r'])), digest)
  const reordered = [...units].reverse().map((u) => ({ ...u, members: [...u.members].reverse() }))
  assert.equal(planDigest(reordered), digest)
  for (const change of [{ id: 'c2' }, { bytes: 101 }, { mtimeMs: OLD + 1 }, { revision: 6 }]) {
    const rows = digestRows().map((x) => (x.id === 'c' ? { ...x, ...change } : x))
    assert.notEqual(planDigest(buildUnits(rows, ['r', 's'])), digest, JSON.stringify(change))
  }
  assert.notEqual(planDigest(units.slice(1)), digest)
  // The refusals of evaluated units are covered too (the Plan DTO digest).
  const ready = evaluate(units, benignFacts(), CONFIG, NOW)
  const blocked = evaluate(units, benignFacts({ liveIds: ['c'] }), CONFIG, NOW)
  assert.notEqual(planDigest(ready), planDigest(blocked))
  assert.equal(unitDigest(ready[0]), unitDigest(blocked[0]), 'unitDigest covers facts only')
  assert.match(unitDigest(units[0]), /^sha256-[0-9a-f]{64}$/)
})

test('diffPlan: unchanged units give nothing', () => {
  const old = buildUnits(digestRows(), ['r', 's'])
  assert.deepEqual(diffPlan(old, buildUnits([...digestRows()].reverse(), ['s', 'r'])), [])
  assert.deepEqual(diffPlan(evaluate(old, benignFacts(), CONFIG, NOW), buildUnits(digestRows(), ['r', 's'])), [])
})

test('diffPlan: a changed member gives changed with that member', () => {
  const old = buildUnits(digestRows(), ['r', 's'])
  for (const change of [{ bytes: 1 }, { mtimeMs: NOW }, { revision: 99 }]) {
    const fresh = buildUnits(digestRows().map((x) => (x.id === 'c' ? { ...x, ...change } : x)), ['r', 's'])
    assert.deepEqual(diffPlan(old, fresh), [{ rootId: 'r', reasons: [{ code: 'changed', sessionId: 'c' }] }])
  }
  const grown = buildUnits([...digestRows(), row('c9', 'c')], ['r', 's'])
  assert.deepEqual(diffPlan(old, grown), [{ rootId: 'r', reasons: [{ code: 'changed', sessionId: 'c9' }] }])
  const shrunk = buildUnits(digestRows().filter((x) => x.id !== 's1'), ['r', 's'])
  assert.deepEqual(diffPlan(old, shrunk), [{ rootId: 's', reasons: [{ code: 'changed', sessionId: 's1' }] }])
  // The root now hangs below a newly archived parent: the unit is different.
  const nested = buildUnits([...digestRows().map((x) => (x.id === 's' ? { ...x, parentId: 'top' } : x)), row('top')], ['r', 's', 'top'])
  assert.deepEqual(diffPlan(old, nested), [{ rootId: 's', reasons: [{ code: 'changed', sessionId: 's' }] }])
})

test('diffPlan: a root that is no longer archived gives not-archived', () => {
  const old = buildUnits(digestRows(), ['r', 's'])
  const fresh = buildUnits(digestRows(), ['s'])
  const diff = diffPlan(old, fresh)
  assert.deepEqual(diff, [{ rootId: 'r', reasons: [{ code: 'not-archived', sessionId: 'r' }] }])
  assertApplyResult({ batchId: null, trashDir: '/t', state: 'complete', moved: { units: 0, sessions: 0, bytes: 0 }, skipped: diff, warnings: [] })
  // Unarchived but still swept below a newly archived parent: not-archived as well.
  const below = buildUnits([...digestRows().map((x) => (x.id === 's' ? { ...x, parentId: 'top' } : x)), row('top')], ['r', 'top'])
  assert.deepEqual(diffPlan(old, below), [{ rootId: 's', reasons: [{ code: 'not-archived', sessionId: 's' }] }])
  // An orphan unit whose missing archived anchor was unarchived.
  const orphanOld = buildUnits([row('k', 'ghost')], ['ghost'])
  assert.deepEqual(diffPlan(orphanOld, buildUnits([row('k', 'ghost')], [])), [{ rootId: 'k', reasons: [{ code: 'not-archived', sessionId: 'k' }] }])
})

test('diffPlan: a root that left the store is changed when archivedIds says it is still archived', () => {
  const old = buildUnits(digestRows(), ['r', 's'])
  const fresh = buildUnits(digestRows().filter((x) => x.id !== 'r' && x.id !== 'c'), ['r', 's'])
  assert.deepEqual(diffPlan(old, fresh, { archivedIds: ['r', 's'] }), [{ rootId: 'r', reasons: [{ code: 'changed', sessionId: 'r' }] }])
  assert.deepEqual(diffPlan(old, fresh), [{ rootId: 'r', reasons: [{ code: 'not-archived', sessionId: 'r' }] }])
  assert.throws(() => diffPlan(null, fresh), TypeError)
  assert.throws(() => diffPlan(old, 'fresh'), TypeError)
})

// ---------------------------------------------------------------------------
// Criteria 4 and 5: seeded property tests and parity with the reference cascade
// ---------------------------------------------------------------------------

const SEED = Number.parseInt(process.env.LINEAGE_SEED ?? '20261117', 10) >>> 0
const ARBITRARY_GRAPHS = 2500
const CLEAN_GRAPHS = 1500

/** mulberry32. */
const prng = (seed) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const graphSeed = (index) => (SEED + Math.imul(index + 1, 0x9E3779B1)) >>> 0
const shuffle = (rand, list) => {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
/** Ids whose sort order is unrelated to their creation order. */
const makeIds = (rand, n) => {
  const used = new Set()
  const ids = []
  while (ids.length < n) {
    const id = `s${Math.floor(rand() * 36 ** 4).toString(36)}`
    if (!used.has(id)) { used.add(id); ids.push(id) }
  }
  return ids
}

/**
 * Arbitrary graph: self-parents, cycles, dangling parents, nested archived
 * roots, archived ids without a stored log, unreadable rows, and random facts
 * (live, locks, recent, registered forks, unsafe paths, missing logs).
 */
/** A fixed ~4% of the ids are legacy rows, by id, so the random streams of the generators stay as they were. */
const isLegacyId = (id) => [...id].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 25 === 0

const arbitraryGraph = (rand) => {
  const n = 1 + Math.floor(rand() * 48)
  const ids = makeIds(rand, n)
  const ghosts = makeIds(rand, 3).map((id) => `g${id}`)
  const flags = new Map()
  const rows = ids.map((id, i) => {
    const roll = rand()
    let parentId = null
    if (roll < 0.2) parentId = null
    else if (roll < 0.25) parentId = id
    else if (roll < 0.35) parentId = ghosts[Math.floor(rand() * ghosts.length)]
    else if (roll < 0.85 && i > 0) parentId = ids[Math.floor(rand() * i)]
    else parentId = ids[Math.floor(rand() * n)]
    const f = rand()
    const flag = f < 0.03 ? 'unsafe' : f < 0.06 ? 'missing-log' : f < 0.09 ? 'recent' : f < 0.12 ? 'held' : f < 0.15 ? 'stale' : null
    flags.set(id, flag)
    const dir = flag === 'unsafe' ? `store/ws/${id}` : `${STORE}/ws/${id}`
    return { id, parentId, dir, logPath: `${dir}/log`, bytes: Math.floor(rand() * 1000), mtimeMs: OLD - Math.floor(rand() * DAY), revision: Math.floor(rand() * 9), unreadable: rand() < 0.04, legacy: isLegacyId(id) }
  })
  const archivedIds = [...ids.filter(() => rand() < 0.3), ...ghosts.filter(() => rand() < 0.5)]
  const liveIds = ids.filter(() => rand() < 0.03)
  const registered = ids.filter(() => rand() < 0.15)
  return { rows, archivedIds, liveIds, registered, flags }
}

const factsFor = (graph, rand = null) => {
  const flagOfDir = new Map(graph.rows.map((r) => [r.dir, graph.flags.get(r.id)]))
  const flagOfLog = new Map(graph.rows.map((r) => [r.logPath, graph.flags.get(r.id)]))
  const order = (list) => (rand ? shuffle(rand, list) : list)
  return {
    liveIds: order(graph.liveIds),
    workspaces: [{ id: 'w', name: 'w', path: '/w', sessionIds: order(graph.registered) }],
    storeRoot: STORE,
    lockState: (folder) => {
      const flag = flagOfDir.get(folder)
      return { state: flag === 'held' ? 'held' : flag === 'stale' ? 'stale' : 'none', pid: null }
    },
    statLog: (path) => {
      if (flagOfDir.has(path)) return { exists: true, isSymlink: false, mtimeMs: OLD, bytes: 0, dev: 1 }
      const flag = flagOfLog.get(path)
      if (!flagOfLog.has(path) || flag === 'missing-log') return { exists: false, isSymlink: false, mtimeMs: 0, bytes: 0, dev: 0 }
      return { exists: true, isSymlink: false, mtimeMs: flag === 'recent' ? NOW - 3 * MINUTE : OLD, bytes: 1, dev: 1 }
    },
  }
}

/** Parent map over readable rows (the store as the engine sees it). */
const parentMap = (rows) => new Map(rows.filter((r) => r.unreadable !== true && r.parentId).map((r) => [r.id, r.parentId]))

const checkInvariants = (graph, units, evaluated) => {
  const readable = new Map(graph.rows.filter((r) => r.unreadable !== true).map((r) => [r.id, r]))
  const existing = new Set(graph.rows.map((r) => r.id))
  const archived = new Set(graph.archivedIds)
  const parents = parentMap(graph.rows)
  const ref = referenceFor(graph.rows, graph.archivedIds)

  // Units are pairwise disjoint, and each lists its root first.
  const owner = new Map()
  for (const unit of units) {
    assert.equal(unit.memberIds[0], unit.rootId)
    assert.equal(new Set(unit.memberIds).size, unit.memberIds.length)
    assert.deepEqual(unit.members.map((m) => m.id), unit.memberIds)
    assert.equal(unit.bytes, unit.members.reduce((n, m) => n + m.bytes, 0))
    for (const id of unit.memberIds) {
      assert.ok(!owner.has(id), `${id} is in two units`)
      owner.set(id, unit.rootId)
      assert.ok(readable.has(id), `${id} is not a readable stored session`)
    }
  }
  // Each unit is descendant-closed in the store.
  for (const r of readable.values()) {
    if (r.parentId && owner.has(r.parentId)) assert.equal(owner.get(r.id), owner.get(r.parentId), `${r.id} left out of its parent unit`)
  }
  // Units are sorted by root id; parents come before children outside rings.
  const roots = units.map((u) => u.rootId)
  assert.deepEqual(roots, [...roots].sort())
  for (const unit of units) {
    const at = new Map(unit.memberIds.map((id, i) => [id, i]))
    const ring = new Set(unit.cycleIds)
    for (const id of unit.memberIds) {
      const p = parents.get(id)
      if (id !== unit.rootId && !ring.has(id)) assert.ok(at.get(p) < at.get(id), `${id} before its parent ${p}`)
    }
    // The root is the top-most archived session, or an orphan below a missing archived id.
    if (archived.has(unit.rootId)) assert.equal(unit.orphan, false)
    else {
      assert.equal(unit.orphan, true)
      const p = parents.get(unit.rootId)
      assert.ok(!readable.has(p) && archived.has(p) && unit.anchorId === p, `orphan ${unit.rootId}`)
    }
    if (!unit.cycle) assert.ok(!owner.has(parents.get(unit.rootId)) || owner.get(parents.get(unit.rootId)) !== unit.rootId)
    // cycle is marked exactly when the unit holds a directed cycle, and cycleIds are the ring members
    // (oracle: walking up from a ring member inside the unit comes back to it).
    const onRing = []
    for (const id of unit.memberIds) {
      const seen = new Set()
      let cur = parents.get(id)
      while (at.has(cur) && cur !== id && !seen.has(cur)) { seen.add(cur); cur = parents.get(cur) }
      if (cur === id) onRing.push(id)
    }
    assert.deepEqual(unit.cycleIds, onRing.sort())
    assert.equal(unit.cycle, onRing.length > 0)
  }
  // Structural parity: the members are exactly cascade(archived) ∩ stored.
  assert.deepEqual(new Set(owner.keys()), ref.result)

  // Evaluated units: same units in the same order; blocked exactly when reasons exist; oracle reasons.
  assert.deepEqual(evaluated.map((u) => u.rootId), roots)
  const live = new Set(graph.liveIds)
  const registered = new Set(graph.registered)
  for (const unit of evaluated) {
    assert.equal(unit.status, unit.reasons.length > 0 ? 'blocked' : 'ready')
    const expected = new Set()
    for (const m of unit.members) {
      const flag = graph.flags.get(m.id)
      if (live.has(m.id)) expected.add(`live:${m.id}`)
      if (flag === 'unsafe') expected.add(`path-unsafe:${m.id}`)
      if (flag === 'missing-log') expected.add(`no-location:${m.id}`)
      if (flag === 'held') expected.add(`locked:${m.id}`)
      if (flag === 'recent') expected.add(`recent:${m.id}`)
      if (graph.rows.find((r) => r.id === m.id)?.legacy === true) expected.add(`legacy-format:${m.id}`)
      if (registered.has(m.id) && !archived.has(m.id)) expected.add(`kept-descendant:${m.id}`)
      const p = parents.get(m.id)
      if (p && existing.has(p) && !unit.memberIds.includes(p)) expected.add(`parent-kept:${m.id}`)
    }
    for (const id of unit.cycleIds) expected.add(`cycle:${id}`)
    assert.deepEqual(new Set(reasonsOf(unit)), expected, unit.rootId)
    assert.equal(reasonsOf(unit).length, expected.size, 'no duplicate reasons')
  }
  // A blocked unit contributes no id; after the ready units leave, no remaining session has a removed ancestor.
  const removed = new Set(evaluated.filter((u) => u.status === 'ready').flatMap((u) => u.memberIds))
  for (const unit of evaluated) if (unit.status === 'blocked') for (const id of unit.memberIds) assert.ok(!removed.has(id))
  for (const id of readable.keys()) {
    if (removed.has(id)) continue
    const seen = new Set([id])
    for (let cur = parents.get(id); cur !== undefined && !seen.has(cur); cur = parents.get(cur)) {
      seen.add(cur)
      assert.ok(!removed.has(cur), `${id} remains while its ancestor ${cur} is removed`)
    }
  }
  return { removed, ref, reasons: evaluated.reduce((n, u) => n + u.reasons.length, 0) }
}

const runProperty = (t, count, body) => {
  for (let index = 0; index < count; index += 1) {
    const seed = graphSeed(index)
    try {
      body(prng(seed), index)
    } catch (error) {
      const where = `lineage property failed: LINEAGE_SEED=${SEED} graph ${index} (graph seed ${seed})`
      console.error(where)
      throw new Error(`${where}: ${error.message}`, { cause: error })
    }
  }
  t.diagnostic(`seed ${SEED}: ${count} random graphs`)
}

test(`property: ${ARBITRARY_GRAPHS} arbitrary graphs keep every invariant and the reference membership`, (t) => {
  let refusalFree = 0
  let cycles = 0
  let orphans = 0
  let nested = 0
  let legacyUnits = 0
  runProperty(t, ARBITRARY_GRAPHS, (rand) => {
    const graph = arbitraryGraph(rand)
    const units = buildUnits(graph.rows, graph.archivedIds)
    const evaluated = evaluate(units, factsFor(graph), CONFIG, NOW)
    const { removed, ref, reasons } = checkInvariants(graph, units, evaluated)
    // Criterion 5: when no refusal applies, what a prune takes is cascade(archived) ∩ stored.
    if (reasons === 0) {
      refusalFree += 1
      assert.deepEqual(removed, ref.result)
    }
    legacyUnits += evaluated.filter((u) => u.reasons.some((x) => x.code === 'legacy-format')).length
    cycles += units.filter((u) => u.cycle).length
    orphans += units.filter((u) => u.orphan).length
    nested += units.filter((u) => u.members.filter((m) => m.archived).length > 1).length
    // Deterministic: shuffled rows, archived ids and facts give the same output.
    const again = evaluate(buildUnits(shuffle(rand, graph.rows), shuffle(rand, graph.archivedIds)), factsFor(graph, rand), CONFIG, NOW)
    assert.deepEqual(again, evaluated)
    assert.equal(planDigest(again), planDigest(evaluated))
  })
  t.diagnostic(`refusal-free graphs ${refusalFree}, cycle units ${cycles}, orphan units ${orphans}, units with nested archived members ${nested}`)
  assert.ok(cycles > 100 && orphans > 100 && nested > 100 && legacyUnits > 100, 'the generator reaches every shape')
})

/**
 * Refusal-free graph: a forest (with dangling and missing archived parents)
 * whose archived sessions are top-level, below a missing parent, or below
 * another archived tree, with no live, locked, recent or registered member.
 */
const cleanGraph = (rand) => {
  const n = 1 + Math.floor(rand() * 60)
  const ids = makeIds(rand, n)
  const ghosts = makeIds(rand, 3).map((id) => `g${id}`)
  const archivedGhosts = ghosts.filter(() => rand() < 0.5)
  const archived = new Set(archivedGhosts)
  const swept = new Set(archivedGhosts)
  const rows = ids.map((id, i) => {
    const roll = rand()
    const parentId = roll < 0.3 || i === 0 ? null : roll < 0.4 ? ghosts[Math.floor(rand() * ghosts.length)] : ids[Math.floor(rand() * i)]
    const parentKept = parentId !== null && ids.includes(parentId) && !swept.has(parentId)
    if (!parentKept && rand() < 0.4) archived.add(id)
    if (archived.has(id) || (parentId !== null && swept.has(parentId))) swept.add(id)
    return { id, parentId, dir: `${STORE}/ws/${id}`, logPath: `${STORE}/ws/${id}/log`, bytes: Math.floor(rand() * 1000), mtimeMs: OLD, revision: i }
  })
  const registered = ids.filter((id) => (!swept.has(id) || archived.has(id)) && rand() < 0.5)
  return { rows, archivedIds: [...archived], liveIds: [], registered, flags: new Map() }
}

test(`property: ${CLEAN_GRAPHS} refusal-free graphs prune exactly the reference cascade, and one refusal blocks only its unit`, (t) => {
  const codes = new Map()
  runProperty(t, CLEAN_GRAPHS, (rand) => {
    const graph = cleanGraph(rand)
    const units = buildUnits(shuffle(rand, graph.rows), shuffle(rand, graph.archivedIds))
    const facts = factsFor(graph)
    const evaluated = evaluate(units, facts, CONFIG, NOW)
    const { removed, ref } = checkInvariants(graph, units, evaluated)
    for (const unit of evaluated) assert.equal(unit.status, 'ready')
    assert.deepEqual(removed, ref.result, 'parity with cascade(archived) ∩ stored')
    if (units.length === 0) return
    // All or nothing: one refusal on one random member blocks its whole unit and nothing else.
    const target = units[Math.floor(rand() * units.length)]
    const member = target.members[Math.floor(rand() * target.members.length)]
    const choices = ['live', 'locked', 'recent', 'no-location', 'path-unsafe', 'legacy-format', ...(member.archived ? [] : ['kept-descendant'])]
    const code = choices[Math.floor(rand() * choices.length)]
    const hit = { ...facts }
    if (code === 'live') hit.liveIds = [member.id]
    if (code === 'locked') hit.lockState = (folder) => ({ state: folder === member.dir ? 'held' : 'none', pid: 1 })
    if (code === 'recent') hit.statLog = (path) => ({ ...facts.statLog(path), ...(path === member.logPath ? { mtimeMs: NOW - MINUTE } : {}) })
    if (code === 'no-location') hit.statLog = (path) => ({ ...facts.statLog(path), ...(path === member.logPath ? { exists: false } : {}) })
    if (code === 'path-unsafe') hit.statLog = (path) => ({ ...facts.statLog(path), ...(path === member.dir ? { isSymlink: true } : {}) })
    if (code === 'kept-descendant') hit.workspaces = [{ id: 'w', name: 'w', path: '/w', sessionIds: [...graph.registered, member.id] }]
    let hitUnits = units
    if (code === 'legacy-format') {
      const legacyRows = graph.rows.map((r) => (r.id === member.id ? { ...r, legacy: true } : r))
      hitUnits = buildUnits(shuffle(rand, legacyRows), shuffle(rand, graph.archivedIds))
    }
    const after = evaluate(hitUnits, hit, CONFIG, NOW)
    for (const unit of after) {
      if (unit.rootId === target.rootId) {
        assert.equal(unit.status, 'blocked')
        assert.deepEqual(unit.reasons, [{ code, sessionId: member.id }])
      } else assert.equal(unit.status, 'ready')
    }
    codes.set(code, (codes.get(code) ?? 0) + 1)
  })
  t.diagnostic(`single refusals injected: ${JSON.stringify(Object.fromEntries(codes))}`)
})

// ---------------------------------------------------------------------------
// Criterion 7: the module is pure
// ---------------------------------------------------------------------------

test('lineage.js is pure: no fs, no clock, no environment, no host service', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lineage.js'), 'utf8')
  const imports = [...source.matchAll(/^import .* from '([^']+)'$/gm)].map((m) => m[1])
  assert.deepEqual(imports.sort(), ['./contract.js', 'node:crypto'])
  for (const pattern of [/node:fs/, /Date\.now/, /new Date\(/, /require\(/, /process\./, /homedir/, /performance\.now/, /\bimport\(/]) {
    assert.ok(!pattern.test(source), `lineage.js matches ${pattern}`)
  }
})
