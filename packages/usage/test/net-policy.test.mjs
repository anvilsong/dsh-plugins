import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import test, { after, before } from 'node:test'
import * as net from '../src/providers/net.js'
import { mountAnthropic } from '../src/providers/anthropic.js'
import { mountCodex } from '../src/providers/codex.js'
import { mountDeepSeek } from '../src/providers/deepseek.js'
import { mountKimi } from '../src/providers/kimi.js'
import { mountMiniMax } from '../src/providers/minimax.js'
import { mountNewApi } from '../src/providers/newapi.js'
import { mountOpenRouter } from '../src/providers/openrouter.js'
import { mountZhipu } from '../src/providers/zhipu.js'

// The outbound policy every provider request goes through (net.js
// requestJson): the base-URL check at mount, same-origin redirects only, the
// 1 MiB body cap, and credential redaction in every text the plugin stores or
// prints. fetch is stubbed for every non-loopback URL; the redirect, size and
// slow-body tests use two real http servers on 127.0.0.1 (port 0), closed in
// after(). Credentials are fake strings.

const REAL_FETCH = globalThis.fetch
after(() => {
  assert.equal(globalThis.fetch, REAL_FETCH, 'a test leaked its fetch stub')
})

const MiB = 1024 * 1024
/** A fake API key and a fake OAuth access token, long enough to be redacted. */
const KEY = 'sk-test-SECRET-0123456789abcdef'
const TOKEN = 'oauth-access-TOKEN-9876543210zyx'

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const OK = {
  kimi: { usages: { limit_5h: { used_ratio: 0.1, reset_time: '2026-11-19T00:00:00Z' } } },
  deepseek: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '0', topped_up_balance: '12.34' }] },
  zhipu: { success: true, data: { level: 'pro', limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 25, usage: 100, remaining: 75, nextResetTime: 1797339952000 }] } },
  minimax: { base_resp: { status_code: 0 }, model_remains: [{ model_name: 'general', current_interval_remaining_percent: 80, end_time: 1797339952000 }] },
  newapi: { code: 200, data: { total_granted: 1_000_000, total_used: 500_000, total_available: 500_000 } },
  codex: { plan_type: 'plus', rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } },
  anthropic: { five_hour: { utilization: 10, resets_at: '2026-11-19T00:00:00Z' } },
  openrouter: { data: { label: 'k', usage: 1.5, limit: null, limit_remaining: null } },
}

/** The seven providers with a `baseUrl` option, the path each appends, and (OAuth) the default origin. */
const BASE_PROVIDERS = [
  { id: 'kimi', mount: mountKimi, key: 'kimiUsage', command: 'usage-kimi', path: '/usages' },
  { id: 'deepseek', mount: mountDeepSeek, key: 'deepseekUsage', command: 'usage-deepseek', path: '/user/balance' },
  { id: 'zhipu', mount: mountZhipu, key: 'zhipuUsage', command: 'usage-zhipu', path: '/api/monitor/usage/quota/limit' },
  { id: 'minimax', mount: mountMiniMax, key: 'minimaxUsage', command: 'usage-minimax', path: '/v1/api/openplatform/coding_plan/remains' },
  { id: 'newapi', mount: mountNewApi, key: 'newapiUsage', command: 'usage-newapi', path: '/api/usage/token' },
  { id: 'codex', mount: mountCodex, key: 'codexUsage', command: 'usage-codex', path: '/wham/usage', oauth: 'https://chatgpt.com', defaultBase: 'https://chatgpt.com/backend-api' },
  { id: 'anthropic', mount: mountAnthropic, key: 'anthropicUsage', command: 'usage-anthropic', path: '/api/oauth/usage', oauth: 'https://api.anthropic.com', defaultBase: 'https://api.anthropic.com' },
]
const KEY_PROVIDERS = BASE_PROVIDERS.filter((p) => !p.oauth)
const OAUTH_PROVIDERS = BASE_PROVIDERS.filter((p) => p.oauth)

/** All eight providers on their default config (NewAPI needs a site; OpenRouter makes one call). */
const ALL = [
  ...BASE_PROVIDERS.map((p) => ({ ...p, config: p.id === 'newapi' ? { baseUrl: 'https://relay.test' } : {} })),
  { id: 'openrouter', mount: mountOpenRouter, key: 'openrouterUsage', command: 'usage-openrouter', config: { showAccount: false } },
]

/** The bearer value a provider sends: the OAuth access token for Codex and Claude, the key otherwise. */
const secretOf = (p) => (p.oauth ? TOKEN : KEY)

/**
 * Stub fetch and capture every console line for the body of work; always
 * restore. `handler(url, init)` answers each fetch.
 */
async function withStubs(handler, fn) {
  const calls = []
  const logs = []
  const real = { warn: console.warn, error: console.error, log: console.log, info: console.info }
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (!handler) throw new Error('unexpected fetch')
    return handler(String(url), init)
  }
  for (const level of Object.keys(real)) {
    console[level] = (...args) => { logs.push({ level, text: args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' ') }) }
  }
  try {
    return await fn({ calls, logs })
  } finally {
    globalThis.fetch = REAL_FETCH
    Object.assign(console, real)
  }
}

