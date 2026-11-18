#!/usr/bin/env node
// Scratch DeepSeek Harness home for spikes and smoke runs.
//
// Every dsh CLI call and every scratch host of this package goes through this
// script. It creates a throw-away root with mkdtemp under os.tmpdir() and runs
// commands with an environment built from scratch: HOME, DSH_HOME,
// DSH_AGENTS_HOME, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_STATE_HOME,
// XDG_CACHE_HOME and TMPDIR all point inside that root, every inherited DSH_*
// variable and every secret-looking variable is dropped, and no value may name
// the real ~/.dsh. A DSH_HOME that is unset, relative, outside a root created
// here, or that resolves to or inside the real ~/.dsh (lexically, by case
// folding on macOS and Windows, or through a symlink) is refused before any
// command starts.
//
// Usage:
//   node scratch-home.mjs create [--label <text>]
//       Create a scratch root; prints its descriptor as JSON.
//   node scratch-home.mjs env <root>
//       Print `export NAME='value'` lines of the scratch environment.
//   node scratch-home.mjs run <root> [--cwd <dir>] [--set NAME=VALUE]... [--env-dump <file>] -- <command> [args...]
//       Run one command with the scratch environment only; signals are forwarded.
//   node scratch-home.mjs dsh <root> [--cwd <dir>] [--set NAME=VALUE]... [--env-dump <file>] [--dsh <launcher>] -- <dsh args...>
//       Same as run, with the packaged dsh launcher as the command.
//   node scratch-home.mjs check <dsh-home>
//       Exit 0 when the path is an acceptable scratch DSH_HOME, 2 otherwise.
//   node scratch-home.mjs destroy <root>
//       Remove a scratch root created by this script (refuses anything else).
//   node scratch-home.mjs --self-test
//       Run the built-in checks; exit 0 when all pass.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const MARKER = '.dsh-scratch-root.json'
const PREFIX = 'dsh-scratch-'
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32'
const DEFAULT_LAUNCHERS = ['/usr/local/bin/dsh', '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh']

// Inherited variables a child may keep. Everything else is dropped.
const PASS_THROUGH = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'USER', 'LOGNAME', 'SHELL', 'TZ']
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASS|AUTH|COOKIE|CREDENTIAL)/i

/** The real user's home from the account database, independent of $HOME. */
export function realUserHome() {
  return os.userInfo().homedir
}

/** The real DSH home this script must never touch. */
export function realDshHome() {
  return path.join(realUserHome(), '.dsh')
}

function fold(p) {
  return CASE_INSENSITIVE ? p.toLowerCase() : p
}

function within(candidate, root) {
  const c = fold(path.resolve(candidate))
  const r = fold(path.resolve(root))
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
}

/** realpath of the longest existing ancestor, with the missing tail appended. */
export function resolveThroughLinks(p) {
  let current = path.resolve(p)
  const tail = []
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...tail.reverse())
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
      const parent = path.dirname(current)
      if (parent === current) return path.join(current, ...tail.reverse())
      tail.push(path.basename(current))
      current = parent
    }
  }
}

function tmpRoot() {
  return realpathSync.native(os.tmpdir())
}

/** Walk up from `p` to the scratch root holding the marker, staying inside the temp dir. */
function findScratchRoot(p, tmp) {
  let current = p
  while (within(current, tmp) && fold(current) !== fold(tmp)) {
    if (existsSync(path.join(current, MARKER))) return current
    current = path.dirname(current)
  }
  return undefined
}

/**
 * Refuse a DSH_HOME that is unset, relative, the real ~/.dsh or inside it, or
 * not inside a scratch root created by this script under os.tmpdir().
 * The lexical check runs first, so a refused path is never stat-ed.
 * @param {string | undefined} dshHome candidate DSH_HOME.
 * @param {{ realHome?: string, tmp?: string }} [options] test overrides.
 * @returns {{ dshHome: string, resolved: string, root: string }}
 */
