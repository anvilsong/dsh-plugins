// Sandbox session store for the integration test of dsh-plugin-sessions.
//
// createSandbox() builds, under fs.mkdtemp(os.tmpdir()), a store laid out like
// the JSONL backend's: <root>/store/sessions/<workspaceDir>/<id>/ with an
// opaque session.v4.jsonl.zstd and an empty session.lock per session. The full
// layout holds more than 400 sessions: archived trees with children and
// grandchildren, nested archived roots, a live member, a recent member, a
// member whose session lock another writer holds, a user fork, an archived
// child of a kept parent, a parent cycle, a legacy-format log, unsafe folders
// and ids, and sessions in no workspace. The compact layout keeps the shapes
// a prune and a restore exercise, for the kill-point matrix.
//
// The host side is fake but behaves like the services recorded in
// docs/store-safety.md: a persistence backend that scans the folder on every
// list() and stat() (so a moved folder is gone at once, S1), an in-memory
// workspace registry with the host's errors, a live-session service and a
// projection cache. The backend throws (and records a violation) if anything
// opens or reads a session log body or calls search.
//
// startProcess() mounts one SessionsManagerService on its own Cordis Context:
// one "process" with its own pid, its own view of the fakes and its own
// file-system wrappers. The wrappers refuse any path outside the sandbox and
// any log-body open, count every call, and can kill the process at a chosen
// fs call, registry call or audit write: that call (and everything after it)
// fails or hangs, as if the process had died there. bury() then closes the
// descriptors the dead process left open, as the kernel would.
//
// hostFacts() is a HostFacts implementation (src/contract.js) backed by the
// same folder and the same in-memory registry.
//
// assertWorld() and its helpers are the invariants every test checks: each
// session folder in exactly one place with its bytes and inodes, the registry
// as the at-prune policy of docs/store-safety.md says, no title in any plugin
// file. killRun() is one run of the kill-point matrix; the module is also the
// worker entry that runs them in parallel (workerData.role, at the end).
//
// Nothing here reads the environment except installDecoys(), which points
// HOME, DSH_HOME and the XDG roots at empty folders under the temp folder.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import nodeFs, { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { Context } from '@deepseek-ai/cordis'
import { assertApplyResult, assertTrashList, HOST_FACTS_METHODS } from '../../src/contract.js'
import { createHostAdapter } from '../../src/host-adapter.js'
import { resolveSettings, SessionsManagerService } from '../../src/service.js'

export const LOG_FILE = 'session.v4.jsonl.zstd'
export const LOCK_FILE = 'session.lock'
/** Every title holds this marker: it must never reach the audit log, a manifest, a journal or the hints. */
export const SECRET = 'TOP-SECRET-TITLE'
export const OWNER = Object.freeze({ peer: Object.freeze({ principal: Object.freeze({ kind: 'owner' }) }) })
export const AGENT = Object.freeze({ peer: Object.freeze({ principal: Object.freeze({ kind: 'agent', agentId: 'agent-1' }) }) })
export const O_EXLOCK = 0x20
const DAY = 86_400_000
const MINUTE = 60_000
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const BODY_FILE = /^session\..*jsonl/
const HOST = os.hostname()

/** Workspaces of the registry: id, folder name under <root>/work, title. */
export const WORKSPACES = Object.freeze([
  { id: 'ws-alpha', dir: 'alpha', title: 'Alpha project' },
  { id: 'ws-beta', dir: 'beta', title: 'Beta project' },
  { id: 'ws-gamma', dir: 'gamma', title: 'Gamma project' },
  { id: 'ws-delta', dir: 'delta', title: 'Delta project' },
  { id: 'ws-epsilon', dir: 'epsilon', title: 'Epsilon project' },
  { id: 'ws-zeta', dir: 'zeta', title: 'Zeta project' },
].map(Object.freeze))
/** Work folders that no workspace registers. */
const LOOSE_DIRS = Object.freeze(['loose', 'scratch'])