/** Mount one provider on a fake ctx that records its surfaces. */
function mountOn(p, config, { key = KEY, token = TOKEN } = {}) {
  const m = { services: new Map(), commands: new Map(), effects: [] }
  p.mount({
    credentials: {
      resolve: async () => ({ value: key }),
      readRecord: async () => ({ kind: 'grant', payload: { access: token } }),
    },
    provide(k, v) { m.services.set(k, v) },
    commands: { register(c) { m.commands.set(c.name, c) } },
    effect(fn) { m.effects.push(fn) },
  }, config)
  return { m, api: m.services.get(p.key), command: m.commands.get(p.command) }
}

function assertNotMounted(h, label) {
  assert.equal(h.m.services.size, 0, `${label}: no service`)
  assert.equal(h.m.commands.size, 0, `${label}: no command`)
  assert.equal(h.m.effects.length, 0, `${label}: no poll`)
}

function assertMounted(h, p, label) {
  assert.ok(h.api, `${label}: service provided`)
  assert.ok(h.command, `${label}: command registered`)
  assert.equal(h.m.effects.length, 1, `${label}: one poll effect`)
}

// --- the base-URL policy at mount ---

test('base URL: a https self-hosted base (https://relay.example/base) mounts every API-key provider silently and requests below it', async () => {
  for (const p of KEY_PROVIDERS) {
    await withStubs(() => json(OK[p.id]), async ({ calls, logs }) => {
      const h = mountOn(p, { baseUrl: 'https://relay.example/base/' })
      assertMounted(h, p, p.id)
      const state = await h.api.refresh()
      assert.equal(state.status, 'ready', `${p.id}: ${state.detail}`)
      assert.equal(calls[0].url, `https://relay.example/base${p.path}`)
      assert.equal(state.endpoint, 'https://relay.example/base')
      assert.deepEqual(logs, [], p.id)
    })
  }
})

test('base URL: loopback http (localhost, 127.0.0.0/8, [::1]) mounts every API-key provider silently without allowHttp', async () => {
  for (const base of ['http://127.0.0.1:3000', 'http://localhost:8080/x', 'http://127.45.6.7', 'http://[::1]:3000/relay']) {
    for (const p of KEY_PROVIDERS) {
      await withStubs(() => json(OK[p.id]), async ({ calls, logs }) => {
        const h = mountOn(p, { baseUrl: base })
        assertMounted(h, p, `${p.id} ${base}`)
        const state = await h.api.refresh()
        assert.equal(state.status, 'ready', `${p.id} ${base}: ${state.detail}`)
        assert.equal(calls[0].url, `${base}${p.path}`)
        assert.equal(state.endpoint, base)
        assert.deepEqual(logs, [], `${p.id} ${base}`)
      })
    }
  }
})

test('base URL: http to a LAN host (http://192.168.1.5:3000) is refused without allowHttp: the provider is not mounted and one warning says why', async () => {
  // allowHttp is read as a plain boolean: any other value counts as absent.
  for (const allowHttp of [undefined, false, 'true', 1, 'yes', null]) {
    for (const p of BASE_PROVIDERS) {
      await withStubs(() => json(OK[p.id]), async ({ calls, logs }) => {
        const h = mountOn(p, { baseUrl: 'http://192.168.1.5:3000', allowHttp })
        assertNotMounted(h, `${p.id} allowHttp=${allowHttp}`)
        assert.equal(calls.length, 0)
        assert.equal(logs.length, 1, `${p.id} allowHttp=${allowHttp}: ${logs.map((l) => l.text).join(' | ')}`)
        assert.equal(logs[0].level, 'warn')
        assert.match(logs[0].text, new RegExp(`"${p.id}"`))
        assert.match(logs[0].text, /http:\/\/192\.168\.1\.5:3000/)
        assert.match(logs[0].text, /allowHttp: true/)
        assert.match(logs[0].text, /not mounted/)
      })
    }
  }
})

test('base URL: allowHttp: true accepts http://192.168.1.5:3000 for every provider, with one warning that the credential travels unencrypted', async () => {
  for (const p of BASE_PROVIDERS) {
    await withStubs(() => json(OK[p.id]), async ({ calls, logs }) => {
      const h = mountOn(p, { baseUrl: 'http://192.168.1.5:3000', allowHttp: true })
      assertMounted(h, p, p.id)
      assert.equal(logs.length, 1, `${p.id}: ${logs.map((l) => l.text).join(' | ')}`)
      assert.equal(logs[0].level, 'warn')
      assert.match(logs[0].text, new RegExp(`"${p.id}"`))
      assert.match(logs[0].text, /http:\/\/192\.168\.1\.5:3000/)
      assert.match(logs[0].text, /allowHttp/)
      assert.match(logs[0].text, /unencrypted/)
      const state = await h.api.refresh()
      assert.equal(state.status, 'ready', `${p.id}: ${state.detail}`)
      assert.equal(calls[0].url, `http://192.168.1.5:3000${p.path}`)
      assert.equal(state.endpoint, 'http://192.168.1.5:3000')
      assert.equal(logs.length, 1, 'the refresh logs nothing more')
    })
  }
})

