/**
 * Shared HTTP + error taxonomy for the usage provider modules.
 *
 * Every provider fetch returns one of:
 *   { body }                            success, parsed JSON object
 *   { failure, status?, detail }        failure code + operator-readable text
 *
 * Failure codes: missing-credential, credential-read-failed, timeout,
 * network, redirect-refused, too-large, bad-response, http-<status>. The
 * panel prints `detail` verbatim.
 *
 * The outbound policy lives here, once, for all three runtimes (this file's
 * mountProvider, openrouter.js and kimi.js):
 *   - `checkedBaseUrl` polices a configured base URL at mount: https, or http
 *     to loopback, or http anywhere with `allowHttp: true`; no user info, no
 *     query, no fragment.
 *   - `requestJson` is the one place that calls fetch: redirects are followed
 *     only within the request's origin (at most MAX_REDIRECTS), the reply body
 *     is capped at MAX_BODY_BYTES, and the timeout covers every hop and the
 *     body read.
 *   - The credential is redacted from the parsed reply and from every failure
 *     text before anything is stored, and `cleanDetail` makes every stored
 *     detail one line of at most MAX_DETAIL_CHARS characters.
 */

/** The largest reply body read, in bytes (1 MiB). */
export const MAX_BODY_BYTES = 1024 * 1024
/** Same-origin redirects followed before the request is refused. */
export const MAX_REDIRECTS = 3
/** The longest `detail` stored in a state. */
export const MAX_DETAIL_CHARS = 300
/**
 * Values shorter than this are not redacted: no real API key or OAuth token
 * is this short, and replacing a 1-7 character string would garble ordinary
 * words in every message.
 */
export const MIN_SECRET_LENGTH = 8
export const REDACTED = '[redacted]'

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length > 0) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

/**
 * Epoch milliseconds → ISO string, or null when the value is not a usable
 * reset time: not a number (numeric strings are accepted like `num`), NaN,
 * negative, or outside the range `Date` can represent (new Date(1e20)
 * .toISOString() throws RangeError, which must not fail the whole provider).
 */
export function epochMsToIso(value) {
  const ms = num(value)
  if (ms === null || ms < 0) return null
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Clamp a configured millisecond value into a safe range. */
export function clampMs(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * The text of a caught value, safe to print into state: a rejection with no
 * prototype (`Object.create(null)`) or a throwing getter would make
 * `String(error)` throw inside the catch block that is meant to report it.
 */
export function safeMessage(error) {
  try {
    return String(error?.message ?? error)
  } catch {
    return 'The error could not be read.'
  }
}

/** The prototype marker the Gateway's SRC discovery reads. */
export const REMOTE_METHOD_MARKER = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** Best-effort operator-facing message from an error reply body. */
export function errorMessage(body, status) {
  if (isRecord(body)) {
    const err = isRecord(body.error) ? body.error : null
    const text = (err && (err.message || err.type)) || body.message || body.msg
    if (typeof text === 'string' && text.length > 0) return `HTTP ${status}: ${text}`
  }
  return `HTTP ${status}`
}

// --- redaction ---

/** "Bearer <token>" for any token-shaped value of 16 characters or more. */
const BEARER_TOKEN = /\b(Bearer)\s+[A-Za-z0-9\-._~+/]{16,}=*/gi

/**
 * The forms a credential can take in a reply: the value itself, its
 * URL-encoded form and its JSON-escaped form. Values shorter than
 * MIN_SECRET_LENGTH are skipped. Longest first, so a longer form is replaced
 * whole.
 */
function secretForms(secrets) {
  const forms = new Set()
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) continue
    forms.add(secret)
    for (const encode of [encodeURIComponent, (s) => JSON.stringify(s).slice(1, -1)]) {
      try {
        const form = encode(secret)
        if (form.length >= MIN_SECRET_LENGTH) forms.add(form)
      } catch {
        // A lone surrogate cannot be URL-encoded: the raw form still counts.
      }
    }
  }
  return [...forms].sort((a, b) => b.length - a.length)
}