export function assertScratchDshHome(dshHome, options = {}) {
  const real = options.realHome ?? realDshHome()
  if (dshHome === undefined || dshHome === null || String(dshHome).trim() === '') {
    throw new Error('scratch-home: refusing: DSH_HOME is unset or empty')
  }
  if (!path.isAbsolute(dshHome)) {
    throw new Error(`scratch-home: refusing: DSH_HOME must be absolute, got ${JSON.stringify(dshHome)}`)
  }
  if (within(dshHome, real)) {
    throw new Error(`scratch-home: refusing: DSH_HOME ${JSON.stringify(dshHome)} is the real ${real} or inside it`)
  }
  const resolved = resolveThroughLinks(dshHome)
  const realResolved = resolveThroughLinks(real)
  if (within(resolved, real) || within(resolved, realResolved)) {
    throw new Error(`scratch-home: refusing: DSH_HOME ${JSON.stringify(dshHome)} resolves to ${resolved}, the real home or inside it`)
  }
  const tmp = options.tmp ?? tmpRoot()
  if (!within(resolved, tmp)) {
    throw new Error(`scratch-home: refusing: DSH_HOME ${resolved} is not under the temp dir ${tmp}`)
  }
  const root = findScratchRoot(resolved, tmp)
  if (root === undefined) {
    throw new Error(`scratch-home: refusing: DSH_HOME ${resolved} is not inside a root created by scratch-home.mjs (no ${MARKER})`)
  }
  return { dshHome, resolved, root }
}

/** Layout of one scratch root. */
export function layout(root) {
  return {
    root,
    HOME: path.join(root, 'home'),
    DSH_HOME: path.join(root, 'home', '.dsh'),
    DSH_AGENTS_HOME: path.join(root, 'home', '.agents'),
    XDG_CONFIG_HOME: path.join(root, 'xdg', 'config'),
    XDG_DATA_HOME: path.join(root, 'xdg', 'data'),
    XDG_STATE_HOME: path.join(root, 'xdg', 'state'),
    XDG_CACHE_HOME: path.join(root, 'xdg', 'cache'),
    TMPDIR: path.join(root, 'tmp'),
    work: path.join(root, 'work'),
  }
}

/** Create a scratch root with mkdtemp under os.tmpdir(). */
export function createScratch(label = 'spike') {
  const tmp = tmpRoot()
  const root = mkdtempSync(path.join(tmp, PREFIX))
  const dirs = layout(root)
  for (const key of ['HOME', 'DSH_HOME', 'DSH_AGENTS_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TMPDIR', 'work']) {
    mkdirSync(dirs[key], { recursive: true, mode: 0o700 })
  }
  writeFileSync(path.join(root, MARKER), JSON.stringify({
    createdBy: 'scratch-home.mjs', created: new Date().toISOString(), label, pid: process.pid,
  }, undefined, 2) + '\n', { mode: 0o600 })
  assertScratchDshHome(dirs.DSH_HOME)
  return dirs
}

function assertValueSafe(name, value, real) {
  if (typeof value !== 'string') return
  const lower = fold(value)
  for (const forbidden of new Set([real, resolveThroughLinks(real)])) {
    if (lower.includes(fold(forbidden))) {
      throw new Error(`scratch-home: refusing: ${name} names the real ${forbidden}`)
    }
  }
}

/**
 * Build the complete child environment for one scratch root.
 * @param {string} root scratch root.
 * @param {{ parentEnv?: Record<string, string | undefined>, set?: Record<string, string>, realHome?: string, tmp?: string }} [options]
 */
