// Deterministic fixtures for dsh-plugin-sessions tests: a fake HostFacts over a
// seeded forest of 400+ sessions, and one valid DTO per validator.
// Pure data in memory: no file system, no environment, no clock.

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0)
const DAY = 86_400_000
const STORE = '/fake/store'

/** mulberry32: a small seeded PRNG, so the forest is identical on every run. */
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

const WORKSPACES = [
  { id: 'ws-alpha', name: 'alpha', path: '/fake/work/alpha' },
  { id: 'ws-beta', name: 'beta', path: '/fake/work/beta' },
  { id: 'ws-gamma', name: 'gamma', path: '/fake/work/gamma' },
]

/**
 * Builds the forest: top-level sessions in three workspaces (every ninth in none),
 * subagent children and grandchildren (unregistered, linked by parentId), about a
 * third of the roots archived with their subtrees, one user fork under an archived
 * root, and a few live, pinned, locked and recently active sessions.
 */
const buildForest = (seed) => {
  const rand = prng(seed)
  const pick = (n) => Math.floor(rand() * n)
  const snapshots = []
  const workspaceIds = new Map(WORKSPACES.map((w) => [w.id, []]))
  const archived = new Set()
  const pinned = new Set()
  const live = new Set()
  const locks = new Map()
  const titles = new Map()
  const specials = { fork: null, forkParent: null }

  const add = (parentId, n) => {
    const id = `s${String(snapshots.length).padStart(4, '0')}`
    const ageDays = 1 + pick(400)
    const lastActivityAt = NOW - ageDays * DAY - pick(DAY)
    const createdAt = lastActivityAt - pick(30) * DAY
    const group = new Date(createdAt).toISOString().slice(0, 7)
    const dir = `${STORE}/${group}/${id}`
    snapshots.push({
      id, parentId, dir, logPath: `${dir}/events.jsonl`, group,
      bytes: 1024 + pick(5_000_000), events: 1 + pick(4000), createdAt, lastActivityAt, unreadable: n % 97 === 96,
    })
    if (rand() < 0.7) titles.set(id, `Session ${id}`)
    return id
  }

  for (let n = 0; snapshots.length < 440; n += 1) {
    const rootId = add(null, n)
    const unassigned = n % 9 === 8
    if (!unassigned) workspaceIds.get(WORKSPACES[n % WORKSPACES.length].id).push(rootId)
    const isArchived = n % 3 === 1
    if (isArchived) archived.add(rootId)
    if (n % 31 === 0) pinned.add(rootId)
    const children = n % 4 === 0 ? 0 : 1 + pick(3)
    for (let c = 0; c < children; c += 1) {
      const childId = add(rootId, n)
      if (isArchived && rand() < 0.8) archived.add(childId)
      if (rand() < 0.3) {
        const grandId = add(childId, n)
        if (isArchived && rand() < 0.8) archived.add(grandId)
      }
      if (isArchived && c === 0 && specials.fork === null && n > 30) {
        // A user fork: a registered, non-archived top-level session linked to an archived parent.
        specials.fork = childId
        specials.forkParent = rootId
        archived.delete(childId)
        workspaceIds.get(WORKSPACES[n % WORKSPACES.length].id)?.push(childId)
      }
    }
  }
  // A few live, locked and recently active sessions; their ids come from fixed positions.
  for (const index of [5, 17, 101, 233]) live.add(snapshots[index].id)
  locks.set(snapshots[40].dir, { state: 'held', pid: 4242 })
  locks.set(snapshots[41].dir, { state: 'stale', pid: 4243 })
  snapshots[60].lastActivityAt = NOW - 5 * 60_000
  return { snapshots, workspaceIds, archived, pinned, live, locks, titles, specials }
}

/**
 * A fake HostFacts over the seeded forest. Registry steps mutate the fake's own
 * state and are recorded in `calls` as [name, ...args], in order.
 * @param {{ seed?: number }} [options]
 */
export function createFakeHostFacts({ seed = 1 } = {}) {
  const forest = buildForest(seed)
  const workspaceIds = new Map([...forest.workspaceIds].map(([id, list]) => [id, [...list]]))
  const archived = new Set(forest.archived)
  const pinned = new Set(forest.pinned)
  const live = new Set(forest.live)
  const stats = new Map(forest.snapshots.map((s) => [s.logPath, { exists: true, isSymlink: false, mtimeMs: s.lastActivityAt, bytes: s.bytes, dev: 1 }]))
  const calls = []
  const record = (...call) => { calls.push(call) }
  const copy = (list) => list.map((item) => ({ ...item }))

  return {
    calls,
    specials: { ...forest.specials },
    now: NOW,
    async snapshots() { return copy(forest.snapshots) },
    async workspaces() {
      return WORKSPACES.map((w) => ({ id: w.id, name: w.name, path: w.path, sessionIds: [...workspaceIds.get(w.id)] }))
    },
    async archivedIds() { return [...archived] },
    async pinnedIds() { return [...pinned] },
    async liveIds() { return [...live] },
    async lockState(folder) { return { ...(forest.locks.get(folder) ?? { state: 'none', pid: null }) } },
    async statLog(path) { return { ...(stats.get(path) ?? { exists: false, isSymlink: false, mtimeMs: 0, bytes: 0, dev: 0 }) } },
    async titleOf(id) { return forest.titles.get(id) ?? null },
    async unpin(id) { record('unpin', id); pinned.delete(id) },
    async detach(id) { record('detach', id); for (const list of workspaceIds.values()) { const at = list.indexOf(id); if (at >= 0) list.splice(at, 1) } },
    async unarchive(id) { record('unarchive', id); archived.delete(id) },
    async attach(id, workspaceId) {
      record('attach', id, workspaceId)
      const list = workspaceIds.get(workspaceId)
      if (list && !list.includes(id)) list.push(id)
    },
    async archive(id) { record('archive', id); archived.add(id) },
    async pin(id) { record('pin', id); pinned.add(id) },
  }
}