test('base URL: allowHttp: true on a https or loopback base changes nothing and warns about nothing', async () => {
  for (const base of ['https://relay.example/base', 'http://127.0.0.1:3000']) {
    for (const p of KEY_PROVIDERS) {
      await withStubs(() => json(OK[p.id]), async ({ logs }) => {
        const h = mountOn(p, { baseUrl: base, allowHttp: true })
        assertMounted(h, p, `${p.id} ${base}`)
        assert.deepEqual(logs, [], `${p.id} ${base}`)
      })
    }
  }
})

test('base URL: user info is refused and the warning prints none of it', async () => {
  for (const base of ['https://admin:hunter2@relay.example/base', 'https://admin@relay.example', 'http://admin:hunter2@127.0.0.1:3000', 'https://:hunter2@relay.example']) {
    for (const p of BASE_PROVIDERS) {
      await withStubs(() => json(OK[p.id]), async ({ calls, logs }) => {
        const h = mountOn(p, { baseUrl: base })
        assertNotMounted(h, `${p.id} ${base}`)
        assert.equal(calls.length, 0)
        assert.equal(logs.length, 1, `${p.id} ${base}: ${logs.map((l) => l.text).join(' | ')}`)
        assert.equal(logs[0].level, 'warn')
        assert.match(logs[0].text, new RegExp(`"${p.id}"`))
        assert.match(logs[0].text, /user info/)
        assert.ok(!logs[0].text.includes('hunter2'), logs[0].text)
        assert.ok(!logs[0].text.includes('admin'), logs[0].text)
      })
    }
  }
})

test('base URL: a query or a fragment is refused, and the warning prints neither', async () => {
  for (const base of ['https://relay.example/base?key=sekrit-q', 'https://relay.example/base#sekrit-f', 'https://relay.example/base?', 'https://relay.example/base#']) {
    for (const p of BASE_PROVIDERS) {
      await withStubs(() => json(OK[p.id]), async ({ calls, logs }) => {
        const h = mountOn(p, { baseUrl: base })
        assertNotMounted(h, `${p.id} ${base}`)
        assert.equal(calls.length, 0)
        assert.equal(logs.length, 1, `${p.id} ${base}`)
        assert.match(logs[0].text, /query or a fragment/)
        assert.ok(!logs[0].text.includes('sekrit'), logs[0].text)
      })
    }
  }
})

test('base URL: other schemes and unparseable values are refused', async () => {
  for (const base of ['ftp://relay.example/base', 'file:///etc/passwd', 'relay.example/base', 'javascript:alert(1)', 'https://', 'not a url']) {
    for (const p of BASE_PROVIDERS) {
      await withStubs(() => json(OK[p.id]), async ({ calls, logs }) => {
        const h = mountOn(p, { baseUrl: base })
        assertNotMounted(h, `${p.id} ${base}`)
        assert.equal(calls.length, 0)
        assert.equal(logs.length, 1, `${p.id} ${base}`)
        assert.match(logs[0].text, /not mounted/)
      })
    }
  }
})

test('base URL: state.endpoint is origin plus path; case, the default port and trailing slashes are normalized', async () => {
  await withStubs(() => json(OK.deepseek), async ({ calls }) => {
    const h = mountOn(BASE_PROVIDERS.find((p) => p.id === 'deepseek'), { baseUrl: 'HTTPS://Relay.EXAMPLE:443/base//' })
    assert.equal((await h.api.snapshot()).endpoint, 'https://relay.example/base')
    const state = await h.api.refresh()
    assert.equal(calls[0].url, 'https://relay.example/base/user/balance')
    assert.equal(state.endpoint, 'https://relay.example/base')
    const report = await h.command.handler({})
    assert.ok(report.text.split('\n').includes('Endpoint: relay.example/base'), report.text)
  })
})

