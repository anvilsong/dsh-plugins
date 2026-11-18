// Config resolution for dsh-plugin-sessions.
//
// resolveConfig() turns the raw plugin config into one frozen object: numbers
// clamped to documented ranges, paths validated by their string alone. An
// invalid path throws a ConfigError and never falls back to a default.
// This module reads no environment variable and no home directory: the DSH
// home is handed in by the caller, and only the default dataDir is derived
// from it. The session store root is never derived here at all.

import path from 'node:path'

/** Defaults; cordis.patch.yml repeats them (a test compares both). */
export const DEFAULTS = Object.freeze({
  recentActivityMinutes: 30,
  listLimit: 500,
  largeSessionBytes: 52_428_800, // 50 MB, a heuristic
  indexWarnBytes: 268_435_456, // 256 MiB of on-disk bytes, a heuristic
  allowPermanentDelete: true,
  refreshMs: 0, // 0: refresh only on demand
  planTtlMinutes: 10,
  snapshotTtlMs: 15_000,
})

/** Inclusive clamp ranges of the numeric options. `zero` marks a value that may also be 0 (off). */
export const RANGES = Object.freeze({
  recentActivityMinutes: Object.freeze({ min: 1, max: 10_080 }), // up to one week; never 0, so a session in use is always protected
  listLimit: Object.freeze({ min: 10, max: 5_000 }),
  largeSessionBytes: Object.freeze({ min: 1_048_576, max: 1_099_511_627_776 }), // 1 MiB .. 1 TiB
  indexWarnBytes: Object.freeze({ min: 1_048_576, max: 1_099_511_627_776 }),
  refreshMs: Object.freeze({ min: 5_000, max: 3_600_000, zero: true }),
  planTtlMinutes: Object.freeze({ min: 1, max: 60 }),
  snapshotTtlMs: Object.freeze({ min: 0, max: 120_000 }),
})

/** Names of the keys the patch sets, in patch order. trashDir is optional and not listed. */
export const CONFIG_KEYS = Object.freeze(['dataDir', ...Object.keys(DEFAULTS)])

export const TRASH_FOLDER = 'trash'
export const DATA_FOLDER = 'sessions-manager'

/** An invalid config value. `field` names the key; `code` is always 'invalid-config'. */
export class ConfigError extends Error {
  /** @param {string} field @param {string} message */
  constructor(field, message) {
    super(message)
    this.name = 'ConfigError'
    this.code = 'invalid-config'
    this.field = field
  }
}

