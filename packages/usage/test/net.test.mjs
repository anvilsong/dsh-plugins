import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { clampMs, errorMessage, fetchUsageJson, isRecord, mountProvider, mountSurfaces, num } from '../src/providers/net.js'
import { mountAnthropic } from '../src/providers/anthropic.js'
import { mountCodex } from '../src/providers/codex.js'
import { mountDeepSeek } from '../src/providers/deepseek.js'
import { mountZhipu } from '../src/providers/zhipu.js'

// net.js: the shared fetch + error taxonomy and the shared provider runtime.
// The runtime is exercised through DeepSeek (no hint) and GLM (401 hint) and
// through fetchUsageJson directly. fetch is stubbed in every test and restored
// in finally; the after() hook proves the real fetch is back. No report footer
// and no timestamps are asserted (test/stale-state.test.mjs owns those).

const REAL_FETCH = globalThis.fetch
after(() => {
  assert.equal(globalThis.fetch, REAL_FETCH, 'a test leaked its fetch stub')
})

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const html = (status) => new Response('<html>bad gateway</html>', { status, headers: { 'Content-Type': 'text/html' } })
const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })

/** A fetch that never answers until its signal aborts, then rejects like undici. */
const hang = (url, init) => new Promise((resolve, reject) => {
  init.signal.addEventListener('abort', () => reject(abortError()))
})

/** Install a stub fetch for one body of work; always restore. */
async function withFetch(handler, fn) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = REAL_FETCH
  }
}

const credentials = (value) => ({ resolve: async () => (value === undefined ? undefined : { value }) })

// --- pure helpers ---

test('num accepts finite numbers and numeric strings, nothing else', () => {
  assert.equal(num(3), 3)
  assert.equal(num(0), 0)
  assert.equal(num('12.5'), 12.5)
  assert.equal(num(''), null)
  assert.equal(num('abc'), null)
  assert.equal(num(NaN), null)
  assert.equal(num(Infinity), null)
  assert.equal(num(null), null)
  assert.equal(num(undefined), null)
  assert.equal(num({}), null)
})

test('isRecord is true only for plain non-array objects', () => {
  assert.equal(isRecord({}), true)
  assert.equal(isRecord([]), false)
  assert.equal(isRecord(null), false)
  assert.equal(isRecord('x'), false)
})

test('clampMs falls back on junk and clamps into [min, max], rounding', () => {
  assert.equal(clampMs(undefined, 100, 10, 1000), 100)
  assert.equal(clampMs('abc', 100, 10, 1000), 100)
  assert.equal(clampMs(1, 100, 10, 1000), 10)
  assert.equal(clampMs(5000, 100, 10, 1000), 1000)
  assert.equal(clampMs(50.6, 100, 10, 1000), 51)
})

test('errorMessage reads error.message, error.type, message and msg, else the bare status', () => {
  assert.equal(errorMessage({ error: { message: 'm' } }, 400), 'HTTP 400: m')
  assert.equal(errorMessage({ error: { type: 't' } }, 400), 'HTTP 400: t')
  assert.equal(errorMessage({ message: 'top' }, 500), 'HTTP 500: top')
  assert.equal(errorMessage({ msg: 'short' }, 500), 'HTTP 500: short')
  assert.equal(errorMessage({ error: 'plain string' }, 500), 'HTTP 500')
  assert.equal(errorMessage({}, 502), 'HTTP 502')
  assert.equal(errorMessage(null, 502), 'HTTP 502')
  assert.equal(errorMessage([], 502), 'HTTP 502')
})

// --- fetchUsageJson: headers and credential sources ---

test('fetchUsageJson: bearer by default, raw on request, key trimmed, Accept last', async () => {
  await withFetch(() => json({ ok: true }), async (calls) => {
    const bearer = await fetchUsageJson({ credentials: credentials('  k1  ') }, { credentialRef: 'REF', url: 'https://x.test/a', timeoutMs: 1000 })
    assert.deepEqual(bearer, { body: { ok: true } })
    const raw = await fetchUsageJson({ credentials: credentials('k2') }, { credentialRef: 'REF', url: 'https://x.test/b', auth: 'raw', timeoutMs: 1000 })
    assert.deepEqual(raw, { body: { ok: true } })
    assert.equal(calls[0].init.headers.Authorization, 'Bearer k1')
    assert.equal(calls[1].init.headers.Authorization, 'k2')
    assert.equal(calls[0].init.headers.Accept, 'application/json')
    assert.equal(calls[0].init.method, 'GET')
    assert.ok(calls[0].init.signal instanceof AbortSignal)
  })
})