export function scratchEnv(root, options = {}) {
  const parentEnv = options.parentEnv ?? process.env
  const real = options.realHome ?? realDshHome()
  const dirs = layout(path.resolve(root))
  assertScratchDshHome(dirs.DSH_HOME, { realHome: real, tmp: options.tmp })
  const env = {}
  for (const name of PASS_THROUGH) {
    if (parentEnv[name] !== undefined) env[name] = parentEnv[name]
  }
  Object.assign(env, {
    HOME: dirs.HOME,
    DSH_HOME: dirs.DSH_HOME,
    DSH_AGENTS_HOME: dirs.DSH_AGENTS_HOME,
    XDG_CONFIG_HOME: dirs.XDG_CONFIG_HOME,
    XDG_DATA_HOME: dirs.XDG_DATA_HOME,
    XDG_STATE_HOME: dirs.XDG_STATE_HOME,
    XDG_CACHE_HOME: dirs.XDG_CACHE_HOME,
    TMPDIR: dirs.TMPDIR,
    DSH_TELEMETRY_DISABLED: '1',
  })
  for (const [name, value] of Object.entries(options.set ?? {})) {
    if (['HOME', 'DSH_HOME', 'DSH_AGENTS_HOME', 'TMPDIR'].includes(name) || name.startsWith('XDG_')) {
      throw new Error(`scratch-home: refusing: --set may not override ${name}`)
    }
    env[name] = value
  }
  for (const [name, value] of Object.entries(env)) assertValueSafe(name, value, real)
  assertScratchDshHome(env.DSH_HOME, { realHome: real, tmp: options.tmp })
  return env
}

/** Render an environment for a dump file: sorted, secret-looking values redacted. */
export function renderEnv(env) {
  return Object.keys(env).sort().map(name => `${name}=${SECRET_NAME.test(name) ? '<redacted>' : env[name]}`).join('\n') + '\n'
}

function findLauncher(explicit) {
  if (explicit !== undefined) return explicit
  const found = DEFAULT_LAUNCHERS.find(candidate => existsSync(candidate))
  if (found === undefined) throw new Error('scratch-home: no dsh launcher found; pass --dsh <path>')
  return found
}

function parseRunArgs(argv) {
  const options = { set: {}, cwd: undefined, envDump: undefined, dsh: undefined }
  const separator = argv.indexOf('--')
  if (separator < 0) throw new Error('scratch-home: missing `--` before the command')
  const own = argv.slice(0, separator)
  const command = argv.slice(separator + 1)
  for (let index = 0; index < own.length; index++) {
    const flag = own[index]
    const value = own[index + 1]
    if (flag === '--cwd') { options.cwd = value; index++ }
    else if (flag === '--env-dump') { options.envDump = value; index++ }
    else if (flag === '--dsh') { options.dsh = value; index++ }
    else if (flag === '--set') {
      const at = value?.indexOf('=') ?? -1
      if (at <= 0) throw new Error(`scratch-home: --set needs NAME=VALUE, got ${JSON.stringify(value)}`)
      options.set[value.slice(0, at)] = value.slice(at + 1)
      index++
    } else throw new Error(`scratch-home: unknown option ${JSON.stringify(flag)}`)
  }
  return { options, command }
}

/** Run one command under the scratch environment; resolves with its exit code. */
export function runScratch(root, command, options = {}) {
  const env = scratchEnv(root, { set: options.set })
  const cwd = path.resolve(options.cwd ?? layout(path.resolve(root)).work)
  if (within(cwd, realDshHome()) || within(resolveThroughLinks(cwd), resolveThroughLinks(realDshHome()))) {
    throw new Error(`scratch-home: refusing: cwd ${cwd} is inside the real DSH home`)
  }
  if (options.envDump !== undefined) writeFileSync(options.envDump, renderEnv(env))
  if (command.length === 0) throw new Error('scratch-home: no command given')
  return new Promise((resolvePromise) => {
    const child = spawn(command[0], command.slice(1), { cwd, env, stdio: 'inherit' })
    const forward = signal => () => { child.kill(signal) }
    const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, forward(signal)])
    for (const [signal, handler] of handlers) process.on(signal, handler)
    child.on('error', (error) => {
      process.stderr.write(`scratch-home: ${error.message}\n`)
      resolvePromise(127)
    })
    child.on('exit', (code, signal) => {
      for (const [name, handler] of handlers) process.off(name, handler)
      resolvePromise(code ?? (signal === undefined ? 1 : 128 + (os.constants.signals[signal] ?? 0)))
    })
  })
}