test('Codex and Claude: a custom baseUrl still works and logs one warning that the sign-in token goes to a non-default host', async () => {
  for (const p of OAUTH_PROVIDERS) {
    for (const base of ['https://relay.example/base', 'http://127.0.0.1:3000']) {
      await withStubs(() => json(OK[p.id]), async ({ calls, logs }) => {
        const h = mountOn(p, { baseUrl: base })
        assertMounted(h, p, `${p.id} ${base}`)
        assert.equal(logs.length, 1, `${p.id} ${base}: ${logs.map((l) => l.text).join(' | ')}`)
        assert.equal(logs[0].level, 'warn')
        assert.match(logs[0].text, new RegExp(`"${p.id}"`))
        assert.match(logs[0].text, /token/)
        assert.match(logs[0].text, /non-default host/)
        assert.ok(logs[0].text.includes(new URL(base).origin), logs[0].text)
        assert.ok(logs[0].text.includes(p.oauth), `names the default host: ${logs[0].text}`)
        const state = await h.api.refresh()
        assert.equal(state.status, 'ready', `${p.id}: ${state.detail}`)
        assert.equal(calls[0].url, `${base}${p.path}`)
        assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`)
        assert.ok(!logs.some((l) => l.text.includes(TOKEN)), 'the warning never prints the token')
      })
    }
  }
})

test('Codex and Claude: the default base, or a base on the default origin, logs nothing', async () => {
  for (const p of OAUTH_PROVIDERS) {
    for (const config of [{}, { baseUrl: `${p.defaultBase}/` }, { baseUrl: `${p.oauth}/other` }]) {
      await withStubs(() => json(OK[p.id]), async ({ logs }) => {
        const h = mountOn(p, config)
        assertMounted(h, p, `${p.id} ${JSON.stringify(config)}`)
        assert.deepEqual(logs, [], `${p.id} ${JSON.stringify(config)}`)
      })
    }
  }
})

test('Codex and Claude: allowHttp on a LAN host gives one warning that covers both the plain http and the non-default host', async () => {
  for (const p of OAUTH_PROVIDERS) {
    await withStubs(() => json(OK[p.id]), async ({ logs }) => {
      const h = mountOn(p, { baseUrl: 'http://192.168.1.5:3000', allowHttp: true })
      assertMounted(h, p, p.id)
      assert.equal(logs.length, 1, logs.map((l) => l.text).join(' | '))
      assert.match(logs[0].text, /unencrypted/)
      assert.match(logs[0].text, /non-default host/)
    })
  }
})

test('NewAPI: no baseUrl still says so once, a refused one says why once', async () => {
  const p = BASE_PROVIDERS.find((x) => x.id === 'newapi')
  await withStubs(null, async ({ logs }) => {
    assertNotMounted(mountOn(p, {}), 'no baseUrl')
    assert.equal(logs.length, 1)
    assert.match(logs[0].text, /no baseUrl/)
  })
  await withStubs(null, async ({ logs }) => {
    assertNotMounted(mountOn(p, { baseUrl: 'http://192.168.1.5:3000' }), 'LAN http')
    assert.equal(logs.length, 1)
    assert.match(logs[0].text, /allowHttp/)
  })
})

// --- one request function, manual redirects ---

test('openrouter.js and kimi.js make no fetch call of their own: they use net.js requestJson', () => {
  for (const file of ['openrouter.js', 'kimi.js']) {
    const source = readFileSync(new URL(`../src/providers/${file}`, import.meta.url), 'utf8')
    assert.ok(!/\bfetch\(/.test(source), `${file} calls fetch( itself`)
    assert.match(source, /import \{[^}]*\brequestJson\b[^}]*\} from '\.\/net\.js'/, `${file} imports requestJson`)
  }
  const netSource = readFileSync(new URL('../src/providers/net.js', import.meta.url), 'utf8')
  assert.equal(netSource.match(/\bfetch\(/g)?.length, 1, 'net.js holds the one fetch( call')
})

test('requestJson: GET with the plain header object, redirect manual and a signal; a JSON reply, a non-JSON reply', async () => {
  await withStubs((url) => (url.endsWith('/a') ? json({ a: 1 }) : new Response('<html>', { status: 502 })), async ({ calls }) => {
    const headers = { Authorization: `Bearer ${KEY}`, Accept: 'application/json' }
    assert.deepEqual(await net.requestJson('https://x.test/a', { headers, timeoutMs: 1000 }), { status: 200, ok: true, body: { a: 1 } })
    assert.equal(calls[0].init.method, 'GET')
    assert.equal(calls[0].init.redirect, 'manual')
    assert.equal(calls[0].init.headers, headers)
    assert.ok(calls[0].init.signal instanceof AbortSignal)
    assert.deepEqual(await net.requestJson('https://x.test/b', { headers, timeoutMs: 1000 }), { status: 502, ok: false, notJson: true })
  })
})

test('every provider requests with redirect: manual', async () => {
  for (const p of ALL) {
    await withStubs(() => json(OK[p.id]), async ({ calls }) => {
      const h = mountOn(p, p.config)
      const state = await h.api.refresh()
      assert.equal(state.status, 'ready', `${p.id}: ${state.detail}`)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].init.redirect, 'manual', p.id)
    })
  }
})

test('a redirect to another origin is redirect-refused naming only the target origin, and nothing is sent there (every provider)', async () => {
  const handler = () => new Response('moved', { status: 302, headers: { Location: 'https://evil.example:8443/steal?token=abc#frag' } })
  for (const p of ALL) {
    await withStubs(handler, async ({ calls, logs }) => {
      const h = mountOn(p, p.config)
      const state = await h.api.refresh()
      assert.equal(state.status, 'error')
      assert.equal(state.error, 'redirect-refused', `${p.id}: ${state.detail}`)
      assert.ok(state.detail.includes('https://evil.example:8443'), state.detail)
      assert.ok(!state.detail.includes('/steal'), state.detail)
      assert.ok(!state.detail.includes('token=abc'), state.detail)
      assert.equal(calls.length, 1, `${p.id}: no request to the other origin`)
      assert.deepEqual(logs, [])
      const result = await h.command.handler({})
      assert.equal(result.kind, 'error')
      assert.ok(result.text.includes('https://evil.example:8443'), result.text)
    })
  }
})

test('a https to http redirect on the same host is another origin and is refused', async () => {
  const p = ALL.find((x) => x.id === 'deepseek')
  await withStubs(() => new Response(null, { status: 301, headers: { Location: 'http://api.deepseek.com/user/balance' } }), async ({ calls }) => {
    const state = await mountOn(p, p.config).api.refresh()
    assert.equal(state.error, 'redirect-refused')
    assert.ok(state.detail.includes('http://api.deepseek.com'), state.detail)
    assert.equal(calls.length, 1)
  })
})

test('a redirect whose target is not a valid URL is refused', async () => {
  const p = ALL.find((x) => x.id === 'deepseek')
  await withStubs(() => new Response(null, { status: 302, headers: { Location: 'http://[bad' } }), async ({ calls }) => {
    const state = await mountOn(p, p.config).api.refresh()
    assert.equal(state.error, 'redirect-refused')
    assert.equal(calls.length, 1)
  })
})

// --- the loopback servers: real fetch, real redirects, real bodies ---

/** One http server on 127.0.0.1 that records each request and answers with `handle`. */
function loopbackServer() {
  const s = { port: 0, requests: [], handle: null }
  s.server = http.createServer((req, res) => {
    const n = s.requests.length
    s.requests.push({ url: req.url, authorization: req.headers.authorization ?? null, userAgent: req.headers['user-agent'] ?? null })
    // No keep-alive: a test that kills a hung connection must not leave a
    // dead pooled socket for the next test's fetch.
    res.setHeader('Connection', 'close')
    if (s.handle) s.handle(req, res, n)
    else {
      res.writeHead(404)
      res.end()
    }
  })
  return s
}
const A = loopbackServer()
const B = loopbackServer()

before(async () => {
  for (const s of [A, B]) {
    await new Promise((resolve) => s.server.listen(0, '127.0.0.1', resolve))
    s.port = s.server.address().port
  }
})
after(async () => {
  for (const s of [A, B]) {
    s.server.closeAllConnections()
    await new Promise((resolve) => s.server.close(resolve))
    assert.equal(s.server.listening, false)
  }
  // Nothing listens on either test port any more.
  for (const s of [A, B]) await assert.rejects(REAL_FETCH(`http://127.0.0.1:${s.port}/`))
})

/**
 * The real fetch, limited to 127.0.0.1: any other host throws, so no test can
 * reach the network. `openrouter` maps https://openrouter.ai to server A.
 */
function loopbackFetch({ openrouter = false } = {}) {
  return (url, init) => {
    let target = String(url)
    if (openrouter) target = target.replace(/^https:\/\/openrouter\.ai(?=\/)/, `http://127.0.0.1:${A.port}`)
    if (new URL(target).hostname !== '127.0.0.1') throw new Error(`test fetch refused a non-loopback URL: ${target}`)
    return REAL_FETCH(target, init)
  }
}

/** The three runtimes against server A: net.js (DeepSeek), kimi.js, openrouter.js. */
const LOOP_RUNTIMES = [
  { name: 'net.js (DeepSeek)', id: 'deepseek', mount: mountDeepSeek, key: 'deepseekUsage', command: 'usage-deepseek', config: () => ({ baseUrl: `http://127.0.0.1:${A.port}/base` }), path: '/base/user/balance' },
  { name: 'kimi.js', id: 'kimi', mount: mountKimi, key: 'kimiUsage', command: 'usage-kimi', config: () => ({ baseUrl: `http://127.0.0.1:${A.port}/base` }), path: '/base/usages' },
  { name: 'openrouter.js', id: 'openrouter', mount: mountOpenRouter, key: 'openrouterUsage', command: 'usage-openrouter', config: () => ({ showAccount: false }), path: '/api/v1/key', openrouter: true },
]

/** Run fn with the loopback fetch installed and both servers reset; always restore. */
async function onLoopback(rt, fn) {
  for (const s of [A, B]) {
    s.requests = []
    s.handle = null
  }
  globalThis.fetch = loopbackFetch({ openrouter: rt.openrouter })
  try {
    return await fn()
  } finally {
    globalThis.fetch = REAL_FETCH
    for (const s of [A, B]) s.handle = null
  }
}

function sendJson(res, body) {
  const text = JSON.stringify(body)
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(text)) })
  res.end(text)
}

/** A JSON body of exactly `bytes` bytes: the provider's good reply plus an ASCII pad. */
function padded(body, bytes) {
  const empty = JSON.stringify({ ...body, pad: '' }).length
  const text = JSON.stringify({ ...body, pad: 'x'.repeat(bytes - empty) })
  assert.equal(Buffer.byteLength(text), bytes)
  return text
}

/** Write `text` as a chunked reply (no Content-Length), 64 KiB at a time. */
function sendChunked(res, text) {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  for (let i = 0; i < text.length; i += 64 * 1024) res.write(text.slice(i, i + 64 * 1024))
  res.end()
}

for (const rt of LOOP_RUNTIMES) {
  test(`loopback ${rt.name}: up to three same-origin redirects are followed with the same headers`, async () => {
    await onLoopback(rt, async () => {
      A.handle = (req, res, n) => {
        if (n < 3) {
          res.writeHead([301, 302, 307][n], { Location: `${rt.path}?hop=${n + 1}` })
          res.end()
        } else sendJson(res, OK[rt.id])
      }
      const h = mountOn(rt, rt.config())
      const state = await h.api.refresh()
      assert.equal(state.status, 'ready', state.detail)
      assert.deepEqual(A.requests.map((r) => r.url), [rt.path, `${rt.path}?hop=1`, `${rt.path}?hop=2`, `${rt.path}?hop=3`])
      for (const r of A.requests) assert.equal(r.authorization, `Bearer ${KEY}`, 'the same-origin hop keeps Authorization')
      if (rt.id === 'kimi') for (const r of A.requests) assert.equal(r.userAgent, 'dsh-plugin-kimi-usage/0.1')
      assert.equal(B.requests.length, 0)
    })
  })

  test(`loopback ${rt.name}: a fourth same-origin redirect is refused`, async () => {
    await onLoopback(rt, async () => {
      A.handle = (req, res, n) => {
        res.writeHead(302, { Location: `${rt.path}?hop=${n + 1}` })
        res.end()
      }
      const state = await mountOn(rt, rt.config()).api.refresh()
      assert.equal(state.status, 'error')
      assert.equal(state.error, 'redirect-refused', state.detail)
      assert.match(state.detail, /More than 3 redirects/)
      assert.equal(A.requests.length, 4, 'the request and three followed redirects')
    })
  })

  test(`loopback ${rt.name}: a redirect to another origin is refused, names only that origin, and the other origin receives nothing`, async () => {
    await onLoopback(rt, async () => {
      A.handle = (req, res, n) => {
        res.writeHead(302, { Location: n === 0 ? `${rt.path}?hop=1` : `http://127.0.0.1:${B.port}/steal?token=abc` })
        res.end()
      }
      B.handle = (req, res) => sendJson(res, OK[rt.id])
      const state = await mountOn(rt, rt.config()).api.refresh()
      assert.equal(state.error, 'redirect-refused', state.detail)
      assert.ok(state.detail.includes(`http://127.0.0.1:${B.port}`), state.detail)
      assert.ok(!state.detail.includes('/steal') && !state.detail.includes('token=abc'), state.detail)
      assert.equal(A.requests.length, 2, 'one same-origin hop, then the refusal')
      assert.equal(B.requests.filter((r) => r.authorization !== null).length, 0, 'Authorization never reaches another origin')
      assert.equal(B.requests.length, 0, 'the other origin receives no request at all')
    })
  })

  test(`loopback ${rt.name}: a chunked reply that grows past 1 MiB is too-large; one of exactly 1 MiB is read`, async () => {
    await onLoopback(rt, async () => {
      A.handle = (req, res) => sendChunked(res, padded(OK[rt.id], MiB + 1))
      const big = await mountOn(rt, rt.config()).api.refresh()
      assert.equal(big.status, 'error')
      assert.equal(big.error, 'too-large', big.detail)
      assert.match(big.detail, /1 MiB/)
      A.handle = (req, res) => sendChunked(res, padded(OK[rt.id], MiB))
      const fits = await mountOn(rt, rt.config()).api.refresh()
      assert.equal(fits.status, 'ready', fits.detail)
    })
  })

  test(`loopback ${rt.name}: a reply whose Content-Length exceeds 1 MiB is too-large`, async () => {
    await onLoopback(rt, async () => {
      A.handle = (req, res) => {
        const text = padded(OK[rt.id], MiB + 100)
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(text.length) })
        res.end(text)
      }
      const state = await mountOn(rt, rt.config()).api.refresh()
      assert.equal(state.error, 'too-large', state.detail)
    })
  })
}

