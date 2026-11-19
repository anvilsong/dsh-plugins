// Where explanation pages go: the plugin-owned folder, named in the prompt.
//
// resolvePagesDir() decides the folder from two strings, the plugin config and
// the DSH home, and from nothing else. It reads no file system, no environment
// variable and no home directory; the caller hands the DSH home in. The plugin
// never creates the folder: the agent writes the page with its own file tools.

import path from 'node:path'

/** The folder under the DSH home; cordis.patch.yml names the same folder. */
export const PAGES_FOLDER = 'explainer'

/** The longest resolved folder, in UTF-16 code units (string length). */
export const MAX_PATH_LENGTH = 512

// C0 and C1 controls, every Unicode format character (zero-width space and
// joiners, word joiner, byte order mark, soft hyphen, tag characters), every
// Bidi_Control character, line and paragraph separators, and backticks. The
// prompt quotes the folder in one backtick span, so a backtick would break
// out of it; the other characters are invisible or reorder the text, so a
// reader could not see what the folder really is.
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Bidi_Control}\u2028\u2029`]/u

function withoutTrailingSeparator(value, flavor) {
  const { root } = flavor.parse(value)
  const last = value[value.length - 1]
  return value.length > root.length && (last === flavor.sep || last === '/') ? value.slice(0, -1) : value
}

/**
 * The string rules the folder and the DSH home share: a non-empty string, no
 * unsafe character, no surrounding whitespace, absolute and not a filesystem
 * root, no `..` segment, normalized as given (at most one trailing separator),
 * at most MAX_PATH_LENGTH characters; on Windows a drive or UNC share. Returns
 * the value without its trailing separator, and throws an Error naming
 * `subject` otherwise.
 */
function checkedPath(value, flavor, subject) {
  const fail = (text) => { throw new Error(`${subject} ${text}`) }
  if (typeof value !== 'string' || value === '') fail('must be a non-empty string')
  if (UNSAFE_CHARACTERS.test(value)) fail('must not contain control, invisible format, line or paragraph separator, bidirectional control, or backtick characters')
  if (value.trim() !== value) fail('must not start or end with whitespace')
  if (value.startsWith('~') || !flavor.isAbsolute(value)) fail(`must be an absolute path, not ${JSON.stringify(value)}`)
  const { root } = flavor.parse(value)
  if (flavor === path.win32 && (root === '\\' || root === '/')) fail(`must name a drive or UNC share, not the drive-relative ${JSON.stringify(value)}`)
  if (value.split(/[\\/]/).includes('..')) fail('must not contain ".." segments')
  const normalized = withoutTrailingSeparator(flavor.normalize(value), flavor)
  if (normalized === flavor.parse(normalized).root) fail('must not be a filesystem root')
  // Windows accepts both separators; normalize() turns '/' into '\'.
  const comparable = flavor === path.win32 ? value.replaceAll('/', '\\') : value
  if (withoutTrailingSeparator(comparable, flavor) !== normalized) fail(`must be a normalized path such as ${JSON.stringify(normalized)}`)
  if (normalized.length > MAX_PATH_LENGTH) fail(`must not be longer than ${MAX_PATH_LENGTH} characters`)
  return normalized
}

/** The same folder as the home? Compared by string, after normalization; Windows ignores case. */
function sameFolder(left, right, flavor) {
  const key = (value) => {
    const normalized = withoutTrailingSeparator(flavor.normalize(value), flavor)
    return flavor === path.win32 ? normalized.toLowerCase() : normalized
  }
  return key(left) === key(right)
}

/**
 * The folder for explanation pages, by string rules alone.
 * - A set `config.dataDir` must pass the path rules and must not be the home
 *   itself (when a home is available); an invalid value throws and never
 *   falls back to another folder.
 * - Unset, the folder is `<home>/explainer` when `home` is an absolute string;
 *   the raw home must pass the same rules first, because joining would hide
 *   `..` and doubled separators. An absolute home that fails them throws.
 * - With no dataDir and no usable home (not a string, or not absolute) the
 *   result is undefined: the caller says that pages are unavailable.
 * Nothing here touches the file system, so the folder may not exist yet, and
 * a folder inside the project repository or another sensitive place cannot
 * be told apart: choosing dataDir is the user's responsibility.
 * @param {{ dataDir?: unknown } | null | undefined} config plugin config
 * @param {{ home?: unknown, platform?: string }} [options] `home`: the DSH home
 *   (profileContext.home); `platform`: path rules to apply, default process.platform
 * @returns {string | undefined} absolute normalized folder
 */
export function resolvePagesDir(config, options) {
  const flavor = (options?.platform ?? process.platform) === 'win32' ? path.win32 : path.posix
  const configured = config !== null && typeof config === 'object' ? config.dataDir : undefined
  const home = options?.home
  const homeAvailable = typeof home === 'string' && flavor.isAbsolute(home)
  if (configured !== undefined) {
    const dataDir = checkedPath(configured, flavor, 'dataDir')
    // The home may fail the rules here; it is only compared, never used.
    if (homeAvailable && sameFolder(dataDir, home, flavor)) {
      throw new Error('dataDir must not be the DSH home itself: the pages folder must be a subfolder, not the home itself')
    }
    return dataDir
  }
  if (!homeAvailable) return undefined
  let base
  try {
    base = checkedPath(home, flavor, 'The DSH home')
  } catch (error) {
    throw new Error(`${error.message} (needed for the default folder)`)
  }
  const folder = flavor.join(base, PAGES_FOLDER)
  if (folder.length > MAX_PATH_LENGTH) throw new Error(`The pages folder must not be longer than ${MAX_PATH_LENGTH} characters (needed for the default folder)`)
  return folder
}