/** Remove a scratch root after proving it is one. */
export function destroyScratch(root) {
  const resolved = resolveThroughLinks(root)
  const tmp = tmpRoot()
  if (!within(resolved, tmp) || fold(resolved) === fold(tmp)) throw new Error(`scratch-home: refusing to remove ${resolved}: not under ${tmp}`)
  if (!path.basename(resolved).startsWith(PREFIX)) throw new Error(`scratch-home: refusing to remove ${resolved}: not a ${PREFIX}* directory`)
  if (!existsSync(path.join(resolved, MARKER))) throw new Error(`scratch-home: refusing to remove ${resolved}: no ${MARKER}`)
  assertScratchDshHome(layout(resolved).DSH_HOME)
  rmSync(resolved, { recursive: true, force: true })
}

// ---------------------------------------------------------------- self-test

function selfTest() {
  const results = []
  const check = (name, fn) => {
    try {
      fn()
      results.push(`ok   ${name}`)
    } catch (error) {
      results.push(`FAIL ${name}: ${error.message}`)
    }
  }
  const refuses = (value, options) => {
    let refused = false
    try { assertScratchDshHome(value, options) } catch (error) { refused = /refusing/.test(error.message) }
    if (!refused) throw new Error(`accepted ${JSON.stringify(value)}`)
  }
  const real = realDshHome()
  const created = []
  try {
    const a = createScratch('self-test')
    created.push(a.root)
    const tmp = tmpRoot()

    check('create: root is a fresh mkdtemp dir under os.tmpdir()', () => {
      if (!within(a.root, tmp) || !path.basename(a.root).startsWith(PREFIX)) throw new Error(a.root)
      if ((statSync(a.root).mode & 0o077) !== 0) throw new Error('root is readable by group or others')
      if (!existsSync(path.join(a.root, MARKER))) throw new Error('marker missing')
    })
    check('create: second root differs', () => {
      const b = createScratch('self-test-b')
      created.push(b.root)
      if (b.root === a.root) throw new Error('same root twice')
    })
    check('guard accepts the scratch DSH_HOME', () => { assertScratchDshHome(a.DSH_HOME) })
    check('guard refuses unset DSH_HOME', () => { refuses(undefined) })
    check('guard refuses empty DSH_HOME', () => { refuses('') })
    check('guard refuses blank DSH_HOME', () => { refuses('   ') })
    check('guard refuses a relative DSH_HOME', () => { refuses('.dsh') })
    check('guard refuses the real ~/.dsh', () => { refuses(real) })
    check('guard refuses the real ~/.dsh with a trailing separator', () => { refuses(real + path.sep) })
    check('guard refuses a path inside the real ~/.dsh', () => { refuses(path.join(real, 'profiles', 'web')) })
    check('guard refuses a dot-dot path that lands in the real ~/.dsh', () => {
      // Built by concatenation, not path.join, so the guard itself must normalize the dot-dot segments.
      const dotted = tmp + tmp.split(path.sep).filter(Boolean).map(() => `${path.sep}..`).join('') + real
      if (!dotted.includes(`${path.sep}..${path.sep}`)) throw new Error(`no dot-dot segment in ${dotted}`)
      refuses(dotted)
    })
    if (CASE_INSENSITIVE) check('guard refuses a case variant of the real ~/.dsh', () => { refuses(real.toUpperCase()) })
    check('guard refuses a temp dir without the marker', () => {
      const plain = mkdtempSync(path.join(tmp, 'dsh-scratch-nomarker-'))
      created.push(plain)
      refuses(path.join(plain, '.dsh'))
    })
    check('guard refuses a path outside the temp dir', () => { refuses(path.join(realUserHome(), 'not-a-scratch-home')) })
    check('guard refuses a symlink that resolves into the protected home', () => {
      // A fake protected home inside the scratch root stands in for ~/.dsh, so no real file is touched.
      const fakeReal = path.join(a.root, 'fake-real-home', '.dsh')
      mkdirSync(path.join(fakeReal, 'profiles'), { recursive: true })
      const link = path.join(a.root, 'home', 'link-to-protected')
      symlinkSync(fakeReal, link)
      if (!lstatSync(link).isSymbolicLink()) throw new Error('symlink not created')
      refuses(link, { realHome: fakeReal })
      refuses(path.join(link, 'profiles'), { realHome: fakeReal })
      assertScratchDshHome(a.DSH_HOME, { realHome: fakeReal })
    })
    check('env: every home variable points inside the scratch root', () => {
      const env = scratchEnv(a.root)
      for (const name of ['HOME', 'DSH_HOME', 'DSH_AGENTS_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TMPDIR']) {
        if (!within(env[name], a.root)) throw new Error(`${name}=${env[name]}`)
      }
      if (env.DSH_TELEMETRY_DISABLED !== '1') throw new Error('telemetry not disabled')
    })
    check('env: inherited DSH_* and secret-looking variables are dropped', () => {
      const env = scratchEnv(a.root, {
        parentEnv: {
          PATH: '/usr/bin', DSH_HOME: real, DSH_PROFILE: 'web', DSH_PROFILE_DIR: path.join(real, 'profiles', 'web'),
          DSH_SESSION_ID: 'x', DSH_WEB_URL: 'http://127.0.0.1:3080', DEEPSEEK_API_KEY: 'secret', HOME: realUserHome(),
          XDG_STATE_HOME: path.join(realUserHome(), '.local', 'state'),
        },
      })
      for (const name of Object.keys(env)) {
        if (name.startsWith('DSH_') && !['DSH_HOME', 'DSH_AGENTS_HOME', 'DSH_TELEMETRY_DISABLED'].includes(name)) throw new Error(name)
      }
      if ('DEEPSEEK_API_KEY' in env) throw new Error('secret kept')
      if (env.PATH !== '/usr/bin') throw new Error('PATH not kept')
      if (!within(env.HOME, a.root) || !within(env.XDG_STATE_HOME, a.root)) throw new Error('home not replaced')
    })
    check('env: --set refuses a value naming the real ~/.dsh', () => {
      let refused = false
      try { scratchEnv(a.root, { set: { PROBE: path.join(real, 'x') } }) } catch (error) { refused = /refusing/.test(error.message) }
      if (!refused) throw new Error('accepted')
    })
    check('env: --set refuses to override a home variable', () => {
      let refused = false
      try { scratchEnv(a.root, { set: { XDG_DATA_HOME: '/tmp/x' } }) } catch (error) { refused = /refusing/.test(error.message) }
      if (!refused) throw new Error('accepted')
    })
    check('run: the child sees only the scratch environment', () => {
      const script = 'process.stdout.write(JSON.stringify(process.env))'
      const env = scratchEnv(a.root)
      const out = spawnSync(process.execPath, ['-e', script], { cwd: a.work, env, encoding: 'utf8' })
      if (out.status !== 0) throw new Error(out.stderr)
      const seen = JSON.parse(out.stdout)
      if (seen.DSH_HOME !== a.DSH_HOME || seen.HOME !== a.HOME) throw new Error(JSON.stringify(seen))
      if (seen.DSH_PROFILE_DIR !== undefined || seen.DSH_PROFILE !== undefined) throw new Error('profile variables leaked')
      if (JSON.stringify(seen).includes(real + path.sep) || Object.values(seen).includes(real)) throw new Error('real home leaked')
    })
    check('run subcommand: exit code and child env through the CLI entry', () => {
      const dump = path.join(a.root, 'env-dump.txt')
      const out = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'run', a.root, '--env-dump', dump, '--',
        process.execPath, '-e', 'process.exit(process.env.DSH_HOME === process.argv[1] ? 7 : 1)', a.DSH_HOME], { encoding: 'utf8' })
      if (out.status !== 7) throw new Error(`exit ${out.status}: ${out.stderr}`)
      if (!readFileSync(dump, 'utf8').includes(`DSH_HOME=${a.DSH_HOME}`)) throw new Error('env dump lacks DSH_HOME')
    })
    check('run subcommand: refuses a root that is not a scratch root', () => {
      const out = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'run', realUserHome(), '--', 'true'], { encoding: 'utf8' })
      if (out.status === 0 || !/refusing/.test(out.stderr)) throw new Error(`exit ${out.status}`)
    })
    check('check subcommand: refuses the real ~/.dsh, accepts the scratch home', () => {
      const bad = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'check', real], { encoding: 'utf8' })
      const good = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'check', a.DSH_HOME], { encoding: 'utf8' })
      if (bad.status !== 2 || good.status !== 0) throw new Error(`bad=${bad.status} good=${good.status}`)
    })
    check('destroy: refuses a path that is not a scratch root', () => {
      let refused = false
      try { destroyScratch(realUserHome()) } catch (error) { refused = /refusing/.test(error.message) }
      if (!refused) throw new Error('accepted')
    })
  } finally {
    for (const root of created.reverse()) {
      try {
        if (existsSync(path.join(root, MARKER))) destroyScratch(root)
        else if (within(root, tmpRoot()) && path.basename(root).startsWith(PREFIX)) rmSync(root, { recursive: true, force: true })
      } catch (error) {
        results.push(`FAIL cleanup ${root}: ${error.message}`)
      }
    }
    results.push(created.every(root => !existsSync(root)) ? 'ok   cleanup: every self-test root removed' : 'FAIL cleanup: a root remains')
  }
  process.stdout.write(results.join('\n') + '\n')
  const failed = results.filter(line => line.startsWith('FAIL')).length
  process.stdout.write(failed === 0 ? `self-test passed (${results.length} checks)\n` : `self-test FAILED (${failed} of ${results.length})\n`)
  return failed === 0 ? 0 : 1
}