function redactForms(text, forms) {
  let out = text
  for (const form of forms) if (out.includes(form)) out = out.split(form).join(REDACTED)
  return out.replace(BEARER_TOKEN, `$1 ${REDACTED}`)
}

/**
 * `text` with every form of each secret replaced by `[redacted]`, and any
 * "Bearer <token>" the server quotes replaced too.
 */
export function redact(text, secrets = []) {
  return redactForms(typeof text === 'string' ? text : safeMessage(text), secretForms(secrets))
}

/**
 * The text a state may store as `detail`: redacted, ONE line (line breaks,
 * tabs and control characters become one space) and at most `max`
 * characters (MAX_DETAIL_CHARS by default; a cut text ends in "…").
 * null and undefined stay null.
 */
export function cleanDetail(text, secrets = [], max = MAX_DETAIL_CHARS) {
  if (text === null || text === undefined) return null
  const line = redact(text, secrets).replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()
  if (line.length <= max) return line
  let cut = Math.max(0, max - 1)
  // Never split a surrogate pair.
  if (/[\uD800-\uDBFF]/.test(line.charAt(cut - 1))) cut -= 1
  return `${line.slice(0, cut)}…`
}

/**
 * The credential an Authorization header carries: x for "Bearer x" (so an
 * echoed header reads "Bearer [redacted]"), else the whole value (GLM's raw
 * key).
 */
function authorizationSecrets(headers) {
  const out = []
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() !== 'authorization' || typeof value !== 'string') continue
    const scheme = /^\s*(?:Bearer|Basic|Token)\s+(.+)$/i.exec(value)
    out.push(scheme ? scheme[1].trim() : value)
  }
  return out
}

/** A state endpoint: origin plus path, never user info, a query or a fragment; null when unusable. */
export function endpointOf(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const url = new URL(value)
    if (url.origin === 'null') return null
    return url.origin + url.pathname.replace(/\/+$/, '')
  } catch {
    return null
  }
}

// --- the base-URL policy, checked at mount ---

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/** localhost, 127.0.0.0/8 or [::1]; the URL parser has already normalized the host. */
function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '[::1]' || LOOPBACK_V4.test(hostname)
}

/**
 * Check one base URL against the outbound policy: https; http only to
 * localhost, 127.0.0.0/8 or [::1], or anywhere with `allowHttp: true`; no user
 * info, no query, no fragment.
 * @returns { ok: true, baseUrl, origin, plainHttp } — baseUrl is origin plus
 *   path without trailing slashes, plainHttp is true for http to a
 *   non-loopback host — or { ok: false, reason }. The reason never contains
 *   user info, a query or a fragment.
 */
export function checkBaseUrl(raw, { allowHttp = false } = {}) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    return { ok: false, reason: 'it is not an absolute URL' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `its scheme (${url.protocol}) is not https` }
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'it carries user info (user:password@); store the credential in Settings → Models instead' }
  }
  // href keeps an empty "?" or "#"; search and hash do not.
  if (url.href.includes('?') || url.href.includes('#')) {
    return { ok: false, reason: 'it carries a query or a fragment' }
  }
  const origin = url.origin
  const baseUrl = origin + url.pathname.replace(/\/+$/, '')
  const plainHttp = url.protocol === 'http:' && !isLoopback(url.hostname)
  if (plainHttp && allowHttp !== true) {
    return { ok: false, reason: `plain http to ${origin} is allowed only for localhost, 127.0.0.0/8 and [::1], or with allowHttp: true` }
  }
  return { ok: true, baseUrl, origin, plainHttp }
}

/**
 * The base URL one provider mounts with, or null when the provider must stay
 * unmounted. Logs at most ONE console.warn: why the URL was refused, or what
 * the accepted URL implies (plain http with `allowHttp: true`; an OAuth token
 * sent to a host other than the default).
 * @param id - provider id for the log line.
 * @param raw - the configured base URL, or the provider default.
 * @param config - the provider config; `allowHttp` counts only when it is the boolean true.
 * @param oauth - for OAuth bearer providers: `oauthDefault` (the default base) and `tokenName`.
 */