test('loopback requestJson: a Content-Length over 1 MiB is refused before the body is read', async () => {
  await onLoopback(LOOP_RUNTIMES[0], async () => {
    // The body never arrives: only the declared length can end this before the timeout.
    A.handle = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(2 * MiB) })
      res.write('{"pad":"')
    }
    const result = await net.requestJson(`http://127.0.0.1:${A.port}/declared`, { headers: { Authorization: `Bearer ${KEY}` }, timeoutMs: 3000 })
    assert.equal(result.failure, 'too-large', JSON.stringify(result))
    assert.equal(result.status, 200)
    assert.match(result.detail, /1 MiB/)
    A.server.closeAllConnections()
  })
})

test('loopback requestJson: the timeout covers a body that never finishes', async () => {
  await onLoopback(LOOP_RUNTIMES[0], async () => {
    A.handle = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.write('{"partial":')
    }
    const result = await net.requestJson(`http://127.0.0.1:${A.port}/slow`, { headers: { Authorization: `Bearer ${KEY}` }, timeoutMs: 200 })
    assert.deepEqual(result, { failure: 'timeout', status: 200, detail: 'No reply within 200 ms.' })
    A.server.closeAllConnections()
  })
})

test('requestJson: the timeout ends a body read even when the body stream ignores the abort signal', { timeout: 5_000 }, async () => {
  // Headers arrive, then a body stream that neither ends nor errors on abort.
  await withStubs(() => new Response(new ReadableStream({ start() {} }), { status: 200 }), async () => {
    const result = await net.requestJson('https://x.test/stuck', { headers: { Authorization: `Bearer ${KEY}` }, timeoutMs: 50 })
    assert.deepEqual(result, { failure: 'timeout', status: 200, detail: 'No reply within 50 ms.' })
  })
})