test('fetchUsageJson: extra headers are sent alongside Authorization', async () => {
  await withFetch(() => json({}), async (calls) => {
    await fetchUsageJson({ credentials: credentials('k') }, { credentialRef: 'REF', url: 'https://x.test', headers: { 'X-Test': '1' }, timeoutMs: 1000 })
    assert.equal(calls[0].init.headers['X-Test'], '1')
    assert.equal(calls[0].init.headers.Authorization, 'Bearer k')
  })
})

test('fetchUsageJson: a recordKey reads the stored grant (access, else apiKey) instead of resolve', async () => {
  const read = []
  const ctx = {
    credentials: {
      resolve: async () => { throw new Error('resolve must not be called') },
      readRecord: async (key) => {
        read.push(key)
        return key === 'a' ? { payload: { access: ' tok-a ' } } : { payload: { apiKey: ' tok-b ' } }
      },
    },
  }
  await withFetch(() => json({}), async (calls) => {
    await fetchUsageJson(ctx, { credentialRef: 'a', recordKey: 'a', url: 'https://x.test', timeoutMs: 1000 })
    await fetchUsageJson(ctx, { credentialRef: 'b', recordKey: 'b', url: 'https://x.test', timeoutMs: 1000 })
    assert.deepEqual(read, ['a', 'b'])
    assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-a')
    assert.equal(calls[1].init.headers.Authorization, 'Bearer tok-b')
  })
})

// --- failure taxonomy for the net.js runtime ---

test('net.js failure: a missing credential asks for the API key and makes no request', async () => {
  await withFetch(() => json({}), async (calls) => {
    for (const missing of [undefined, '', '   ']) {
      const result = await fetchUsageJson({ credentials: credentials(missing) }, { credentialRef: 'SOME_KEY', url: 'https://x.test', timeoutMs: 1000 })
      assert.deepEqual(result, { failure: 'missing-credential', detail: 'No value for SOME_KEY. Add the API key in Settings → Models.' })
    }
    assert.equal(calls.length, 0)
  })
})

test('net.js failure: a missing OAuth credential says how to sign in', async () => {
  const ctx = { credentials: { readRecord: async () => undefined } }
  await withFetch(() => json({}), async (calls) => {
    const result = await fetchUsageJson(ctx, { credentialRef: 'llm-pi-ai/anthropic', recordKey: 'llm-pi-ai/anthropic', url: 'https://x.test', timeoutMs: 1000, signIn: 'anthropic' })
    assert.deepEqual(result, {
      failure: 'missing-credential',
      detail: 'No sign-in found for llm-pi-ai/anthropic. Sign in from Settings → Models or run /provider-login anthropic.',
    })
    assert.equal(calls.length, 0)
  })
})

test('net.js failure: a credential read failure keeps the reference and the reason, no request', async () => {
  const ctx = { credentials: { resolve: async () => { throw new Error('vault locked') } } }
  await withFetch(() => json({}), async (calls) => {
    const result = await fetchUsageJson(ctx, { credentialRef: 'SOME_KEY', url: 'https://x.test', timeoutMs: 1000 })
    assert.deepEqual(result, { failure: 'credential-read-failed', detail: 'Could not read SOME_KEY: vault locked' })
    assert.equal(calls.length, 0)
  })
  const thrownString = { credentials: { resolve: async () => { throw 'plain' } } }
  assert.equal((await fetchUsageJson(thrownString, { credentialRef: 'R', url: 'https://x.test', timeoutMs: 1000 })).detail, 'Could not read R: plain')
})