// C0 and C1 controls, every Bidi_Control character, line and paragraph
// separators, and backticks (the same set as the repository's ledger paths).
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Bidi_Control}\u2028\u2029`]/u

function withoutTrailingSeparator(value, flavor) {
  const { root } = flavor.parse(value)
  const last = value[value.length - 1]
  return value.length > root.length && (last === flavor.sep || last === '/') ? value.slice(0, -1) : value
}

/**
 * The string rules every configured path shares: absolute, not a filesystem
 * root, normalized as given (at most one trailing separator), no `..` segment,
 * no surrounding whitespace, no unsafe characters; on Windows a drive or UNC
 * share. Returns the value normalized without a trailing separator.
 */
export function checkedPath(value, flavor, field) {
  const fail = (text) => { throw new ConfigError(field, `${field} ${text}`) }
  if (typeof value !== 'string' || value === '') fail('must be a non-empty string')
  if (UNSAFE_CHARACTERS.test(value)) fail('must not contain control, line or paragraph separator, bidirectional control, or backtick characters')
  if (value.trim() !== value) fail('must not start or end with whitespace')
  if (value.startsWith('~') || !flavor.isAbsolute(value)) fail(`must be an absolute path, not ${JSON.stringify(value)}`)
  const { root } = flavor.parse(value)
  if (flavor === path.win32 && (root === '\\' || root === '/')) fail(`must name a drive or UNC share, not the drive-relative ${JSON.stringify(value)}`)
  if (value.split(/[\\/]/).includes('..')) fail('must not contain ".." segments')
  const normalized = withoutTrailingSeparator(flavor.normalize(value), flavor)
  if (normalized === flavor.parse(normalized).root) fail('must not be a filesystem root')
  const comparable = flavor === path.win32 ? value.replaceAll('/', '\\') : value
  if (withoutTrailingSeparator(comparable, flavor) !== normalized) fail(`must be a normalized path such as ${JSON.stringify(normalized)}`)
  return normalized
}

/** Clamp a number into a range; an unset, blank or non-numeric value gives the default. */
export function clampNumber(value, fallback, { min, max, zero = false }) {
  if (value === undefined || value === null || typeof value === 'boolean') return fallback
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const rounded = Math.round(n)
  if (zero && rounded <= 0) return 0
  return Math.min(max, Math.max(min, rounded))
}

/**
 * Resolve the plugin config once.
 * - dataDir: a set value must pass checkedPath. Unset, it is
 *   `<home>/sessions-manager`, and the raw home must pass the same rules first.
 * - trashDir: optional; a set value must pass checkedPath (a blank string is
 *   set, not unset). Unset, it is `<dataDir>/trash`.
 * - allowPermanentDelete: a boolean; any other set value throws, so a stray
 *   string can never switch permanent delete on.
 * - numbers: see RANGES; a missing or non-numeric value gives the default.
 * Nothing here touches the file system: owner, type and device checks are the
 * caller's (see paths.js).
 * @param {Record<string, unknown> | null | undefined} raw plugin config
 * @param {{ home?: unknown, platform?: string }} [options] `home`: the DSH home
 *   (profileContext.home); `platform`: path rules, default process.platform
 * @returns {Readonly<{ dataDir: string, trashDir: string, trashDirConfigured: boolean,
 *   recentActivityMinutes: number, listLimit: number, largeSessionBytes: number,
 *   indexWarnBytes: number, allowPermanentDelete: boolean, refreshMs: number,
 *   planTtlMinutes: number, snapshotTtlMs: number }>}
 */
export function resolveConfig(raw, options) {
  const flavor = (options?.platform ?? process.platform) === 'win32' ? path.win32 : path.posix
  const config = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}

  let dataDir
  if (config.dataDir !== undefined) {
    dataDir = checkedPath(config.dataDir, flavor, 'dataDir')
  } else {
    const home = options?.home
    if (typeof home !== 'string' || !flavor.isAbsolute(home)) throw new ConfigError('dataDir', 'dataDir is not configured and no absolute DSH home was given')
    let base
    try {
      base = checkedPath(home, flavor, 'home')
    } catch (error) {
      throw new ConfigError('dataDir', `${error.message} (needed for the default dataDir)`)
    }
    dataDir = flavor.join(base, DATA_FOLDER)
  }

  const trashConfigured = config.trashDir !== undefined
  const trashDir = trashConfigured ? checkedPath(config.trashDir, flavor, 'trashDir') : flavor.join(dataDir, TRASH_FOLDER)

  let allowPermanentDelete = DEFAULTS.allowPermanentDelete
  if (config.allowPermanentDelete !== undefined) {
    if (typeof config.allowPermanentDelete !== 'boolean') throw new ConfigError('allowPermanentDelete', 'allowPermanentDelete must be true or false')
    allowPermanentDelete = config.allowPermanentDelete
  }

  const number = (key) => clampNumber(config[key], DEFAULTS[key], RANGES[key])
  return Object.freeze({
    dataDir,
    trashDir,
    trashDirConfigured: trashConfigured,
    recentActivityMinutes: number('recentActivityMinutes'),
    listLimit: number('listLimit'),
    largeSessionBytes: number('largeSessionBytes'),
    indexWarnBytes: number('indexWarnBytes'),
    allowPermanentDelete,
    refreshMs: number('refreshMs'),
    planTtlMinutes: number('planTtlMinutes'),
    snapshotTtlMs: number('snapshotTtlMs'),
  })
}