// ---------------------------------------------------------------- CLI

async function main(argv) {
  const [command, ...rest] = argv
  switch (command) {
    case '--self-test':
      return selfTest()
    case 'create': {
      const label = rest[0] === '--label' ? rest[1] : undefined
      process.stdout.write(JSON.stringify(createScratch(label), undefined, 2) + '\n')
      return 0
    }
    case 'env': {
      const env = scratchEnv(rest[0])
      process.stdout.write(Object.entries(env).map(([name, value]) => `export ${name}='${String(value).replace(/'/g, `'\\''`)}'`).join('\n') + '\n')
      return 0
    }
    case 'check': {
      try {
        const result = assertScratchDshHome(rest[0])
        process.stdout.write(`ok ${result.resolved} (root ${result.root})\n`)
        return 0
      } catch (error) {
        process.stderr.write(`${error.message}\n`)
        return 2
      }
    }
    case 'run':
    case 'dsh': {
      const [root, ...more] = rest
      const { options, command: child } = parseRunArgs(more)
      const full = command === 'dsh' ? [findLauncher(options.dsh), ...child] : child
      return await runScratch(root, full, options)
    }
    case 'destroy':
      destroyScratch(rest[0])
      process.stdout.write(`removed ${rest[0]}\n`)
      return 0
    default:
      process.stderr.write('usage: scratch-home.mjs create|env|run|dsh|check|destroy|--self-test (see the header of this file)\n')
      return 64
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }, (error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 2
  })
}