test('net.js failure: HTTP 401 appends the provider hint; other statuses and no hint do not', async () => {
  const ctx = { credentials: credentials('k') }
  const opts = { credentialRef: 'REF', url: 'https://x.test', timeoutMs: 1000, hint401: 'Check the key.' }
  await withFetch(() => json({ error: { message: 'denied' } }, 401), async () => {
    assert.deepEqual(await fetchUsageJson(ctx, opts), { failure: 'http-401', status: 401, detail: 'HTTP 401: denied Check the key.' })
    assert.deepEqual(await fetchUsageJson(ctx, { ...opts, hint401: undefined }), { failure: 'http-401', status: 401, detail: 'HTTP 401: denied' })
  })
  await withFetch(() => json({ error: { message: 'down' } }, 500), async () => {
    assert.deepEqual(await fetchUsageJson(ctx, opts), { failure: 'http-500', status: 500, detail: 'HTTP 500: down' })
  })
})

test('net.js failure: a body that is not JSON is bad-response with the status', async () => {
  const ctx = { credentials: credentials('k') }
  await withFetch(() => html(502), async () => {
    assert.deepEqual(
      await fetchUsageJson(ctx, { credentialRef: 'REF', url: 'https://x.test', timeoutMs: 1000 }),
      { failure: 'bad-response', status: 502, detail: 'HTTP 502 with a body that is not JSON.' },
    )
  })
})

test('net.js failure: a JSON body that is not an object is bad-response', async () => {
  const ctx = { credentials: credentials('k') }
  await withFetch(() => json([1]), async () => {
    assert.deepEqual(
      await fetchUsageJson(ctx, { credentialRef: 'REF', url: 'https://x.test', timeoutMs: 1000 }),
      { failure: 'bad-response', status: 200, detail: 'Reply was not a JSON object.' },
    )
  })
})

test('net.js failure: an AbortError from fetch is timeout, not network', async () => {
  const ctx = { credentials: credentials('k') }
  await withFetch(() => { throw abortError() }, async () => {
    assert.deepEqual(
      await fetchUsageJson(ctx, { credentialRef: 'REF', url: 'https://x.test', timeoutMs: 1234 }),
      { failure: 'timeout', detail: 'No reply within 1234 ms.' },
    )
  })
})

test('net.js failure: a reply that never comes is aborted by the timer and reported as timeout', async () => {
  const ctx = { credentials: credentials('k') }
  await withFetch(hang, async () => {
    assert.deepEqual(
      await fetchUsageJson(ctx, { credentialRef: 'REF', url: 'https://x.test', timeoutMs: 25 }),
      { failure: 'timeout', detail: 'No reply within 25 ms.' },
    )
  })
})

test('net.js failure: a body read cut off by the timer is timeout, not bad-response', async () => {
  const ctx = { credentials: credentials('k') }
  const slowBody = (url, init) => ({
    ok: true,
    status: 200,
    json: () => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(abortError()))
    }),
  })
  await withFetch(slowBody, async () => {
    assert.deepEqual(
      await fetchUsageJson(ctx, { credentialRef: 'REF', url: 'https://x.test', timeoutMs: 25 }),
      { failure: 'timeout', status: 200, detail: 'No reply within 25 ms.' },
    )
  })
})

test('net.js failure: any other fetch error is network with its message', async () => {
  const ctx = { credentials: credentials('k') }
  await withFetch(() => { throw new TypeError('fetch failed') }, async () => {
    assert.deepEqual(
      await fetchUsageJson(ctx, { credentialRef: 'REF', url: 'https://x.test', timeoutMs: 1000 }),
      { failure: 'network', detail: 'fetch failed' },
    )
  })
  await withFetch(() => { throw 'refused' }, async () => {
    assert.equal((await fetchUsageJson(ctx, { credentialRef: 'REF', url: 'https://x.test', timeoutMs: 1000 })).detail, 'refused')
  })
})

// --- the shared runtime, through DeepSeek and GLM ---

/** Mount a net.js provider on a fake ctx and return its api and command. */
function mountOn(mount, key, value, config = {}) {
  let api
  let command
  const effects = []
  mount({
    credentials: { resolve: async () => (value === undefined ? undefined : { value }), readRecord: async () => undefined },
    provide(k, v) { if (k === key) api = v },
    commands: { register(c) { command = c } },
    effect(fn, label) { effects.push({ fn, label }) },
  }, config)
  return { api, command, effects }
}