/** mulberry32: a small seeded PRNG, so a layout is the same on every run. */
export function prng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const isInside = (root, target) => {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
const tick = () => new Promise((resolve) => setImmediate(resolve))

// ---------------------------------------------------------------------------
// Layouts. An entry: folder (the session folder name), id (the header id,
// default the folder), ws (registered workspace dir or null), cwd (work folder,
// default ws, or the parent's cwd for a child), parent (folder of the parent),
// origin ('subagent' for a child unless fork), archived, pinned, registered,
// age (ms before now of the log mtime), formatStatus, link (the folder is a
// symlink to <root>/elsewhere/<folder>).
// ---------------------------------------------------------------------------

const entry = (folder, fields = {}) => ({ folder, ...fields })

/** The named shapes; tests refer to them by folder name. */
function specialEntries() {
  return [
    // Ready trees: nested archived members, a grandchild, a bootstrapped and
    // pinned child, a child in another project folder.
    entry('tree-a', { ws: 'alpha', archived: true }),
    entry('tree-a-c1', { parent: 'tree-a', archived: true }),
    entry('tree-a-c1-g', { parent: 'tree-a-c1', archived: true }),
    entry('tree-a-c2', { parent: 'tree-a', registered: 'alpha', pinned: true }),
    entry('tree-a-c3', { parent: 'tree-a', cwd: 'beta', archived: true }),
    entry('tree-b', { ws: 'beta', archived: true }),
    entry('tree-c', { ws: 'gamma', archived: true }),
    entry('tree-c-c', { parent: 'tree-c', archived: true }),
    // Blocked shapes.
    entry('live-root', { ws: 'gamma', archived: true }),
    entry('live-root-c', { parent: 'live-root', archived: true, live: true }),
    entry('recent-root', { ws: 'gamma', archived: true }),
    entry('recent-root-c', { parent: 'recent-root', age: 2 * MINUTE }),
    entry('locked-root', { ws: 'alpha', archived: true }),
    entry('locked-root-c', { parent: 'locked-root', archived: true, foreignLock: true }),
    entry('fork-root', { ws: 'beta', archived: true }),
    entry('fork-root-f', { parent: 'fork-root', fork: true, registered: 'beta' }),
    entry('kept-parent', { ws: 'alpha' }),
    entry('kept-parent-c', { parent: 'kept-parent', archived: true }),
    entry('cycle-a', { ws: 'gamma', registered: 'gamma', archived: true, parent: 'cycle-b' }),
    entry('cycle-b', { parent: 'cycle-a', archived: true, cwd: 'gamma' }),
    entry('legacy-root', { ws: 'delta', archived: true }),
    entry('legacy-root-c', { parent: 'legacy-root', archived: true, formatStatus: 'migration-required' }),
    entry('loose-root', { ws: null, cwd: 'loose', archived: true }),
    entry('loose-root-c', { parent: 'loose-root', archived: true }),
    entry('loose-kept', { ws: null, cwd: 'scratch' }),
    entry('link-root', { ws: 'delta', archived: true, link: true }),
    entry('dots..root', { ws: 'delta', archived: true }),
    entry('mismatch-root', { ws: 'delta', archived: true, id: 'mismatch-other' }),
    entry('trav-root', { ws: 'delta', archived: true, id: '../../../escape' }),
    entry('vanish-root', { ws: 'delta', archived: true }),
    entry('vanish-root-c', { parent: 'vanish-root', archived: true }),
    // Ready at plan time; the race and refusal tests change them.
    entry('xdev-root', { ws: 'delta', archived: true }),
    entry('race-a', { ws: 'beta', archived: true }),
    entry('race-a-c', { parent: 'race-a', archived: true }),
    entry('race-b', { ws: 'beta', archived: true }),
    entry('race-b-c', { parent: 'race-b', archived: true }),
    entry('race-c', { ws: 'gamma', archived: true }),
    entry('race-c-c', { parent: 'race-c' }),
    entry('race-d', { ws: 'gamma', archived: true }),
    entry('race-d-c', { parent: 'race-d', archived: true }),
    entry('race-e', { ws: 'gamma', archived: true }),
    entry('race-e-c', { parent: 'race-e', archived: true }),
    entry('race-f', { ws: 'alpha', archived: true }),
    entry('race-f-c', { parent: 'race-f', archived: true }),
    entry('race-g', { ws: 'alpha', archived: true }),
    entry('race-g-c', { parent: 'race-g', archived: true }),
    entry('race-h', { ws: 'alpha', archived: true }),
    entry('race-h-c', { parent: 'race-h', archived: true }),
    // Restore shapes: a whole workspace (delta2 keeps its folder elsewhere), a solo project folder each.
    entry('delta-root', { ws: 'delta', archived: true }),
    entry('delta-root-c', { parent: 'delta-root', archived: true }),
    entry('conflict-root', { ws: 'beta', archived: true }),
    entry('solo-root', { ws: 'epsilon', archived: true }),
    entry('solo2-root', { ws: 'zeta', archived: true }),
    entry('solo2-root-c', { parent: 'solo2-root', archived: true }),
  ]
}

/** Generated bulk: top-level sessions in every workspace and in none, children, grandchildren. */
function bulkEntries(rand, count) {
  const out = []
  const dirs = ['alpha', 'beta', 'gamma', 'delta']
  for (let n = 0; out.length < count; n += 1) {
    const id = `s${String(n).padStart(4, '0')}`
    const loose = n % 7 === 6
    const ws = loose ? null : dirs[n % dirs.length]
    const cwd = loose ? LOOSE_DIRS[n % 2] : ws
    const archived = n % 3 === 1
    const age = (2 + Math.floor(rand() * 400)) * DAY + Math.floor(rand() * DAY)
    out.push(entry(id, { ws, cwd, archived, pinned: !archived && !loose && n % 11 === 0, age }))
    const kids = n % 4
    for (let c = 0; c < kids && out.length < count; c += 1) {
      const kid = `${id}-c${c}`
      // An archived child of a non-archived (kept) parent: parent-kept.
      const kidArchived = archived ? rand() < 0.6 : n % 13 === 0 && c === 0
      // A child the first-start bootstrap put into the workspace (sometimes pinned).
      const registered = !loose && n % 9 === 0 && c === 0 ? ws : null
      const otherCwd = !loose && n % 10 === 3 && c === 1 ? dirs[(n + 1) % dirs.length] : cwd
      out.push(entry(kid, {
        parent: id, cwd: otherCwd, archived: kidArchived, registered, pinned: registered !== null && !kidArchived && n % 18 === 0,
        age: Math.max(DAY, age - Math.floor(rand() * DAY)),
      }))
      if (rand() < 0.35 && out.length < count) {
        out.push(entry(`${kid}-g`, { parent: kid, cwd: otherCwd, archived: archived && rand() < 0.6, age: Math.max(DAY, age - DAY) }))
      }
    }
  }
  return out
}

/** The compact layout of the kill-point matrix: three ready units (8 sessions), kept, live and loose sessions. */
function compactEntries() {
  const wanted = new Set([
    'tree-a', 'tree-a-c1', 'tree-a-c1-g', 'tree-a-c2', 'tree-a-c3', 'tree-b', 'tree-c', 'tree-c-c', 'live-root', 'live-root-c', 'loose-root',
  ])
  return [
    entry('keep-1', { ws: 'alpha' }),
    entry('keep-2', { ws: 'alpha' }),
    entry('keep-3', { ws: 'beta', pinned: true }),
    entry('keep-4', { ws: 'gamma' }),
    ...specialEntries().filter((e) => wanted.has(e.folder)),
  ]
}

/** The project folder name the backend derives from a cwd (one safe path segment). */
export const projectName = (cwd) => `-${cwd.replace(/[^A-Za-z0-9]/g, '-')}`

// ---------------------------------------------------------------------------
// The sandbox (the "disk" and the registry's durable state, shared by every
// process)
// ---------------------------------------------------------------------------

/**
 * Build a sandbox store.
 * @param {{ layout?: 'full' | 'compact', sessions?: number, seed?: number, now?: number }} [options]
 *   `sessions`: total sessions of the full layout (default 420)
 */
export async function createSandbox(options = {}) {
  const { layout = 'full', sessions = 420, seed = 7, now = Date.now() } = options
  const root = nodeFs.realpathSync(await nodeFs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-sessions-it-')))
  const rand = prng(seed)
  const specials = layout === 'compact' ? compactEntries() : specialEntries()
  const entries = layout === 'compact' ? specials : [...specials, ...bulkEntries(rand, Math.max(0, sessions - specials.length))]

  const world = {
    root,
    store: path.join(root, 'store'),
    sessionsRoot: path.join(root, 'store', 'sessions'),
    profileHome: path.join(root, 'profile'),
    work: path.join(root, 'work'),
    elsewhere: path.join(root, 'elsewhere'),
    now,
    entries: new Map(),
    byId: new Map(),
    titles: new Map(),
    registry: { workspaces: [], archived: [], pinned: [] },
    live: new Set(),
    foreignLocks: new Map(),
    alivePids: new Set(),
    devOverride: new Map(),
    failRegistry: new Map(),
    violations: [],
    logs: [],
    registryLog: [],
    hooks: {},
    listCalls: 0,
    statCalls: 0,
    dying: null,
    auditArm: null,
  }
  world.dataDir = path.join(world.profileHome, 'sessions-manager')
  world.trashDir = path.join(world.dataDir, 'trash')
  world.auditFile = path.join(world.dataDir, 'audit.jsonl')
  for (const dir of [world.sessionsRoot, world.profileHome, world.elsewhere]) nodeFs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const dir of [...WORKSPACES.map((w) => w.dir), ...LOOSE_DIRS]) nodeFs.mkdirSync(path.join(world.work, dir), { recursive: true })
  for (const w of WORKSPACES) world.registry.workspaces.push({ id: w.id, title: w.title, path: path.join(world.work, w.dir), sessionIds: [] })

  // Resolve every entry: header id, cwd, project folder, session folder.
  const byFolder = new Map(entries.map((e) => [e.folder, e]))
  const cwdOf = (e, seen = new Set()) => {
    if (e.cwd !== undefined) return e.cwd
    if (e.ws) return e.ws
    if (e.parent && !seen.has(e.folder)) {
      seen.add(e.folder)
      const parent = byFolder.get(e.parent)
      if (parent) return cwdOf(parent, seen)
    }
    return 'loose'
  }
  const registered = new Map(WORKSPACES.map((w) => [w.dir, []]))
  for (const raw of entries) {
    const e = { ...raw }
    e.id = raw.id ?? raw.folder
    e.cwdDir = cwdOf(raw)
    e.cwd = path.join(world.work, e.cwdDir)
    e.project = projectName(e.cwd)
    e.dir = path.join(world.sessionsRoot, e.project, e.folder)
    e.parentId = raw.parent ? (byFolder.get(raw.parent)?.id ?? raw.parent) : null
    e.origin = raw.parent && !raw.fork ? 'subagent' : null
    e.age = raw.age ?? (30 + Math.floor(rand() * 300)) * DAY
    e.registeredIn = raw.registered ?? (raw.parent ? null : raw.ws ?? null)
    world.entries.set(e.folder, e)
    world.byId.set(e.id, e)
    world.titles.set(e.id, `${SECRET} ${e.folder} with "quotes", a\nnewline and \u202e bidi text`)
    if (e.registeredIn) registered.get(e.registeredIn).push(e.id)
    if (e.archived) world.registry.archived.push(e.id)
    if (e.pinned && !e.archived) world.registry.pinned.push(e.id)
    if (e.live) world.live.add(e.id)
  }
  // Workspace order: a seeded shuffle, so pruned sessions sit between kept ones.
  for (const w of world.registry.workspaces) {
    const list = registered.get(WORKSPACES.find((x) => x.id === w.id).dir)
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1))
      ;[list[i], list[j]] = [list[j], list[i]]
    }
    w.sessionIds.push(...list)
  }

  // The files: opaque log bytes, an empty session.lock, an old mtime.
  for (const e of world.entries.values()) {
    const project = path.join(world.sessionsRoot, e.project)
    if (!nodeFs.existsSync(project)) nodeFs.mkdirSync(project, { mode: 0o700 })
    const real = e.link ? path.join(world.elsewhere, e.folder) : e.dir
    nodeFs.mkdirSync(real, { mode: 0o700 })
    const body = Buffer.concat([ZSTD_MAGIC, randomBytes(512 + Math.floor(rand() * 12_000))])
    nodeFs.writeFileSync(path.join(real, LOG_FILE), body, { mode: 0o600 })
    nodeFs.writeFileSync(path.join(real, LOCK_FILE), '', { mode: 0o600 })
    const time = (now - e.age) / 1000
    nodeFs.utimesSync(path.join(real, LOG_FILE), time, time)
    if (e.link) nodeFs.symlinkSync(real, e.dir)
  }
  for (const e of world.entries.values()) if (e.foreignLock) holdForeignLock(world, e.folder)

  Object.assign(world, sandboxMethods(world))
  world.original = {
    tree: world.storeTree(),
    registry: world.registrySnapshot(),
    prints: new Map([...world.entries.keys()].map((folder) => [folder, world.printOf(folder)])),
  }
  return world
}