export function checkedBaseUrl(id, raw, config, { oauthDefault, tokenName = 'sign-in token' } = {}) {
  const checked = checkBaseUrl(raw, { allowHttp: config?.allowHttp === true })
  if (!checked.ok) {
    console.warn(`usage: provider "${id}" refused its baseUrl: ${checked.reason}. The provider is not mounted.`)
    return null
  }
  const notes = []
  if (checked.plainHttp) {
    notes.push(`baseUrl ${checked.origin} uses plain http (allowHttp: true), so the credential travels unencrypted`)
  }
  const defaultOrigin = oauthDefault ? new URL(oauthDefault).origin : null
  if (defaultOrigin && checked.origin !== defaultOrigin) {
    notes.push(`the ${tokenName} is sent to ${checked.origin}, a non-default host (the default is ${defaultOrigin}); use only a host you trust`)
  }
  if (notes.length > 0) console.warn(`usage: provider "${id}": ${notes.join('; ')}.`)
  return checked.baseUrl
}

// --- the one request function ---

/** A redirect target for a message: its origin only, never its path or query. */
function originOf(url) {
  return url.origin !== 'null' ? url.origin : url.protocol
}

/** Drop a reply body we will not read, so the connection is released. */
function discard(response) {
  try {
    response.body?.cancel?.().catch?.(() => {})
  } catch {
    // Nothing to release.
  }
}

/**
 * Read a reply body as text, at most MAX_BODY_BYTES. Resolves null when the
 * body grows past the cap (reading stops there); rejects with an AbortError
 * when `signal` aborts first, even if the stream itself ignores the signal.
 */
async function readCapped(response, signal) {
  const stream = response.body
  if (stream === null) return ''
  if (typeof stream?.getReader !== 'function') throw new TypeError('The reply has no readable body.')
  const reader = stream.getReader()
  let onAbort
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  aborted.catch(() => {})
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted])
      if (done) break
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
      total += bytes.byteLength
      if (total > MAX_BODY_BYTES) return null
      text += decoder.decode(bytes, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    signal.removeEventListener('abort', onAbort)
    reader.cancel().catch(() => {})
  }
}

/**
 * GET one JSON URL under the outbound policy. The ONE fetch call of the
 * package: fetchUsageJson, openrouter.js and kimi.js all come through here and
 * keep their own failure mapping.
 *
 *  - `redirect: 'manual'`: a redirect is followed only to the SAME origin, at
 *    most MAX_REDIRECTS times, re-sending `headers` only there. Any other
 *    redirect is 'redirect-refused', and its detail names only the target
 *    origin. Authorization therefore never reaches another origin.
 *  - The body is capped at MAX_BODY_BYTES: a larger Content-Length, or a body
 *    that grows past the cap while it is read, is 'too-large'.
 *  - `timeoutMs` covers every hop and the body read.
 *  - Every string in the parsed body, and every failure detail, is redacted:
 *    the credential in Authorization always (the token after "Bearer ", or
 *    the whole raw value), plus any `secrets`.
 *
 * @param url - absolute URL (its base was checked at mount).
 * @param opts.headers - plain header object, passed to fetch unchanged.
 * @returns one of
 *   { status, ok, body }            the body parsed as JSON (strings redacted)
 *   { status, ok, notJson: true }   the body is not JSON or could not be read
 *   { failure, status?, detail }    timeout | network | redirect-refused | too-large
 */