// --- redaction: the credential never reaches state, a report, a command or the console ---

/** Every text a provider exposes: the state, the command reply, and every console line. */
function exposed(state, result, logs) {
  return [JSON.stringify(state), JSON.stringify(result), ...logs.map((l) => l.text)].join('\n')
}

test('redaction: an error body that echoes the credential and the Authorization header never reaches state, the report, the command or the console (every provider)', async () => {
  for (const p of ALL) {
    const secret = secretOf(p)
    let failing = false
    const handler = (url, init) => {
      if (!failing) return json(OK[p.id])
      const echo = `Invalid credential ${secret}; you sent Authorization: ${init.headers.Authorization}`
      return json({ error: { message: echo }, message: echo, msg: echo }, 401)
    }
    await withStubs(handler, async ({ logs }) => {
      const h = mountOn(p, p.config)
      const errorFirst = await (async () => {
        failing = true
        const state = await h.api.refresh()
        return { state, result: await h.command.handler({}) }
      })()
      assert.equal(errorFirst.state.error, 'http-401', p.id)
      assert.equal(errorFirst.result.kind, 'error')
      assert.ok(!exposed(errorFirst.state, errorFirst.result, logs).includes(secret), `${p.id}: ${errorFirst.state.detail}`)
      assert.ok(errorFirst.state.detail.includes('[redacted]'), errorFirst.state.detail)
      // A stale report: good data, then the echoing failure in the footer.
      failing = false
      assert.equal((await h.api.refresh()).status, 'ready')
      failing = true
      const report = await h.command.handler({})
      assert.equal(report.kind, 'success')
      assert.match(report.text, /Warning: last refresh failed/)
      assert.ok(report.text.includes('[redacted]'), report.text)
      assert.ok(!exposed(await h.api.snapshot(), report, logs).includes(secret), `${p.id}: ${report.text}`)
    })
  }
})