const DEEPSEEK_OK = { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '1', granted_balance: '0', topped_up_balance: '1' }] }

test('runtime: a missing credential reaches state and the command as an error with no data', async () => {
  await withFetch(() => json(DEEPSEEK_OK), async (calls) => {
    const h = mountOn(mountDeepSeek, 'deepseekUsage', undefined)
    const state = await h.api.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'missing-credential')
    assert.equal(state.detail, 'No value for DEEPSEEK_API_KEY. Add the API key in Settings → Models.')
    assert.equal(state.data, null)
    assert.equal(calls.length, 0)
    const result = await h.command.handler({})
    assert.equal(result.kind, 'error')
    assert.equal(result.text, `DeepSeek usage unavailable: ${state.detail}`)
  })
})

test('runtime: a credential read failure reaches state as credential-read-failed', async () => {
  await withFetch(() => json(DEEPSEEK_OK), async (calls) => {
    let api
    mountDeepSeek({
      credentials: { resolve: async () => { throw new Error('vault locked') } },
      provide(k, v) { api = v },
      commands: { register() {} },
      effect() {},
    }, {})
    const state = await api.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'credential-read-failed')
    assert.equal(state.detail, 'Could not read DEEPSEEK_API_KEY: vault locked')
    assert.equal(calls.length, 0)
  })
})

test('runtime: HTTP 401 reaches state with its hint (GLM) and without one (DeepSeek)', async () => {
  await withFetch(() => json({ msg: 'bad token' }, 401), async () => {
    const glm = mountOn(mountZhipu, 'zhipuUsage', 'k')
    const glmState = await glm.api.refresh()
    assert.equal(glmState.error, 'http-401')
    assert.equal(glmState.detail, 'HTTP 401: bad token Check the GLM Coding Plan key — this API takes the raw key, no Bearer prefix.')
    const ds = mountOn(mountDeepSeek, 'deepseekUsage', 'k')
    const dsState = await ds.api.refresh()
    assert.equal(dsState.error, 'http-401')
    assert.equal(dsState.detail, 'HTTP 401: bad token')
  })
})

test('runtime: a non-JSON body, an AbortError and a network error each reach state with their own code', async () => {
  await withFetch(() => html(502), async () => {
    const state = await mountOn(mountDeepSeek, 'deepseekUsage', 'k').api.refresh()
    assert.equal(state.error, 'bad-response')
    assert.equal(state.detail, 'HTTP 502 with a body that is not JSON.')
  })
  await withFetch(() => { throw abortError() }, async () => {
    const state = await mountOn(mountDeepSeek, 'deepseekUsage', 'k').api.refresh()
    assert.equal(state.error, 'timeout')
    assert.equal(state.detail, 'No reply within 15000 ms.')
  })
  await withFetch(() => { throw new TypeError('fetch failed') }, async () => {
    const state = await mountOn(mountDeepSeek, 'deepseekUsage', 'k').api.refresh()
    assert.equal(state.error, 'network')
    assert.equal(state.detail, 'fetch failed')
  })
})

test('runtime: the timeout budget is clamped to 5 s at least, 120 s at most, 15 s by default', async () => {
  await withFetch(() => { throw abortError() }, async () => {
    for (const [timeoutMs, expected] of [[1, 5000], [999_999, 120000], [undefined, 15000], [8000, 8000]]) {
      const state = await mountOn(mountDeepSeek, 'deepseekUsage', 'k', { timeoutMs }).api.refresh()
      assert.equal(state.detail, `No reply within ${expected} ms.`, `timeoutMs ${timeoutMs}`)
    }
  })
})

test('runtime: a fetchState that throws becomes an unexpected error with its message', async () => {
  let api
  mountProvider({
    provide(k, v) { api = v },
    commands: { register() {} },
    effect() {},
  }, {
    id: 'probe', title: 'Probe', serviceKey: 'probeUsage', commandName: 'usage-probe', commandDescription: 'x', formatReport: () => '',
    fetchState: async () => { throw new Error('boom') },
  }, {})
  const state = await api.refresh()
  assert.equal(state.status, 'error')
  assert.equal(state.error, 'unexpected')
  assert.equal(state.detail, 'boom')
})