export async function requestJson(url, { headers = {}, timeoutMs = 15_000, secrets = [] } = {}) {
  const forms = secretForms([...secrets, ...authorizationSecrets(headers)])
  const timedOut = (status) => ({ failure: 'timeout', ...(status === undefined ? {} : { status }), detail: `No reply within ${timeoutMs} ms.` })
  let origin
  try {
    origin = new URL(url).origin
  } catch {
    return { failure: 'network', detail: 'The request URL is not valid.' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let target = String(url)
    let response
    for (let hop = 0; ; hop += 1) {
      try {
        response = await fetch(target, { method: 'GET', headers, redirect: 'manual', signal: controller.signal })
      } catch (error) {
        if (error?.name === 'AbortError' || controller.signal.aborted) return timedOut()
        return { failure: 'network', detail: cleanDetail(redactForms(safeMessage(error), forms)) }
      }
      const status = response.status
      if (response.type === 'opaqueredirect') {
        discard(response)
        return { failure: 'redirect-refused', status, detail: 'The server answered with a redirect whose target is hidden; the redirect was not followed.' }
      }
      const location = REDIRECT_STATUSES.has(status) ? response.headers?.get?.('location') : null
      if (!location) break
      discard(response)
      let next
      try {
        next = new URL(location, target)
      } catch {
        return { failure: 'redirect-refused', status, detail: 'The server redirected to a target that is not a valid URL; the redirect was not followed.' }
      }
      if (next.origin !== origin) {
        return { failure: 'redirect-refused', status, detail: `The server redirected to ${originOf(next)}, another origin; the redirect was not followed, so the credential was not sent there.` }
      }
      if (hop >= MAX_REDIRECTS) {
        return { failure: 'redirect-refused', status, detail: `More than ${MAX_REDIRECTS} redirects within ${origin}; the last one was not followed.` }
      }
      target = next.href
    }

    const status = response.status
    const declared = Number(response.headers?.get?.('content-length'))
    if (declared > MAX_BODY_BYTES) {
      discard(response)
      return { failure: 'too-large', status, detail: `The reply declares ${declared} bytes, more than the 1 MiB limit; it was not read.` }
    }
    let text
    try {
      text = await readCapped(response, controller.signal)
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') return timedOut(status)
      return { status, ok: response.ok, notJson: true }
    }
    if (text === null) {
      return { failure: 'too-large', status, detail: 'The reply grew past the 1 MiB limit while it was read; reading stopped.' }
    }
    let body
    try {
      body = JSON.parse(text, (key, value) => (typeof value === 'string' ? redactForms(value, forms) : value))
    } catch {
      return { status, ok: response.ok, notJson: true }
    }
    return { status, ok: response.ok, body }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve a credential and GET one JSON endpoint, with the shared error
 * taxonomy. `auth` selects the header shape: 'bearer' (default) sends
 * `Authorization: Bearer <key>`; 'raw' sends the key bare (GLM coding plan).
 * Extra provider headers go in `headers`. `signIn` names the OAuth provider id
 * (`openai-codex`, `anthropic`): a missing credential then says how to sign in
 * instead of asking for an API key. The request goes through `requestJson`.
 */
export async function fetchUsageJson(ctx, { credentialRef, recordKey, url, auth = 'bearer', headers = {}, timeoutMs, hint401, signIn }) {
  let key
  try {
    if (recordKey) {
      const record = await ctx.credentials.readRecord(recordKey)
      const payload = record?.payload
      key = typeof payload?.access === 'string' ? payload.access.trim() : typeof payload?.apiKey === 'string' ? payload.apiKey.trim() : ''
    } else {
      const record = await ctx.credentials.resolve(credentialRef)
      key = record && typeof record.value === 'string' ? record.value.trim() : ''
    }
  } catch (error) {
    return { failure: 'credential-read-failed', detail: cleanDetail(`Could not read ${recordKey ?? credentialRef}: ${safeMessage(error)}`) }
  }
  if (!key) {
    const ref = recordKey ?? credentialRef
    return {
      failure: 'missing-credential',
      detail: signIn
        ? `No sign-in found for ${ref}. Sign in from Settings → Models or run /provider-login ${signIn}.`
        : `No value for ${ref}. Add the API key in Settings → Models.`,
    }
  }

  const reply = await requestJson(url, {
    headers: { Authorization: auth === 'raw' ? key : `Bearer ${key}`, ...headers, Accept: 'application/json' },
    timeoutMs,
    secrets: [key],
  })
  if (reply.failure) return reply
  if (reply.notJson) {
    return { failure: 'bad-response', status: reply.status, detail: `HTTP ${reply.status} with a body that is not JSON.` }
  }
  if (!reply.ok) {
    // The hint is kept whole: the server's text is cut first.
    const hint = reply.status === 401 && hint401 ? ` ${hint401}` : ''
    const detail = cleanDetail(errorMessage(reply.body, reply.status), [key], MAX_DETAIL_CHARS - hint.length) + hint
    return { failure: `http-${reply.status}`, status: reply.status, detail }
  }
  if (!isRecord(reply.body)) {
    return { failure: 'bad-response', status: reply.status, detail: 'Reply was not a JSON object.' }
  }
  return { body: reply.body }
}

/**
 * Clock time as the text reports print it: the time alone for today, the date
 * and the time for any other day (a read from two days ago must not look like
 * one from this morning). The browser half (client.js) applies the same rule.
 */
function clock(ms) {
  const at = new Date(ms)
  return at.toDateString() === new Date(Date.now()).toDateString() ? at.toLocaleTimeString() : at.toLocaleString()
}

/**
 * The footer every text report ends with, as lines.
 *
 * `fetchedAt` is the last GOOD read; `attemptedAt` the last attempt. The
 * warning appears while the last attempt is a failure (status 'error', or
 * 'loading' with the failure still on the state). A state from an older host
 * has no `attemptedAt`: the warning then falls back to `fetchedAt`.
 */
export function usageFooter(state) {
  const lines = [state.fetchedAt ? `Last good read: ${clock(state.fetchedAt)}` : 'Last good read: never']
  if (state.status === 'error' || state.error) {
    const at = state.attemptedAt ?? state.fetchedAt
    // No detail: no trailing colon either.
    const detail = typeof state.detail === 'string' && state.detail.length > 0 ? `: ${state.detail}` : ''
    lines.push(`Warning: last refresh failed${at ? ` at ${clock(at)}` : ''} (${state.error})${detail}`)
  }
  return lines
}

/**
 * Mount one provider's three surfaces in this order: the service, then its
 * report command, then the poll effect. A failure leaves exactly what was
 * mounted before it:
 *  - `ctx.provide` throws: nothing else is mounted (no command, no poll) and the
 *    error propagates, so the caller logs the provider as failed to mount.
 *  - `ctx.commands.register` throws (a duplicate name, say): that is logged once
 *    and the service and the poll stay mounted, so the card still refreshes
 *    instead of sitting at 'idle' with a service nobody polls.
 *  - `ctx.effect` throws: the service and the command stay mounted (nothing
 *    unmounts them) but nothing polls. The error propagates, rewrapped so its
 *    message names the provider and the poll surface; the caller logs the
 *    provider as failed to mount.
 * @param ctx - plugin context.
 * @param parts - id for the log line, serviceKey, the service, the command definition, the poll effect and its label.
 */
export function mountSurfaces(ctx, { id, serviceKey, api, command, poll, pollLabel }) {
  // `ctx.provide`, not `ctx.set`: `set` only overwrites an already-provided
  // service and throws otherwise. The provide is an effect owned by this
  // plugin's fiber, so unloading the plugin unregisters the service.
  ctx.provide(serviceKey, api)
  try {
    ctx.commands.register(command)
  } catch (error) {
    console.error(`usage: provider "${id}" command "${command.name}" failed to register; the service and its poll stay mounted:`, error)
  }
  // First read shortly after mount, then on an interval. The timer is a Cordis
  // effect, so unloading the plugin clears it.
  try {
    if (pollLabel === undefined) ctx.effect(poll)
    else ctx.effect(poll, pollLabel)
  } catch (error) {
    throw new Error(`provider "${id}" poll effect failed to start; the service and the command stay mounted but nothing polls: ${safeMessage(error)}`, { cause: error })
  }
}

/**
 * The shared provider runtime: cache, publish, single-flight refresh,
 * Remote service provide, command register, poll timer.
 *
 * @param ctx     plugin context
 * @param spec    { id, serviceKey, commandName, commandDescription, formatReport, fetchState }
 *                fetchState(cfg) → { endpoint, data } | { failure, status?, detail }
 * @param cfg     the provider's config section (already defaults-merged)
 */
export function mountProvider(ctx, spec, cfg) {
  const refreshMs = clampMs(cfg.refreshMs, 120_000, 30_000, 3_600_000)
  const timeoutMs = clampMs(cfg.timeoutMs, 15_000, 5_000, 120_000)

  const cache = {
    state: {
      status: 'idle',
      // fetchedAt: the last GOOD read. attemptedAt: the last attempt, good or not.
      fetchedAt: null,
      attemptedAt: null,
      error: null,
      detail: null,
      // Origin plus path only: never user info, a query or a fragment.
      endpoint: endpointOf(spec.endpoint),
      data: null,
      ui: {
        composerChip: cfg.showComposerChip ?? true,
        // Which model-provider ids unhide the composer chip. Config wins over
        // the module default; the client falls back to its own table.
        gate: Array.isArray(cfg.gate) ? cfg.gate : (spec.defaultGate ?? null),
      },
    },
    listeners: new Set(),
  }

  function publish(patch) {
    cache.state = { ...cache.state, ...patch }
    for (const listener of cache.listeners) {
      try {
        listener(cache.state)
      } catch {
        // A broken listener must not stop the others, nor the refresh loop.
      }
    }
  }

  /** The refresh in progress, shared by every caller that arrives meanwhile. */
  let flight = null

  /**
   * Fetch once and publish the outcome; the last good data and fetchedAt
   * survive a failure. A caller that arrives while a refresh is in flight gets
   * that flight's final state, never the transient 'loading'.
   */
  function refresh() {
    if (flight) return flight
    flight = run().finally(() => {
      flight = null
    })
    return flight
  }

  async function run() {
    // error and detail keep their last values while loading.
    publish({ status: 'loading' })
    try {
      const result = await spec.fetchState(ctx, { ...cfg, timeoutMs })
      const now = Date.now()
      if (result.failure) {
        publish({
          status: 'error',
          error: result.failure,
          // One line, at most MAX_DETAIL_CHARS, with any quoted Bearer token
          // redacted. The credential itself was redacted by requestJson from
          // the reply and from its own failure texts.
          detail: cleanDetail(result.detail),
          attemptedAt: now,
        })
      } else {
        publish({
          status: 'ready',
          error: null,
          detail: null,
          endpoint: endpointOf(result.endpoint) ?? cache.state.endpoint,
          data: result.data,
          fetchedAt: now,
          attemptedAt: now,
        })
      }
    } catch (error) {
      publish({ status: 'error', error: 'unexpected', detail: cleanDetail(safeMessage(error)), attemptedAt: Date.now() })
    }
    return cache.state
  }

  // The Remote service: a class instance with the frozen, versioned prototype
  // marker the Gateway's SRC discovery reads — the same shape the shipped
  // TypertRemoteService base produces, hand-written so no codegen is involved.
  class UsageApi {
    snapshot() {
      return cache.state
    }
    refresh() {
      return refresh()
    }
  }
  Object.defineProperty(UsageApi.prototype, REMOTE_METHOD_MARKER, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze([
        Object.freeze({ method: 'snapshot', invocation: Object.freeze({ kind: 'direct' }) }),
        Object.freeze({ method: 'refresh', invocation: Object.freeze({ kind: 'direct' }) }),
      ]),
    }),
  })
  const api = new UsageApi()
  api.typertRemote = Object.freeze({ service: api, serviceKey: spec.serviceKey, namespace: spec.serviceKey })

  mountSurfaces(ctx, {
    id: spec.id,
    serviceKey: spec.serviceKey,
    api,
    command: {
      definitionId: `dsh-plugin-provider-usage/${spec.commandName}`,
      name: spec.commandName,
      description: spec.commandDescription,
      handler: async () => {
        const state = await refresh()
        if (state.status === 'error' && !state.data) {
          return { kind: 'error', text: `${spec.title} usage unavailable: ${state.detail ?? state.error}` }
        }
        return { kind: 'success', text: spec.formatReport(state) }
      },
    },
    poll: () => {
      let cancelled = false
      const tick = () => {
        if (!cancelled) void refresh()
      }
      const initial = setTimeout(tick, 1_000)
      const interval = setInterval(tick, refreshMs)
      return () => {
        cancelled = true
        clearTimeout(initial)
        clearInterval(interval)
      }
    },
    pollLabel: `usage: poll ${spec.id}`,
  })
}
