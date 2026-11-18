// Path-safety helpers for dsh-plugin-sessions.
//
// Every move into or out of the trash goes through these checks. They are
// small and pure apart from the file-system calls they make (lstat, realpath,
// stat). They read no environment variable and no home directory, and the
// store root is always a value the caller passes in.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ERROR } from './contract.js'

/** A session id is one path segment: it starts with a letter or digit and holds no separator. */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** An unsafe path. `code` is `path-unsafe` (a refusal code) or a contract error code. */
export class PathError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.name = 'PathError'
    this.code = code
  }
}

const unsafe = (message) => new PathError('path-unsafe', message)

/**
 * The folder that holds a session's log, or null. The log must sit directly
 * in a folder named exactly like the session id (`<store>/<...>/<id>/<log>`),
 * so a folder shared with other sessions or a mismatched name is never moved.
 * @param {string} logPath absolute path of the session log
 * @param {string} id session id
 * @returns {string | null}
 */
export function sessionFolderOf(logPath, id) {
  if (typeof logPath !== 'string' || typeof id !== 'string' || !SESSION_ID.test(id)) return null
  if (!path.isAbsolute(logPath) || logPath.includes('\0') || logPath.split(/[\\/]/).includes('..')) return null
  const folder = path.dirname(logPath)
  if (path.basename(folder) !== id) return null
  // A folder directly under the filesystem root is not a store folder.
  const parent = path.dirname(folder)
  if (parent === path.parse(parent).root) return null
  return folder
}

const isWithin = (root, target) => {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/**
 * Prove that `target` lies inside `root` and that no component below `root`
 * is a symlink. `root` itself and its ancestors may be symlinked (a temp
 * folder on macOS is); its real path is the reference. Throws PathError
 * `path-unsafe`; a missing target throws too unless `allowMissing` is set,
 * which accepts a missing tail below an existing, checked parent.
 * @param {string} root absolute folder
 * @param {string} target absolute path to check
 * @param {{ allowMissing?: boolean }} [options]
 * @returns {Promise<string>} the real path of `target` (or of its deepest existing parent plus the missing tail)
 */
export async function assertInside(root, target, options) {
  if (typeof root !== 'string' || typeof target !== 'string' || !path.isAbsolute(root) || !path.isAbsolute(target)) throw unsafe('root and target must be absolute paths')
  if (root.includes('\0') || target.includes('\0')) throw unsafe('path contains a NUL character')
  const lexicalRoot = path.resolve(root)
  const lexicalTarget = path.resolve(target)
  if (!isWithin(lexicalRoot, lexicalTarget)) throw unsafe('target is outside the root')
  let realRoot
  try {
    realRoot = await fs.realpath(lexicalRoot)
  } catch (error) {
    throw unsafe(`root cannot be resolved (${error.code ?? error.message})`)
  }
  const parts = path.relative(lexicalRoot, lexicalTarget).split(path.sep).filter(Boolean)
  let current = realRoot
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index])
    let stat
    try {
      stat = await fs.lstat(current)
    } catch (error) {
      if (error.code === 'ENOENT' && options?.allowMissing) return path.join(current, ...parts.slice(index + 1))
      throw unsafe(`${error.code === 'ENOENT' ? 'path does not exist' : `cannot inspect the path (${error.code ?? error.message})`}: ${parts.slice(0, index + 1).join('/')}`)
    }
    if (stat.isSymbolicLink()) throw unsafe(`symlinked component: ${parts.slice(0, index + 1).join('/')}`)
  }
  const real = await fs.realpath(current)
  if (!isWithin(realRoot, real)) throw unsafe('target resolves outside the root')
  return real
}

/** Real path of the deepest existing ancestor of `target`, joined with the missing tail. */
async function realOrProjected(target) {
  const tail = []
  let current = path.resolve(target)
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...tail)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw unsafe(`cannot resolve ${current} (${error.code ?? error.message})`)
      const parent = path.dirname(current)
      if (parent === current) throw unsafe(`cannot resolve ${target}`)
      tail.unshift(path.basename(current))
      current = parent
    }
  }
}

/**
 * Refuse a trash folder inside the sessions tree (the backend scans that tree
 * and would list trashed sessions) and the reverse (the store inside the
 * trash). Equal folders are refused too. Symlinks are resolved first, so a
 * link cannot hide an overlap; a folder that does not exist yet is judged by
 * its deepest existing ancestor. Throws PathError `sessions-manager/trash-unusable`.
 * @param {string} sessionsRoot absolute sessions tree
 * @param {string} trashDir absolute trash folder
 * @returns {Promise<void>}
 */
export async function assertDisjoint(sessionsRoot, trashDir) {
  if (typeof sessionsRoot !== 'string' || typeof trashDir !== 'string' || !path.isAbsolute(sessionsRoot) || !path.isAbsolute(trashDir)) {
    throw new PathError(ERROR.trashUnusable, 'sessions root and trash folder must be absolute paths')
  }
  let store
  let trash
  try {
    store = await realOrProjected(sessionsRoot)
    trash = await realOrProjected(trashDir)
  } catch (error) {
    throw new PathError(ERROR.trashUnusable, error.message)
  }
  if (isWithin(store, trash)) throw new PathError(ERROR.trashUnusable, 'the trash folder must be outside the sessions tree')
  if (isWithin(trash, store)) throw new PathError(ERROR.trashUnusable, 'the sessions tree must be outside the trash folder')
}

/**
 * Whether two paths are on the same device (a rename between them cannot
 * fall back to a copy). A path that cannot be stat'ed gives false: refuse.
 * @param {string} a
 * @param {string} b
 * @param {(target: string) => Promise<{ dev: number | bigint }>} [stat] injected stat, default fs.stat
 * @returns {Promise<boolean>}
 */
export async function sameDevice(a, b, stat = (target) => fs.stat(target)) {
  try {
    const [first, second] = await Promise.all([stat(a), stat(b)])
    const valid = (dev) => typeof dev === 'number' || typeof dev === 'bigint'
    return valid(first?.dev) && valid(second?.dev) && first.dev === second.dev
  } catch {
    return false
  }
}