/** Hold a session's lock as another host's writer would (a kernel flock through O_EXLOCK). */
export function holdForeignLock(world, folder) {
  const e = world.entries.get(folder)
  const fd = nodeFs.openSync(path.join(e.link ? path.join(world.elsewhere, folder) : e.dir, LOCK_FILE), constants.O_RDONLY | O_EXLOCK | constants.O_NONBLOCK)
  world.foreignLocks.set(folder, fd)
  return fd
}

export function releaseForeignLock(world, folder) {
  const fd = world.foreignLocks.get(folder)
  if (fd === undefined) return
  world.foreignLocks.delete(folder)
  nodeFs.closeSync(fd)
}

function sandboxMethods(world) {
  /** A tree listing: one line per entry with type, path, mode, size, content hash and inode. */
  const treeOf = (dir, { ino = true } = {}) => {
    const lines = []
    const walk = (folder, rel) => {
      for (const name of nodeFs.readdirSync(folder).sort()) {
        const full = path.join(folder, name)
        const relative = rel === '' ? name : `${rel}/${name}`
        const stat = nodeFs.lstatSync(full)
        const id = ino ? ` ino=${stat.ino}` : ''
        if (stat.isSymbolicLink()) lines.push(`l ${relative} -> ${nodeFs.readlinkSync(full)}${id}`)
        else if (stat.isDirectory()) {
          lines.push(`d ${relative} ${(stat.mode & 0o777).toString(8)}${id}`)
          walk(full, relative)
        } else lines.push(`f ${relative} ${(stat.mode & 0o777).toString(8)} ${stat.size} ${sha256(nodeFs.readFileSync(full))}${id}`)
      }
    }
    if (nodeFs.existsSync(dir)) walk(dir, '')
    return lines
  }

  /** Where each session folder is: 'store', 'trash:<batch>', 'tomb:<batch>' or 'staging:<batch>'. */
  const places = () => {
    const out = new Map()
    const add = (folder, place, full) => {
      const list = out.get(folder) ?? []
      list.push({ place, path: full })
      out.set(folder, list)
    }
    for (const project of nodeFs.readdirSync(world.sessionsRoot)) {
      const dir = path.join(world.sessionsRoot, project)
      if (!nodeFs.lstatSync(dir).isDirectory()) continue
      for (const name of nodeFs.readdirSync(dir)) add(name, 'store', path.join(dir, name))
    }
    if (nodeFs.existsSync(world.trashDir)) {
      for (const name of nodeFs.readdirSync(world.trashDir)) {
        const sessions = path.join(world.trashDir, name, 'sessions')
        let stat
        try {
          stat = nodeFs.lstatSync(sessions)
        } catch {
          continue
        }
        if (!stat.isDirectory()) continue
        const kind = name.startsWith('.purge-') ? `tomb:${name.slice(7)}` : name.startsWith('.staging-') ? `staging:${name.slice(9)}` : `trash:${name}`
        for (const project of nodeFs.readdirSync(sessions)) {
          const dir = path.join(sessions, project)
          if (!nodeFs.lstatSync(dir).isDirectory()) continue
          for (const folder of nodeFs.readdirSync(dir)) add(folder, kind, path.join(dir, folder))
        }
      }
    }
    return out
  }

  /** The content of one session folder, wherever it is (a symlinked folder: its target). */
  const printOf = (folder, where = null) => {
    const e = world.entries.get(folder)
    const at = where ?? e.dir
    const stat = nodeFs.lstatSync(at)
    const real = stat.isSymbolicLink() ? nodeFs.realpathSync(at) : at
    return treeOf(real).join('\n')
  }

  const registrySnapshot = () => ({
    workspaces: Object.fromEntries(world.registry.workspaces.map((w) => [w.id, [...w.sessionIds]])),
    archived: [...world.registry.archived].sort(),
    pinned: [...world.registry.pinned].sort(),
  })

  const auditRecords = () => {
    let text
    try {
      text = nodeFs.readFileSync(world.auditFile, 'utf8')
    } catch {
      return []
    }
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  }

  /** Every file the plugin wrote in its data folder, as text (for leak checks). */
  const pluginText = () => {
    const out = []
    const walk = (dir) => {
      if (!nodeFs.existsSync(dir)) return
      for (const name of nodeFs.readdirSync(dir)) {
        const full = path.join(dir, name)
        const stat = nodeFs.lstatSync(full)
        if (stat.isDirectory()) {
          if (name === 'sessions') continue
          walk(full)
        } else if (stat.isFile()) out.push([full, nodeFs.readFileSync(full, 'utf8')])
      }
    }
    walk(world.dataDir)
    return out
  }

  return {
    treeOf,
    storeTree: (opts) => treeOf(world.sessionsRoot, opts),
    places,
    printOf,
    registrySnapshot,
    auditRecords,
    auditOps: () => auditRecords().map((r) => r.op),
    pluginText,
    /** The store folder of a session, at its original place. */
    dirOf: (folder) => world.entries.get(folder).dir,
    idOf: (folder) => world.entries.get(folder).id,
    async cleanup() {
      for (const folder of [...world.foreignLocks.keys()]) releaseForeignLock(world, folder)
      nodeFs.rmSync(world.root, { recursive: true, force: true })
      gate.worlds.delete(world)
    },
  }
}

