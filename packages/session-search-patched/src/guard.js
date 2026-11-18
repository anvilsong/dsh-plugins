// Compatibility guard of dsh-plugin-session-search-patched (unofficial).
//
// Pure functions only. The host entry (index.host.js) gathers every input and
// passes it in: the host version of the shipped engine package and the sha256
// of its rc.3 sources. Nothing here reads files, the environment, the clock or
// the row config, and only own properties of the input count, so no setting,
// variable or extra key can switch the guard off.
//
// Pinned values (docs/composition-spike.md, section 8 and the decision table in
// section 13; probe output docs/spike/guard-inputs.txt):
//   version   ctx.get('pluginPackages')?.packageOf(ENGINE_PACKAGE, import.meta.url)?.version
//             must be exactly PINNED_VERSION
//   sources   sha256 of src/index.ts, src/query.ts and src/schema.ts of the shipped
//             engine package (readable from plugin code inside app.asar) must be
//             exactly PINNED_SOURCES, the files the patched engine was rebased on
//   scope     ctx[Symbol.for('cordis.isolate')]?.sessionQuery?.description must be
//             ISOLATED_SCOPE, the label the loader gives the group optional-session-search

export const LOG_PREFIX = 'session-search-patched:'
export const ENGINE_PACKAGE = '@deepseek-ai/dsh-session-query-sqlite'
export const PINNED_VERSION = '0.2.2-rc.3'
export const PINNED_SOURCES = Object.freeze({
  'src/index.ts': '72868e4ae967fee94967df5939ee092a582249ff7b37afc4fe0cf7660d48b8d3',
  'src/query.ts': 'b29363581b715a1eb50509d7c5ff039d7d4004926160cd88ffcbadaa44ca1c48',
  'src/schema.ts': '2cc4c7c8e50409847599a048922d55ef4ffbd1ac2309502f3a5a06420bc1a28f',
})
export const ISOLATED_SCOPE = 'sessionQuery#optional-session-search'

// cordis reflect.ts:303-305 throws this when a second sessionQuery provider
// joins one scope (a later layer re-enabled the shipped engine row).
const CLASH_MARK = 'service "sessionQuery" has been registered'
const MAX_ERROR = 600
const MAX_ENGINE = 200
const MAX_REASON = 2000

/** Own property of a plain value, else undefined. May throw (hostile getters); callers catch. */
function own(object, key) {
  if (object === null || typeof object !== 'object') return undefined
  return Object.hasOwn(object, key) ? object[key] : undefined
}

/** Collapse line breaks and bound the length, so a value always fits one log line. */
function flat(text, max) {
  const single = String(text).replace(/\s*[\r\n]+\s*/g, ' | ').trim()
  return single.length > max ? `${single.slice(0, max - 1)}…` : single
}

const short = (hex) => `${hex.slice(0, 12)}…`

/** Why an input value is not usable: the error the entry recorded, or its type. */
function missing(value) {
  const error = own(value, 'error')
  if (typeof error === 'string') return flat(error, MAX_ERROR)
  if (value === undefined) return 'no value'
  if (value === null) return 'null'
  const type = Array.isArray(value) ? 'list' : typeof value
  return `${type === 'object' ? 'an' : 'a'} ${type}, not a string`
}

/**
 * One line describing an error or any thrown value; never throws.
 * @param {unknown} error
 * @returns {string}
 */
export function describeError(error) {
  try {
    if (error !== null && (typeof error === 'object' || typeof error === 'function') && 'message' in error) {
      const message = String(error.message)
      const code = typeof error.code === 'string' && error.code !== '' && !message.startsWith(error.code) ? `${error.code}: ` : ''
      return flat(code + message, MAX_ERROR)
    }
    return flat(String(error), MAX_ERROR)
  } catch {
    return 'an unreadable error'
  }
}

/**
 * True when the error is cordis refusing a second sessionQuery provider in one scope.
 * @param {unknown} error
 */
export function isProviderClash(error) {
  try {
    const message = error !== null && typeof error === 'object' ? error.message : error
    return typeof message === 'string' && message.includes(CLASH_MARK)
  } catch {
    return false
  }
}

/**
 * Is the row inside the isolated sessionQuery scope of the session-search group?
 * @param {unknown} description the description of ctx[Symbol.for('cordis.isolate')].sessionQuery
 * @returns {Readonly<{ ok: boolean, reason: string }>}
 */
export function checkScope(description) {
  if (description === ISOLATED_SCOPE) {
    return Object.freeze({ ok: true, reason: `inside the isolated sessionQuery scope ${ISOLATED_SCOPE}` })
  }
  const found = typeof description === 'string' ? `"${flat(description, MAX_ENGINE)}"` : 'none'
  return Object.freeze({
    ok: false,
    reason: `this row is not inside the isolated sessionQuery scope ${ISOLATED_SCOPE} (found: ${found}); `
      + 'nothing is mounted, since an engine here would provide or clash outside the session-search group',
  })
}

/**
 * Is the host the one the patched engine was built for?
 * @param {{ version?: unknown, sources?: unknown }} input
 *   version: the version string, or `{ error }` when it could not be read;
 *   sources: `{ [file]: sha256 hex | { error } }`, or `{ error }`
 * @returns {Readonly<{ ok: boolean, reason: string }>}
 */
export function checkHost(input) {
  try {
    const problems = []
    const version = own(input, 'version')
    if (typeof version !== 'string' || version === '') {
      problems.push(`host version of ${ENGINE_PACKAGE} unknown (${missing(version)})`)
    } else if (version !== PINNED_VERSION) {
      problems.push(`host ${ENGINE_PACKAGE} is ${flat(version, MAX_ENGINE)}, not the pinned ${PINNED_VERSION}`)
    }
    const sources = own(input, 'sources')
    // `{ error }` in place of the whole table: the reader itself failed.
    const readerFailed = typeof own(sources, 'error') === 'string'
    for (const [file, expected] of Object.entries(PINNED_SOURCES)) {
      const actual = own(sources, file)
      if (typeof actual !== 'string') {
        problems.push(`shipped ${file} unreadable (${missing(actual === undefined && readerFailed ? sources : actual)})`)
      } else if (actual !== expected) {
        problems.push(`shipped ${file} sha256 ${short(flat(actual, 64))} is not the pinned ${short(expected)}`)
      }
    }
    if (problems.length > 0) {
      return Object.freeze({ ok: false, reason: flat(`compatibility guard failed: ${problems.join('; ')}`, MAX_REASON) })
    }
    return Object.freeze({
      ok: true,
      reason: `host ${ENGINE_PACKAGE} ${PINNED_VERSION} and the sha256 of its ${Object.keys(PINNED_SOURCES).join(', ')} match the pinned values`,
    })
  } catch (error) {
    return Object.freeze({ ok: false, reason: `compatibility guard failed: unreadable guard input (${describeError(error)})` })
  }
}

/**
 * The one log line of a start of the row.
 * @param {unknown} engine the active engine ('patched …', 'shipped …', 'none …')
 * @param {unknown} reason why
 * @returns {string}
 */
export function formatLine(engine, reason) {
  let engineText
  let reasonText
  try { engineText = flat(engine, MAX_ENGINE) } catch { engineText = 'unknown' }
  try { reasonText = flat(reason, MAX_REASON) } catch { reasonText = 'unknown' }
  return `${LOG_PREFIX} active engine: ${engineText}; reason: ${reasonText}`
}