test('redaction: a 200 reply that echoes the credential in an api-error message is redacted (net.js providers)', async () => {
  const echoes = {
    deepseek: (s) => ({ error: { message: `key ${s} is suspended` } }),
    zhipu: (s) => ({ success: false, msg: `key ${s} is suspended` }),
    minimax: (s) => ({ base_resp: { status_code: 1004, status_msg: `key ${s} is suspended` } }),
    newapi: (s) => ({ code: 401, message: `key ${s} is suspended` }),
  }
  for (const [id, body] of Object.entries(echoes)) {
    const p = ALL.find((x) => x.id === id)
    await withStubs(() => json(body(KEY)), async ({ logs }) => {
      const h = mountOn(p, p.config)
      const state = await h.api.refresh()
      assert.equal(state.error, 'api-error', id)
      assert.equal(state.detail, 'key [redacted] is suspended', id)
      assert.ok(!exposed(state, await h.command.handler({}), logs).includes(KEY), id)
    })
  }
})

test('redaction: a reply that echoes the credential in a data field is redacted before it becomes state or a report (OpenRouter label, Kimi reset time)', async () => {
  const p = ALL.find((x) => x.id === 'openrouter')
  await withStubs(() => json({ data: { label: KEY, usage: 1.5, limit: null, limit_remaining: null } }), async ({ logs }) => {
    const h = mountOn(p, p.config)
    const state = await h.api.refresh()
    assert.equal(state.status, 'ready')
    assert.equal(state.data.label, '[redacted]')
    const report = await h.command.handler({})
    assert.ok(report.text.split('\n').includes('Key: [redacted]'), report.text)
    assert.ok(!exposed(state, report, logs).includes(KEY))
  })
  const k = ALL.find((x) => x.id === 'kimi')
  await withStubs(() => json({ usages: { limit_5h: { used_ratio: 0.1, reset_time: `Bearer ${KEY}` } } }), async ({ logs }) => {
    const h = mountOn(k, k.config)
    const state = await h.api.refresh()
    assert.equal(state.status, 'ready')
    assert.equal(state.data.quotas.fiveHour.resetAt, 'Bearer [redacted]')
    assert.ok(!exposed(state, await h.command.handler({}), logs).includes(KEY))
  })
})