// ---------------------------------------------------------------------------
// The fake persistence backend: a scan of the folder on every call
// ---------------------------------------------------------------------------

function snapshotOf(world, e, log) {
  const stat = nodeFs.statSync(log, { bigint: true })
  return {
    header: {
      version: 4,
      id: e.id,
      createdAt: Math.floor(world.now - e.age - DAY),
      cwd: e.cwd,
      ...(e.parentId ? { parentSession: e.parentId } : {}),
      isSeeded: e.fork === true,
      ...(e.origin ? { origin: e.origin } : {}),
      delegationDepth: e.origin ? 1 : 0,
    },
    formatStatus: e.formatStatus ?? 'current',
    revision: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
    sizeBytes: Number(stat.size),
    location: { kind: 'jsonl', path: log },
  }
}

/** Every readable session of the store now. Unknown folders (no header) are omitted, as unreadable headers are. */
export function scanStore(world) {
  const out = []
  for (const project of nodeFs.readdirSync(world.sessionsRoot).sort()) {
    const dir = path.join(world.sessionsRoot, project)
    let stat
    try {
      stat = nodeFs.lstatSync(dir)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    for (const folder of nodeFs.readdirSync(dir).sort()) {
      const e = world.entries.get(folder)
      if (e === undefined) continue
      const log = path.join(dir, folder, LOG_FILE)
      try {
        out.push(snapshotOf(world, e, log))
      } catch { /* no log: not a session */ }
    }
  }
  return out
}

function statStore(world, id) {
  const e = world.byId.get(id)
  if (e === undefined) return undefined
  for (const project of nodeFs.readdirSync(world.sessionsRoot)) {
    const log = path.join(world.sessionsRoot, project, e.folder, LOG_FILE)
    try {
      return snapshotOf(world, e, log)
    } catch { /* not in this project folder */ }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// The audit gate: the audit log and paths.js use node:fs promises directly,
// not the injected fs. While a gate is installed, those calls are guarded
// like the injected fs, and a dead process's audit writes hang.
// ---------------------------------------------------------------------------

const gate = { worlds: new Set(), originals: null, outside: [] }

const worldOf = (target) => [...gate.worlds].find((w) => isInside(w.root, target))

/** Patch node:fs promises (open, mkdir, realpath, lstat, stat) for the sandbox guard and the audit kill points. */
export function installAuditGate() {
  if (gate.originals !== null) return uninstallAuditGate
  const promises = nodeFs.promises
  gate.originals = { open: promises.open, mkdir: promises.mkdir, realpath: promises.realpath, lstat: promises.lstat, stat: promises.stat }
  for (const name of Object.keys(gate.originals)) {
    const original = gate.originals[name]
    promises[name] = function guarded(target, ...rest) {
      const file = path.resolve(String(target))
      const world = worldOf(file)
      if (world === undefined) {
        gate.outside.push(`fs.promises.${name} ${file}`)
        return Promise.reject(Object.assign(new Error(`sandbox: fs.promises.${name} outside the sandbox: ${file}`), { code: 'ESANDBOX' }))
      }
      // A dead process never gets past an fs.promises call: nothing it started can write later.
      if (world.dying !== null) return new Promise(() => {})
      if (name === 'open' || name === 'mkdir') {
        if (name === 'open' && world.auditArm !== null) {
          const arm = world.auditArm
          const index = arm.seen
          arm.seen += 1
          if (arm.proc.dead) return new Promise(() => {})
          if (arm.at === index) {
            arm.proc.lastKill = { kind: 'audit', index, name: 'open', paths: [file] }
            arm.proc.die('audit')
            return new Promise(() => {})
          }
        }
      }
      return original.call(promises, target, ...rest)
    }
  }
  return uninstallAuditGate
}

export function uninstallAuditGate() {
  if (gate.originals === null) return
  Object.assign(nodeFs.promises, gate.originals)
  gate.originals = null
}

/** fs.promises calls the gate refused because they left every sandbox. */
export const gateViolations = () => [...gate.outside]
/** Forget the refused calls (after a test provoked them on purpose). */
export const resetGateViolations = () => { gate.outside.length = 0 }

// ---------------------------------------------------------------------------
// One process: a Cordis Context with the fakes, the host adapter and the
// service, file-system wrappers with a kill switch
// ---------------------------------------------------------------------------

let nextPid = 3_900_000
const PATH_FIRST_EXCEPT = new Set(['closeSync', 'readSync', 'writeSync', 'readvSync', 'writevSync', 'fstatSync', 'fsyncSync', 'fdatasyncSync',
  'fchmodSync', 'fchownSync', 'ftruncateSync', 'futimesSync'])
const TWO_PATHS = new Set(['renameSync', 'copyFileSync', 'linkSync', 'symlinkSync', 'cpSync'])
const BODY_OPENS = new Set(['openSync', 'readFileSync', 'createReadStream', 'open', 'readFile', 'openAsBlob'])

const pathish = (value) => typeof value === 'string' || Buffer.isBuffer(value) || value instanceof URL
const crashError = (name) => Object.assign(new Error(`the process died (fs.${name})`), { code: 'ECRASH' })

function pathArgs(name, args) {
  if (PATH_FIRST_EXCEPT.has(name) || name.startsWith('f')) return []
  const out = []
  if (pathish(args[0])) out.push(args[0])
  if (TWO_PATHS.has(name) && pathish(args[1])) out.push(args[1])
  return out.map((p) => path.resolve(p instanceof URL ? p.pathname : String(p)))
}

/**
 * Start one process on the sandbox.
 * @param {object} world createSandbox() result
 * @param {object} [options]
 * @param {number} [options.pid] trash-lock identity (default a new fake pid)
 * @param {string} [options.host] trash-lock host (default this host)
 * @param {string} [options.platform] lock-probe platform (default darwin)
 * @param {object} [options.config] raw plugin config
 * @param {number} [options.clockOffset] ms added to Date.now() for this process
 * @param {() => number} [options.clock] the service clock (default Date.now() + clockOffset)
 * @param {boolean} [options.record] keep every call in `events`
 * @param {boolean} [options.fsync] false: skip the real fsync (the call is still counted)
 * @param {(pid: number) => boolean} [options.isAlive] liveness of a recorded trash-lock pid
 * @param {{ beforeFs?: Function, beforeRegistry?: Function }} [options.hooks] beforeRegistry may return a promise to hold the call
 * @param {'service' | 'entry'} [options.mount] 'entry': load options.entry (src/index.host.js) with ctx.plugin()
 */
export function startProcess(world, options = {}) {
  const {
    pid = nextPid++, host = HOST, platform = 'darwin', config = {}, clockOffset = 0, record = false, hooks = {},
  } = options
  gate.worlds.add(world)
  const proc = {
    world, pid, host, dead: false, deathCause: null, lastKill: null, fsCount: 0, registryCount: 0, armed: null, events: [], fds: new Set(),
    asked: new Set(),
  }
  let resolveDeath
  proc.died = new Promise((resolve) => { resolveDeath = resolve })
  world.alivePids.add(pid)
  const hang = () => new Promise(() => {})
  const violation = (text) => {
    world.violations.push(text)
    return Object.assign(new Error(`abuse: ${text}`), { code: 'EABUSE' })
  }
  proc.die = (cause) => {
    if (proc.dead) return
    proc.dead = true
    proc.deathCause = cause
    world.alivePids.delete(pid)
    world.dying = proc
    resolveDeath(cause)
  }
  /** The kernel's part of a death: close what the dead process left open (and so drop its locks). */
  proc.bury = () => {
    for (const fd of proc.fds) {
      try { nodeFs.closeSync(fd) } catch { /* already closed */ }
    }
    proc.fds.clear()
    if (world.dying === proc) world.dying = null
    if (world.auditArm?.proc === proc) world.auditArm = null
  }
  /** Kill this process at the n-th fs call, registry call or audit write from now (each optional). */
  proc.arm = ({ fsAt = null, registryAt = null, registryMode = 'before', auditAt = null } = {}) => {
    proc.armed = { fsAt, registryAt, registryMode, fsBase: proc.fsCount, registryBase: proc.registryCount }
    world.auditArm = auditAt === null ? null : { proc, at: auditAt, seen: 0 }
  }
  proc.counts = () => ({
    fs: proc.fsCount - (proc.armed?.fsBase ?? 0),
    registry: proc.registryCount - (proc.armed?.registryBase ?? 0),
    audit: world.auditArm?.proc === proc ? world.auditArm.seen : 0,
  })
  proc.stop = () => {
    world.alivePids.delete(pid)
  }

  // --- file system ---------------------------------------------------------

  function fsCall(source, name, fn, args) {
    const paths = pathArgs(name, args)
    for (const target of paths) {
      if (!isInside(world.root, target)) throw violation(`${source} fs.${name} outside the sandbox: ${target}`)
    }
    if (BODY_OPENS.has(name) && paths.some((p) => BODY_FILE.test(path.basename(p)))) throw violation(`${source} fs.${name} opened a session log body: ${paths[0]}`)
    const index = proc.fsCount
    proc.fsCount += 1
    if (record) proc.events.push({ kind: 'fs', index, source, name, paths })
    hooks.beforeFs?.({ source, name, args, paths, index, proc })
    if (proc.dead) throw crashError(name)
    const armed = proc.armed
    if (armed !== null && armed.fsAt === index - armed.fsBase) {
      proc.lastKill = { kind: 'fs', index: armed.fsAt, source, name, paths }
      if (name === 'writeSync' && Buffer.isBuffer(args[1])) {
        // A torn write: half of the bytes reach the file, then the process is gone.
        const [fd, buffer, offset = 0, length = buffer.length - offset] = args
        try { nodeFs.writeSync(fd, buffer, offset, Math.floor(length / 2)) } catch { /* nothing written */ }
      }
      proc.die('fs')
      throw crashError(name)
    }
    // A process death keeps what the kernel already holds, so an fsync changes nothing these tests can
    // observe; `fsync: false` skips the real call (still counted and still a kill point) for speed.
    if (name === 'fsyncSync' && options.fsync === false) return undefined
    let result = fn.apply(nodeFs, args)
    if ((name === 'lstatSync' || name === 'statSync') && paths.length === 1 && world.devOverride.has(paths[0]) && result && typeof result === 'object') {
      result = Object.create(result, { dev: { value: result.dev + world.devOverride.get(paths[0]) } })
    }
    if (name === 'openSync') proc.fds.add(result)
    if (name === 'closeSync') proc.fds.delete(args[0])
    return result
  }

  const wrap = (source) => new Proxy(nodeFs, {
    get(target, key) {
      const value = Reflect.get(target, key)
      if (key === 'promises') {
        return new Proxy(value, {
          get(inner, name) {
            const fn = Reflect.get(inner, name)
            if (typeof fn !== 'function') return fn
            return (...args) => {
              const paths = pathArgs(String(name), args)
              for (const p of paths) if (!isInside(world.root, p)) return Promise.reject(violation(`${source} fs.promises.${String(name)} outside the sandbox: ${p}`))
              if (BODY_OPENS.has(String(name)) && paths.some((p) => BODY_FILE.test(path.basename(p)))) return Promise.reject(violation(`${source} fs.promises.${String(name)} opened a log body`))
              return fn.apply(inner, args)
            }
          },
        })
      }
      if (typeof value !== 'function' || typeof key !== 'string' || /^[A-Z]/.test(key)) return value
      return (...args) => fsCall(source, key, value, args)
    },
  })
  proc.serviceFs = wrap('service')
  proc.adapterFs = wrap('adapter')

  // --- registry ---------------------------------------------------------------

  const known = (id) => world.byId.has(id)
  const named = (Name, message) => Object.assign(new Error(message), { name: Name })
  const remove = (list, id) => {
    const at = list.indexOf(id)
    if (at >= 0) list.splice(at, 1)
  }
  const alive = (what) => {
    if (proc.dead) throw Object.assign(new Error(`the process died (${what})`), { code: 'ECRASH' })
  }
  function mutation(name, args, effect) {
    if (proc.dead) return hang()
    const index = proc.registryCount
    proc.registryCount += 1
    if (record) proc.events.push({ kind: 'registry', index, name, args })
    const wait = hooks.beforeRegistry?.({ name, args, index, proc })
    if (wait !== null && typeof wait === 'object' && typeof wait.then === 'function') return wait.then(() => perform(name, args, effect, index))
    return perform(name, args, effect, index)
  }
  function perform(name, args, effect, index) {
    if (proc.dead) return hang()
    const armed = proc.armed
    const hit = armed !== null && armed.registryAt === index - armed.registryBase
    if (hit && armed.registryMode === 'before') {
      proc.lastKill = { kind: 'registry-before', index: armed.registryAt, name, args }
      proc.die('registry')
      return hang()
    }
    const failure = world.failRegistry.get(name)
    if (failure && failure(...args)) return Promise.reject(Object.assign(new Error(`injected ${name} failure`), { code: 'EINJECTED' }))
    try {
      effect()
    } catch (error) {
      return Promise.reject(error)
    }
    world.registryLog.push([name, ...args])
    if (hit) {
      proc.lastKill = { kind: 'registry-after', index: armed.registryAt, name, args }
      proc.die('registry')
      return hang()
    }
    return Promise.resolve()
  }
  const workspaceView = (w) => ({
    id: w.id,
    path: w.path,
    title: w.title,
    get sessionIds() {
      alive('sessionIds')
      return [...w.sessionIds]
    },
    attachSession: (id) => mutation('attach', [id, w.id], () => {
      if (w.sessionIds.includes(id)) return
      const e = world.byId.get(id)
      if (e === undefined) throw new Error('session persistence holds no such session')
      let cwd
      let home
      try {
        cwd = nodeFs.realpathSync(e.cwd)
        home = nodeFs.realpathSync(w.path)
      } catch {
        throw new Error(`the cwd of session ${id} does not resolve`)
      }
      if (cwd !== home || !nodeFs.statSync(cwd).isDirectory()) throw new Error(`the cwd of session ${id} resolves elsewhere`)
      w.sessionIds.unshift(id)
    }),
    detachSession: (id) => mutation('detach', [id, w.id], () => remove(w.sessionIds, id)),
    insertSessionBefore: (id, before) => mutation('insert', [id, w.id, before ?? null], () => {
      if (!w.sessionIds.includes(id) || (before !== undefined && !w.sessionIds.includes(before))) {
        throw named('WorkspaceMoveInvalidError', 'not on the account')
      }
      remove(w.sessionIds, id)
      if (before === undefined) w.sessionIds.push(id)
      else w.sessionIds.splice(w.sessionIds.indexOf(before), 0, id)
    }),
    status: async () => {
      if (proc.dead) return hang()
      try {
        return nodeFs.statSync(w.path).isDirectory() ? 'ok' : 'missing-dir'
      } catch {
        return 'missing-dir'
      }
    },
  })
  const workspaceRegistry = {
    list() {
      alive('list')
      return world.registry.workspaces.map(workspaceView)
    },
    get(id) {
      alive('get')
      const found = world.registry.workspaces.find((w) => w.id === id)
      return found ? workspaceView(found) : undefined
    },
    get archivedSessionIds() {
      alive('archivedSessionIds')
      return [...world.registry.archived]
    },
    get pinnedSessionIds() {
      alive('pinnedSessionIds')
      return [...world.registry.pinned]
    },
    archiveSession: (id, opts) => mutation('archive', [id], () => {
      if (opts?.stopActivity !== undefined) throw new Error('the plugin must never pass stopActivity')
      if (!known(id)) throw named('WorkspaceUnknownSessionError', `unknown session ${id}`)
      if (!world.registry.archived.includes(id)) world.registry.archived.push(id)
      remove(world.registry.pinned, id)
    }),
    unarchiveSession: (id) => mutation('unarchive', [id], () => remove(world.registry.archived, id)),
    pinSession: (id) => mutation('pin', [id], () => {
      if (world.registry.archived.includes(id)) throw named('WorkspaceArchivedSessionPinError', `session ${id} is archived`)
      if (!known(id)) throw named('WorkspaceUnknownSessionError', `unknown session ${id}`)
      if (!world.registry.pinned.includes(id)) world.registry.pinned.unshift(id)
    }),
    unpinSession: (id) => mutation('unpin', [id], () => remove(world.registry.pinned, id)),
  }

  // --- persistence, live sessions, projection cache, traps -------------------

  const sessionPersistence = {
    async list() {
      if (proc.dead) return hang()
      world.listCalls += 1
      const snapshots = scanStore(world)
      world.hooks.afterList?.(snapshots)
      return snapshots
    },
    async stat(id) {
      if (proc.dead) return hang()
      world.statCalls += 1
      if (record) proc.events.push({ kind: 'backend', name: 'stat', args: [id] })
      return statStore(world, id)
    },
    open(id) { throw violation(`sessionPersistence.open(${id})`) },
    read(id) { throw violation(`sessionPersistence.read(${id})`) },
    readEvents(id) { throw violation(`sessionPersistence.readEvents(${id})`) },
    events(id) { throw violation(`sessionPersistence.events(${id})`) },
  }
  const sessions = {
    list() {
      alive('sessions.list')
      return [...world.live].map((id) => ({ id }))
    },
    get(id) {
      alive('sessions.get')
      if (record) proc.events.push({ kind: 'backend', name: 'live?', args: [id] })
      return world.live.has(id) ? { id } : undefined
    },
  }
  const sessionProjectionCache = {
    cachedSnapshot(header) {
      const title = world.titles.get(header?.id)
      return title === undefined ? undefined : { values: { title } }
    },
    cachedPredecessorTitle: () => undefined,
  }
  const trap = (service) => Object.fromEntries(['search', 'query', 'readTitle', 'readTitles', 'readEvents', 'reindex'].map((name) => [
    name, () => { throw violation(`${service}.${name}()`) },
  ]))

  const ctx = new Context()
  const services = {
    sessionPersistence,
    workspaceRegistry,
    sessions,
    sessionProjectionCache,
    profileContext: { home: world.profileHome },
    sessionQuery: trap('sessionQuery'),
    sessionSearch: trap('sessionSearch'),
  }
  for (const [name, value] of Object.entries(services)) ctx.provide(name, value)
  proc.ctx = ctx
  proc.services = services
  if (options.mount === 'entry') {
    // The plugin entry as the host loads it: real node:fs, this process's pid, the Cordis logger.
    ctx.plugin(options.entry, config)
  } else {
    const adapterCtx = {
      get: (name) => {
        proc.asked.add(name)
        return ctx.get(name)
      },
      logger: { warn: (message) => world.logs.push(message) },
    }
    proc.adapter = createHostAdapter(adapterCtx, { fs: proc.adapterFs, platform })
    proc.settings = resolveSettings(config, { home: world.profileHome })
    proc.service = new SessionsManagerService(ctx, {
      adapter: proc.adapter,
      settings: proc.settings,
      fs: proc.serviceFs,
      clock: options.clock ?? (() => Date.now() + clockOffset),
      trashOptions: {
        identity: { pid, startedAt: 1, host },
        isAlive: options.isAlive ?? ((other) => world.alivePids.has(other)),
      },
    })
  }

  /** One Remote call as the Client makes it: a call-derived Context with the invocation, JSON in and out. */
  proc.call = async (method, request = {}, invocation = OWNER) => {
    const view = ctx.extend({ invocation }).get('sessionsManager')
    if (view === undefined || typeof view[method] !== 'function') throw new Error(`sessionsManager.${method} is not mounted`)
    const result = await view[method](JSON.parse(JSON.stringify(request)))
    return result === undefined ? undefined : JSON.parse(JSON.stringify(result))
  }
  /** The error code of a Remote call, or 'resolved'. */
  proc.codeOf = async (method, request, invocation) => {
    try {
      await proc.call(method, request, invocation)
    } catch (error) {
      return error?.code ?? `threw:${error?.message}`
    }
    return 'resolved'
  }
  /** recover() is not a Remote method: in-process code of a new start calls it. */
  proc.recover = () => proc.service.recover()

  /** Run a call that may kill this process; resolves when it settled, or when it died and went quiet. */
  proc.runUntilDeath = async (promise) => {
    let outcome = { state: 'pending' }
    const settled = promise.then((value) => { outcome = { state: 'resolved', value } }, (error) => { outcome = { state: 'rejected', error } })
    await Promise.race([settled, proc.died])
    for (let i = 0; i < 25 && outcome.state === 'pending'; i += 1) await tick()
    return { ...outcome, dead: proc.dead }
  }
  world.processes = world.processes ?? []
  world.processes.push(proc)
  return proc
}

// ---------------------------------------------------------------------------
// HostFacts over the sandbox folder and the in-memory registry
// ---------------------------------------------------------------------------

/**
 * A HostFacts implementation (src/contract.js): the contract snapshot shape
 * (plus origin, cwd, formatStatus and revision), read from the same folder
 * scan as the fake backend; registry steps on the same in-memory registry.
 */
export function hostFacts(world) {
  const remove = (list, id) => {
    const at = list.indexOf(id)
    if (at >= 0) list.splice(at, 1)
  }
  const facts = {
    async snapshots() {
      return scanStore(world).map((s) => {
        const e = world.byId.get(s.header.id)
        const dir = path.dirname(s.location.path)
        const log = nodeFs.lstatSync(s.location.path)
        return {
          id: s.header.id,
          parentId: s.header.parentSession ?? null,
          dir,
          logPath: s.location.path,
          group: path.basename(path.dirname(dir)),
          bytes: folderBytes(dir),
          events: null,
          createdAt: s.header.createdAt,
          lastActivityAt: Math.floor(log.mtimeMs),
          unreadable: false,
          origin: e.origin ?? 'user',
          cwd: s.header.cwd,
          formatStatus: s.formatStatus,
          revision: s.revision,
        }
      })
    },
    async workspaces() {
      return world.registry.workspaces.map((w) => ({ id: w.id, name: w.title, path: w.path, sessionIds: [...w.sessionIds] }))
    },
    async archivedIds() { return [...world.registry.archived] },
    async pinnedIds() { return [...world.registry.pinned] },
    async liveIds() { return [...world.live] },
    async lockState(folder) {
      let names
      try {
        names = nodeFs.readdirSync(folder)
      } catch {
        return { state: 'none', pid: null }
      }
      if (names.some((name) => name.endsWith('.tmp'))) return { state: 'held', pid: null }
      if (!names.includes(LOCK_FILE)) return { state: 'none', pid: null }
      try {
        nodeFs.closeSync(nodeFs.openSync(path.join(folder, LOCK_FILE), constants.O_RDONLY | O_EXLOCK | constants.O_NONBLOCK | constants.O_NOFOLLOW))
        return { state: 'stale', pid: null }
      } catch (error) {
        return { state: error?.code === 'ENOENT' ? 'none' : 'held', pid: null }
      }
    },
    async statLog(target) {
      try {
        const stat = nodeFs.lstatSync(target)
        return { exists: true, isSymlink: stat.isSymbolicLink(), mtimeMs: stat.mtimeMs, bytes: stat.size, dev: stat.dev }
      } catch {
        return { exists: false, isSymlink: false, mtimeMs: 0, bytes: 0, dev: 0 }
      }
    },
    async titleOf(id) { return world.titles.get(id) ?? null },
    async unpin(id) { remove(world.registry.pinned, id) },
    async detach(id) { for (const w of world.registry.workspaces) remove(w.sessionIds, id) },
    async unarchive(id) { remove(world.registry.archived, id) },
    async attach(id, workspaceId) {
      const w = world.registry.workspaces.find((x) => x.id === workspaceId)
      if (w && !w.sessionIds.includes(id)) w.sessionIds.unshift(id)
    },
    async archive(id) {
      if (!world.registry.archived.includes(id)) world.registry.archived.push(id)
      remove(world.registry.pinned, id)
    },
    async pin(id) { if (!world.registry.pinned.includes(id)) world.registry.pinned.unshift(id) },
  }
  for (const name of HOST_FACTS_METHODS) if (typeof facts[name] !== 'function') throw new Error(`hostFacts: ${name} is missing`)
  return facts
}

/** On-disk bytes of the files of a folder (lstat; links not followed), as the host adapter counts them. */
export function folderBytes(dir) {
  let total = 0
  const walk = (folder, depth) => {
    for (const name of nodeFs.readdirSync(folder)) {
      const stat = nodeFs.lstatSync(path.join(folder, name))
      if (stat.isFile()) total += Number.isSafeInteger(stat.blocks) ? stat.blocks * 512 : stat.size
      else if (stat.isDirectory() && depth < 3) walk(path.join(folder, name), depth + 1)
    }
  }
  walk(dir, 0)
  return total
}

// ---------------------------------------------------------------------------
// Decoy home folders
// ---------------------------------------------------------------------------

const DECOY_VARS = Object.freeze(['HOME', 'DSH_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'])

/**
 * Point HOME, DSH_HOME and the XDG roots at empty folders of a fresh sandbox
 * folder (the decoy-home pattern of the repository's ledger tests). Returns
 * the folders, a check that they are still empty, and a restore.
 */
export async function installDecoys() {
  const root = nodeFs.realpathSync(await nodeFs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-sessions-decoy-')))
  const saved = Object.fromEntries(DECOY_VARS.map((name) => [name, process.env[name]]))
  const folders = {}
  for (const name of DECOY_VARS) {
    const dir = path.join(root, name.toLowerCase())
    nodeFs.mkdirSync(dir, { mode: 0o700 })
    folders[name] = dir
    process.env[name] = dir
  }
  return {
    root,
    folders,
    saved,
    /** Names of the decoy folders that are not empty any more. */
    touched: () => DECOY_VARS.filter((name) => nodeFs.readdirSync(folders[name]).length > 0),
    restore() {
      for (const name of DECOY_VARS) {
        if (saved[name] === undefined) delete process.env[name]
        else process.env[name] = saved[name]
      }
      nodeFs.rmSync(root, { recursive: true, force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// Invariants of the sandbox
// ---------------------------------------------------------------------------

/**
 * Every session folder in exactly one place (store or one trash batch), at its
 * own folder when in the store, with its bytes and inodes; the registry as the
 * at-prune policy says (docs/store-safety.md): a session outside the store is
 * in no workspace and neither archived nor pinned; a session in the store
 * keeps its baseline workspace, archive mark, pin and its order among stored
 * sessions. `gone`: folders a purge removed. `changed`: folders whose bytes a
 * test changed on purpose.
 */
export function assertWorld(world, { label, baseline = world.original, gone = new Set(), changed = new Set() }) {
  const where = world.places()
  for (const [folder, e] of world.entries) {
    const found = where.get(folder) ?? []
    if (gone.has(folder)) {
      assert.equal(found.length, 0, `${label}: purged ${folder} is still at ${JSON.stringify(found.map((f) => f.place))}`)
      continue
    }
    assert.equal(found.length, 1, `${label}: ${folder} must be in exactly one place, found ${JSON.stringify(found.map((f) => f.place))}`)
    const [{ place, path: at }] = found
    assert.ok(place === 'store' || place.startsWith('trash:'), `${label}: ${folder} is in ${place}`)
    if (place === 'store') assert.equal(at, e.dir, `${label}: ${folder} is back at its own folder`)
    if (!changed.has(folder)) assert.equal(world.printOf(folder, at), baseline.prints.get(folder), `${label}: ${folder} keeps its bytes and inodes`)
  }
  for (const folder of where.keys()) assert.ok(world.entries.has(folder), `${label}: a foreign folder ${folder} appeared`)
  assertRegistryPolicy(world, where, baseline.registry, label)
  return where
}

export function assertRegistryPolicy(world, where, registry, label) {
  const inStore = (folder) => where.get(folder)?.[0]?.place === 'store'
  const now = world.registry
  for (const [folder, e] of world.entries) {
    const { id } = e
    const member = now.workspaces.filter((w) => w.sessionIds.includes(id)).map((w) => w.id)
    if (inStore(folder)) {
      const before = Object.entries(registry.workspaces).filter(([, ids]) => ids.includes(id)).map(([w]) => w)
      assert.deepEqual(member, before, `${label}: ${folder} keeps its workspace`)
      assert.equal(now.archived.includes(id), registry.archived.includes(id), `${label}: ${folder} keeps its archived mark`)
      assert.equal(now.pinned.includes(id), registry.pinned.includes(id), `${label}: ${folder} keeps its pin`)
    } else {
      assert.deepEqual(member, [], `${label}: ${folder} outside the store is in no workspace`)
      assert.equal(now.archived.includes(id), false, `${label}: ${folder} outside the store is not archived`)
      assert.equal(now.pinned.includes(id), false, `${label}: ${folder} outside the store is not pinned`)
    }
  }
  const stored = new Set([...world.entries.values()].filter((e) => inStore(e.folder)).map((e) => e.id))
  for (const w of now.workspaces) {
    assert.deepEqual(w.sessionIds.filter((id) => stored.has(id)), registry.workspaces[w.id].filter((id) => stored.has(id)), `${label}: ${w.id} keeps the order of its stored sessions`)
  }
}

const AUDIT_OPS = new Set(['plan', 'apply-start', 'unit-moved', 'unit-skipped', 'registry-step', 'apply-end', 'recover'])

/** Audit lines are whole records of known ops; no title reaches any plugin file. Returns the ops. */
export function assertAuditClean(world, label) {
  const records = world.auditRecords()
  for (const record of records) {
    assert.equal(record.v, 1, `${label}: audit record version`)
    assert.ok(AUDIT_OPS.has(record.op) || /^(restore|purge)-[a-z-]+$/.test(record.op), `${label}: unknown audit op ${record.op}`)
  }
  for (const [file, text] of world.pluginText()) assert.equal(text.includes(SECRET), false, `${label}: a session title reached ${file}`)
  return records.map((record) => record.op)
}

/** The batch folders of the trash folder. */
export const batchFolders = (world) => (nodeFs.existsSync(world.trashDir) ? nodeFs.readdirSync(world.trashDir).filter((name) => /^b-/.test(name)).sort() : [])

// ---------------------------------------------------------------------------
// One kill run of the matrix (also run by worker threads, see the end)
// ---------------------------------------------------------------------------

/** A later start: past the trash lock grace period (60 s), so a torn lock of a dead process is stale. */
export const LATER = 2 * MINUTE + 5_000
/** Kill-run processes skip the real fsync (see the fs wrapper): the matrix models a process death, not a power loss. */
export const FAST = Object.freeze({ fsync: false })

export const describeKill = (kill) => (kill === null || kill === undefined ? 'not reached' : `${kill.kind}#${kill.index} ${kill.source ?? ''} ${kill.name} ${
  (kill.paths ?? kill.args ?? []).map((p) => String(p).split('/').slice(-3).join('/')).join(' -> ')}`.replace(/\s+/g, ' ').trim())

/**
 * One kill run on a fresh compact sandbox: a process dies at `spec` during
 * apply (or during the restore of a batch a healthy process pruned), the
 * kernel closes its descriptors, a new process starts on the same folders
 * and runs recover(); every invariant of assertWorld must hold, a second
 * recover() must do nothing, and a restore of every batch (Remote method) must
 * give back the byte-identical store tree and the exact registry.
 * @param {'apply' | 'restore'} phase
 * @param {{ fsAt?: number, registryAt?: number, registryMode?: 'before' | 'after', auditAt?: number }} spec
 * @returns {Promise<{ reached: boolean, kill?: string, error?: string | null, state?: string }>}
 */
export async function killRun(phase, spec) {
  const world = await createSandbox({ layout: 'compact' })
  try {
    const baseline = world.original
    let batchId = null
    if (phase === 'restore') {
      const healthy = startProcess(world, FAST)
      const plan = await healthy.call('plan', { scope: 'all' })
      const done = await healthy.call('apply', { planId: plan.planId, confirmCount: plan.totals.readySessions })
      assert.equal(done.state, 'complete')
      batchId = done.batchId
      healthy.stop()
    }
    const dying = startProcess(world, FAST)
    let call
    if (phase === 'apply') {
      const plan = await dying.call('plan', { scope: 'all' })
      dying.arm(spec)
      call = dying.call('apply', { planId: plan.planId, confirmCount: plan.totals.readySessions })
    } else {
      dying.arm(spec)
      call = dying.call('restore', { batchId })
    }
    const outcome = await dying.runUntilDeath(call)
    if (!outcome.dead) {
      return { reached: false, error: outcome.state === 'rejected' ? String(outcome.error?.message ?? outcome.error) : null, state: outcome.value?.state ?? null }
    }
    const kill = describeKill(dying.lastKill)
    try {
      dying.bury()
      const next = startProcess(world, { ...FAST, clockOffset: LATER })
      const report = await next.recover()
      assert.deepEqual(report.problems, [], 'recover() finds no unusable batch')
      for (const batch of report.batches) assert.equal(batch.state, 'complete', `batch ${batch.batchId} after recover(): ${JSON.stringify(report)}`)
      assertWorld(world, { label: 'after recover()', baseline })
      assertAuditClean(world, 'after recover()')
      assertTrashList(await next.call('trash', { fresh: true }))
      const calls = world.registryLog.length
      const again = await startProcess(world, { ...FAST, clockOffset: LATER }).recover()
      assert.equal(world.registryLog.length, calls, 'a second recover() makes no registry call')
      assert.ok(again.batches.every((b) => b.appended === 0 && b.moved === 0), 'a second recover() appends and moves nothing')
      for (const name of batchFolders(world)) assertApplyResult(await next.call('restore', { batchId: name }))
      assert.deepEqual(world.storeTree(), baseline.tree, 'the restore gives back the byte-identical store tree')
      assert.deepEqual(world.registrySnapshot(), baseline.registry, 'the restore gives back the exact registry')
      assert.deepEqual(world.violations, [], 'no guard violation')
      assert.deepEqual(gateViolations(), [], 'no fs.promises call left the sandbox')
      return { reached: true, kill }
    } catch (error) {
      error.message = `kill ${phase} at ${kill}: ${error.message}`
      throw error
    }
  } finally {
    await world.cleanup()
  }
}

// Worker entry: a kill-run worker takes { id, phase, spec } messages and answers { id, run } or { id, failure }.
if (!isMainThread && workerData?.role === 'sessions-kill-runner') {
  installAuditGate()
  parentPort.on('message', (task) => {
    killRun(task.phase, task.spec).then(
      (run) => parentPort.postMessage({ id: task.id, run }),
      (error) => parentPort.postMessage({ id: task.id, failure: String(error?.message ?? error).split('\n')[0] }),
    )
  })
}