test('runtime: the service is provided before the command and one poll effect is registered', () => {
  const order = []
  mountDeepSeek({
    credentials: { resolve: async () => undefined },
    provide() { order.push('provide') },
    commands: { register() { order.push('register') } },
    effect(fn, label) { order.push(`effect:${label}`) },
  }, {})
  assert.deepEqual(order, ['provide', 'register', 'effect:usage: poll deepseek'])
})

/** Run fn with Date.now fixed at `now` (settable), restored afterwards. */
async function withNow(now, fn) {
  const real = Date.now
  let current = now
  Date.now = () => current
  try {
    return await fn((value) => { current = value })
  } finally {
    Date.now = real
  }
}

/** A thrown value with no prototype: `String(value)` throws on it. */
const unprintable = () => Object.create(null)

test('runtime: the unexpected-throw path sets attemptedAt (and leaves fetchedAt alone)', async () => {
  await withNow(1_700_000_000_000, async () => {
    let api
    mountProvider({ provide(k, v) { api = v }, commands: { register() {} }, effect() {} }, {
      id: 'probe', title: 'Probe', serviceKey: 'probeUsage', commandName: 'usage-probe', commandDescription: 'x', formatReport: () => '',
      fetchState: async () => { throw new Error('boom') },
    }, {})
    const state = await api.refresh()
    assert.equal(state.error, 'unexpected')
    assert.equal(state.attemptedAt, 1_700_000_000_000)
    assert.equal(state.fetchedAt, null)
  })
})

test('runtime: a value that cannot be printed, thrown by fetchState, still ends in an error state with a safe message', async () => {
  let api
  let command
  mountProvider({ provide(k, v) { api = v }, commands: { register(c) { command = c } }, effect() {} }, {
    id: 'probe', title: 'Probe', serviceKey: 'probeUsage', commandName: 'usage-probe', commandDescription: 'x', formatReport: () => '',
    fetchState: async () => { throw unprintable() },
  }, {})
  const state = await api.refresh()
  assert.equal(state.status, 'error')
  assert.equal(state.error, 'unexpected')
  assert.equal(typeof state.detail, 'string')
  assert.ok(state.detail.length > 0)
  assert.equal((await command.handler({})).kind, 'error')
})

test('runtime: credentials.resolve rejecting with a value that cannot be printed is a credential-read-failed state, not a rejected refresh', async () => {
  await withFetch(() => json(DEEPSEEK_OK), async (calls) => {
    let api
    let command
    mountDeepSeek({
      credentials: { resolve: async () => { throw unprintable() } },
      provide(k, v) { api = v },
      commands: { register(c) { command = c } },
      effect() {},
    }, {})
    const state = await api.refresh()
    assert.equal(state.status, 'error')
    assert.equal(state.error, 'credential-read-failed')
    assert.match(state.detail, /^Could not read DEEPSEEK_API_KEY: \S/)
    assert.equal(calls.length, 0)
    assert.equal((await command.handler({})).kind, 'error')
  })
})

test('fetchUsageJson: a credential read that rejects with an unprintable value is credential-read-failed with the reference', async () => {
  const ctx = { credentials: { resolve: async () => { throw unprintable() } } }
  const result = await fetchUsageJson(ctx, { credentialRef: 'REF', url: 'https://x.test', timeoutMs: 1000 })
  assert.equal(result.failure, 'credential-read-failed')
  assert.match(result.detail, /^Could not read REF: \S/)
})