// ---------------------------------------------------------------------------
// DTO fixtures. Each call returns a fresh object, so tests can mutate it.
// ---------------------------------------------------------------------------

const MB = 1024 * 1024

export const overviewFixture = () => ({
  generatedAt: NOW,
  storeDir: `${STORE}`,
  capabilities: { prune: true, reason: null },
  config: { allowPermanentDelete: true, recentActivityMinutes: 30, listLimit: 500, refreshMs: 0, indexWarnBytes: 256 * MB },
  totals: {
    sessions: 426, live: 3, archived: 80, children: 312, unreadable: 1, bytes: 579 * MB, archivedBytes: 239 * MB,
    archivedRoots: 80, archivedChildren: 126, reclaimableBytes: 437 * MB, reclaimableUnits: 206, blockedUnits: 0, archivedMissing: 1,
  },
  indexLoad: 'high',
  workspaces: [
    { id: 'ws-alpha', name: 'alpha', path: '/fake/work/alpha', folder: null, sessions: 82, archived: 20, bytes: 2200 * MB, lastActivityAt: NOW - DAY },
    { id: null, name: null, path: null, folder: '2026-09', sessions: 7, archived: 0, bytes: 3 * MB, lastActivityAt: null },
  ],
  largest: [
    { id: 's0007', title: 'Session s0007', workspaceId: 'ws-alpha', bytes: 115 * MB, events: 3900, lastActivityAt: NOW - 2 * DAY, live: false, archived: true, child: false },
    { id: 's0008', title: null, workspaceId: null, bytes: 90 * MB, events: 1200, lastActivityAt: NOW - 9 * DAY, live: true, archived: false, child: true },
  ],
})

export const archivedPageFixture = () => ({
  total: 2,
  offset: 0,
  limit: 50,
  rows: [
    { id: 's0001', title: 'Session s0001', workspaceId: 'ws-alpha', bytes: 4 * MB, childCount: 3, lastActivityAt: NOW - 40 * DAY, ageDays: 40, blocked: false, reasons: [], orphan: false },
    {
      id: 's0004', title: null, workspaceId: null, bytes: 9 * MB, childCount: 0, lastActivityAt: NOW - 60 * DAY, ageDays: 60, blocked: true,
      reasons: [{ code: 'live', sessionId: 's0004' }, { code: 'kept-descendant', sessionId: 's0006' }], orphan: false,
    },
  ],
})

export const planFixture = () => {
  const units = [
    { rootId: 's0001', memberIds: ['s0001', 's0002', 's0003'], bytes: 4 * MB, workspaceId: 'ws-alpha', status: 'ready', reasons: [] },
    { rootId: 's0010', memberIds: ['s0010'], bytes: 2 * MB, workspaceId: 'ws-beta', status: 'ready', reasons: [] },
    { rootId: 's0020', memberIds: ['s0020', 's0021'], bytes: 6 * MB, workspaceId: null, status: 'blocked', reasons: [{ code: 'recent', sessionId: 's0021' }] },
  ]
  const ready = units.filter((u) => u.status === 'ready')
  const total = (list, pick) => list.reduce((n, u) => n + pick(u), 0)
  return {
    planId: 'plan-0f3a9c',
    expiresAt: NOW + 10 * 60_000,
    digest: 'sha256-2f1a0c9e',
    units,
    totals: {
      units: units.length, ready: ready.length, blocked: units.length - ready.length,
      sessions: total(units, (u) => u.memberIds.length), readySessions: total(ready, (u) => u.memberIds.length),
      bytes: total(units, (u) => u.bytes), readyBytes: total(ready, (u) => u.bytes),
    },
    byWorkspace: [
      { workspaceId: 'ws-alpha', units: 1, sessions: 3, bytes: 4 * MB },
      { workspaceId: 'ws-beta', units: 1, sessions: 1, bytes: 2 * MB },
    ],
  }
}

export const applyResultFixture = () => ({
  batchId: 'b-20261117T203000Z-a1b2',
  trashDir: '/fake/state/sessions-manager/trash',
  state: 'complete',
  moved: { units: 2, sessions: 4, bytes: 6 * MB },
  skipped: [{ rootId: 's0020', reasons: [{ code: 'changed', sessionId: 's0021' }] }],
  warnings: [{ code: 'stale-backend-entry', sessionId: 's0001' }],
})

export const trashListFixture = () => ({
  trashDir: '/fake/state/sessions-manager/trash',
  batches: [
    { batchId: 'b-20261117T203000Z-a1b2', createdAt: NOW, units: 2, sessions: 4, bytes: 6 * MB, state: 'complete' },
    { batchId: 'b-20261110T090000Z-c3d4', createdAt: NOW - 7 * DAY, units: 1, sessions: 1, bytes: MB, state: 'needs-recovery' },
  ],
})

export const unarchiveResultFixture = () => ({
  unarchived: ['s0001'],
  skipped: [{ id: 's0004', code: 'not-archived' }],
})

export const purgeResultFixture = () => ({ batchId: 'b-20261110T090000Z-c3d4', removedSessions: 1, removedBytes: MB })