test('redaction: the OpenRouter account call that echoes the key keeps the key data and redacts the account detail', async () => {
  const p = ALL.find((x) => x.id === 'openrouter')
  const handler = (url, init) => (url.endsWith('/key')
    ? json(OK.openrouter)
    : json({ error: { message: `Only management keys; got ${init.headers.Authorization}` } }, 403))
  await withStubs(handler, async ({ logs }) => {
    const h = mountOn(p, { showAccount: true })
    const state = await h.api.refresh()
    assert.equal(state.status, 'ready')
    assert.equal(state.account.error, 'management-key-required')
    assert.equal(state.account.detail, 'Only management keys; got Bearer [redacted]')
    assert.ok(!exposed(state, await h.command.handler({}), logs).includes(KEY))
  })
})

test('redaction: a network error whose message quotes the credential is redacted (every runtime)', async () => {
  for (const p of ALL.filter((x) => ['deepseek', 'kimi', 'openrouter'].includes(x.id))) {
    await withStubs((url, init) => { throw new TypeError(`connect ECONNREFUSED (sent ${init.headers.Authorization})`) }, async ({ logs }) => {
      const h = mountOn(p, p.config)
      const state = await h.api.refresh()
      assert.equal(state.error, 'network', p.id)
      assert.equal(state.detail, 'connect ECONNREFUSED (sent Bearer [redacted])', p.id)
      assert.ok(!exposed(state, await h.command.handler({}), logs).includes(KEY), p.id)
    })
  }
})

test('redaction: the raw GLM key and the URL-encoded form of a key are redacted too', async () => {
  const odd = 'sk-test/SECRET+0123=abcdef'
  const p = ALL.find((x) => x.id === 'zhipu')
  await withStubs((url, init) => json({ msg: `raw ${init.headers.Authorization} or encoded ${encodeURIComponent(odd)}` }, 401), async ({ calls, logs }) => {
    const h = mountOn(p, p.config, { key: odd })
    const state = await h.api.refresh()
    assert.equal(calls[0].init.headers.Authorization, odd, 'GLM sends the raw key')
    assert.ok(!exposed(state, await h.command.handler({}), logs).includes(odd), state.detail)
    assert.ok(!state.detail.includes(encodeURIComponent(odd)), state.detail)
    assert.match(state.detail, /^HTTP 401: raw \[redacted\] or encoded \[redacted\] Check the GLM Coding Plan key/)
  })
})

test('redaction: a Bearer token the server quotes is redacted even when it is not the configured credential', async () => {
  const p = ALL.find((x) => x.id === 'deepseek')
  const other = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl'
  await withStubs(() => json({ error: { message: `token Bearer ${other} expired` } }, 401), async () => {
    const state = await mountOn(p, p.config).api.refresh()
    assert.equal(state.detail, 'HTTP 401: token Bearer [redacted] expired')
  })
})

test('detail is one line of at most 300 characters, and the Kimi and GLM 401 hints survive a long message (every runtime)', async () => {
  const long = `first line\nsecond line\r\n\tthird ${'x'.repeat(5000)}`
  for (const p of ALL.filter((x) => ['deepseek', 'zhipu', 'kimi', 'openrouter'].includes(x.id))) {
    await withStubs(() => json({ error: { message: long }, msg: long }, 401), async () => {
      const state = await mountOn(p, p.config).api.refresh()
      assert.equal(state.error, 'http-401', p.id)
      assert.ok(!/[\r\n\t]/.test(state.detail), `${p.id}: one line`)
      assert.ok(state.detail.length <= 300, `${p.id}: ${state.detail.length} characters`)
      assert.match(state.detail, /first line second line third x/, p.id)
      if (p.id === 'kimi') assert.match(state.detail, /create the key in the Kimi Code Console \(kimi\.com\/code\/console\)\.$/)
      if (p.id === 'zhipu') assert.match(state.detail, /this API takes the raw key, no Bearer prefix\.$/)
    })
  }
})

test('detail cap: a 200 api-error and an unexpected throw are one line of at most 300 characters too', async () => {
  const p = ALL.find((x) => x.id === 'newapi')
  await withStubs(() => json({ code: 500, message: `a\nb ${'y'.repeat(900)}` }), async () => {
    const state = await mountOn(p, p.config).api.refresh()
    assert.equal(state.error, 'api-error')
    assert.ok(!state.detail.includes('\n') && state.detail.length <= 300, state.detail)
  })
  let api
  net.mountProvider({ provide(k, v) { api = v }, commands: { register() {} }, effect() {} }, {
    id: 'probe', title: 'Probe', serviceKey: 'probeUsage', commandName: 'usage-probe', commandDescription: 'x', formatReport: () => '',
    fetchState: async () => { throw new Error(`boom\n${'z'.repeat(900)}`) },
  }, {})
  const state = await api.refresh()
  assert.equal(state.error, 'unexpected')
  assert.ok(!state.detail.includes('\n') && state.detail.length <= 300, state.detail)
})