test('net.js failure: HTTP 401 never gets the sign-in wording; only a missing credential does', async () => {
  const ref = { credentialRef: 'REF', url: 'https://x.test', timeoutMs: 1000, signIn: 'openai-codex' }
  await withFetch(() => json({ error: { message: 'token expired' } }, 401), async () => {
    const result = await fetchUsageJson({ credentials: credentials('tok') }, ref)
    assert.equal(result.failure, 'http-401')
    assert.equal(result.detail, 'HTTP 401: token expired')
    assert.ok(!/sign.?in|provider-login/i.test(result.detail), result.detail)
  })
  const missing = await fetchUsageJson({ credentials: credentials(undefined) }, ref)
  assert.equal(missing.failure, 'missing-credential')
  assert.match(missing.detail, /Sign in from Settings → Models or run \/provider-login openai-codex/)
})

test('net.js failure: Codex and Claude 401 replies reach state without the sign-in wording', async () => {
  for (const [mount, key] of [[mountCodex, 'codexUsage'], [mountAnthropic, 'anthropicUsage']]) {
    await withFetch(() => json({ error: { message: 'token expired' } }, 401), async () => {
      let api
      mount({
        credentials: { resolve: async () => ({ value: 'tok' }), readRecord: async () => ({ kind: 'grant', payload: { access: 'tok' } }) },
        provide(k, v) { if (k === key) api = v },
        commands: { register() {} },
        effect() {},
      }, {})
      const state = await api.refresh()
      assert.equal(state.error, 'http-401', key)
      assert.ok(!/sign.?in|provider-login/i.test(state.detail), `${key}: ${state.detail}`)
    })
  }
})

// --- mountSurfaces: what a failure leaves mounted, and what the error names ---

/** A ctx that records what stays mounted; `failEffect` makes ctx.effect throw. */
function surfaceCtx({ failProvide, failRegister, failEffect } = {}) {
  const mounted = { service: false, command: false, effect: false }
  return {
    mounted,
    provide() { if (failProvide) throw new Error('provide boom'); mounted.service = true },
    commands: { register() { if (failRegister) throw new Error('register boom'); mounted.command = true } },
    effect() { if (failEffect) throw new Error('effect boom'); mounted.effect = true },
  }
}
const SURFACES = { id: 'probe', serviceKey: 'probeUsage', api: {}, command: { name: 'usage-probe' }, poll: () => () => {}, pollLabel: 'usage: poll probe' }

test('mountSurfaces: a ctx.effect that throws leaves the service and the command mounted, and the error names the poll surface and the provider', () => {
  const ctx = surfaceCtx({ failEffect: true })
  assert.throws(() => mountSurfaces(ctx, SURFACES), (error) => {
    assert.match(error.message, /probe/)
    assert.match(error.message, /poll/)
    assert.match(error.message, /effect boom/)
    assert.equal(error.cause?.message, 'effect boom')
    return true
  })
  assert.deepEqual(ctx.mounted, { service: true, command: true, effect: false })
})

test('mountSurfaces: a command register that throws is logged once and the service and the poll stay mounted; provide failing mounts nothing', () => {
  const real = console.error
  const lines = []
  console.error = (...args) => { lines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')) }
  try {
    const ctx = surfaceCtx({ failRegister: true })
    mountSurfaces(ctx, SURFACES)
    assert.deepEqual(ctx.mounted, { service: true, command: false, effect: true })
    assert.equal(lines.length, 1)
    assert.match(lines[0], /usage-probe/)
    const none = surfaceCtx({ failProvide: true })
    assert.throws(() => mountSurfaces(none, SURFACES), /provide boom/)
    assert.deepEqual(none.mounted, { service: false, command: false, effect: false })
  } finally {
    console.error = real
  }
})

// --- known drift: desired behaviour, failing today ---

test('Codex reset_at 1e20 should give resetAt null with status ready', { todo: "today: status 'error', error 'unexpected', detail 'Invalid time value'" }, async () => {
  const body = { plan_type: 'plus', rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1e20 } } }
  await withFetch(() => json(body), async () => {
    let api
    mountCodex({
      credentials: { readRecord: async () => ({ kind: 'grant', payload: { access: 'tok' } }) },
      provide(k, v) { if (k === 'codexUsage') api = v },
      commands: { register() {} },
      effect() {},
    }, {})
    const state = await api.refresh()
    assert.equal(state.status, 'ready')
    assert.equal(state.data.windows[0].resetAt, null)
    assert.equal(state.data.windows[0].usedRatio, 0.1)
  })
})
