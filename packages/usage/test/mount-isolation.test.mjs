import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../src/index.host.js'
import { mountProviderLogin } from '../src/providers/login.js'
import { mountAnthropic } from '../src/providers/anthropic.js'
import { mountCodex } from '../src/providers/codex.js'
import { mountDeepSeek } from '../src/providers/deepseek.js'
import { mountKimi } from '../src/providers/kimi.js'
import { mountMiniMax } from '../src/providers/minimax.js'
import { mountNewApi } from '../src/providers/newapi.js'
import { mountOpenRouter } from '../src/providers/openrouter.js'
import { mountZhipu } from '../src/providers/zhipu.js'

// Mount isolation on the Host. A duplicate command or service must not break
// apply() and must not leave a half-mounted provider. UNVERIFIED host fact:
// whether ctx.commands.register throws on a duplicate name or silently
// replaces the entry. Both are simulated here: `failRegister` throws, and the
// "replaces silently" test registers without throwing.

const PROVIDERS = [
  { id: 'openrouter', mount: mountOpenRouter, key: 'openrouterUsage', command: 'usage-openrouter', config: {} },
  { id: 'kimi', mount: mountKimi, key: 'kimiUsage', command: 'usage-kimi', config: {} },
  { id: 'deepseek', mount: mountDeepSeek, key: 'deepseekUsage', command: 'usage-deepseek', config: {} },
  { id: 'zhipu', mount: mountZhipu, key: 'zhipuUsage', command: 'usage-zhipu', config: {} },
  { id: 'minimax', mount: mountMiniMax, key: 'minimaxUsage', command: 'usage-minimax', config: {} },
  { id: 'newapi', mount: mountNewApi, key: 'newapiUsage', command: 'usage-newapi', config: { baseUrl: 'https://relay.test' } },
  { id: 'codex', mount: mountCodex, key: 'codexUsage', command: 'usage-codex', config: {} },
  { id: 'anthropic', mount: mountAnthropic, key: 'anthropicUsage', command: 'usage-anthropic', config: {} },
]
/** Runtimes: net.js (via DeepSeek), openrouter.js, kimi.js. */
const RUNTIMES = PROVIDERS.filter((p) => ['deepseek', 'openrouter', 'kimi'].includes(p.id))

/**
 * A fake ctx that records what is mounted. `failProvide` names service keys
 * whose provide throws (the login Service goes through ctx.reflect.provide);
 * `failRegister` names commands whose register throws.
 */
function fakeCtx({ failProvide = [], failRegister = [] } = {}) {
  const m = { services: new Map(), commands: new Map(), effects: [] }
  const ctx = {
    credentials: { resolve: async () => undefined, readRecord: async () => undefined },
    provide(key, value) {
      if (failProvide.includes(key)) throw new Error(`duplicate service ${key}`)
      m.services.set(key, value)
    },
    reflect: {
      provide(key, value) {
        if (failProvide.includes(key)) throw new Error(`duplicate service ${key}`)
        m.services.set(key, value)
      },
    },
    commands: {
      register(definition) {
        if (failRegister.includes(definition.name)) throw new Error(`duplicate command ${definition.name}`)
        m.commands.set(definition.name, definition)
      },
    },
    effect(fn, label) { m.effects.push({ fn, label }) },
  }
  return { ctx, m }
}

/** Run fn with console.error captured; returns the captured lines (first argument as text). */
function captureErrors(fn) {
  const real = console.error
  const lines = []
  console.error = (...args) => { lines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')) }
  try {
    fn()
  } finally {
    console.error = real
  }
  return lines
}

/** NewAPI has no default base URL and mounts only when one is configured. */
const APPLY_CONFIG = { providers: { newapi: { baseUrl: 'https://relay.test' } } }

const USAGE_KEYS = PROVIDERS.map((p) => p.key)
const USAGE_COMMANDS = PROVIDERS.map((p) => p.command)

test('apply: a duplicate provider-login command does not throw; eight providers and the sign-in service stay mounted', () => {
  const { ctx, m } = fakeCtx({ failRegister: ['provider-login'] })
  const errors = captureErrors(() => assert.doesNotThrow(() => apply(ctx, APPLY_CONFIG)))
  for (const key of USAGE_KEYS) assert.ok(m.services.has(key), `${key} is provided`)
  for (const name of USAGE_COMMANDS) assert.ok(m.commands.has(name), `${name} is registered`)
  assert.equal(m.effects.length, 8, 'eight poll effects')
  assert.ok(m.services.has('providerLogin'), 'the sign-in service stays usable by the card')
  assert.equal(errors.length, 1, `one console.error: ${errors.join(' | ')}`)
  assert.match(errors[0], /provider-login/)
})

test('apply: a duplicate providerLogin service does not throw; the command stays registered', () => {
  const { ctx, m } = fakeCtx({ failProvide: ['providerLogin'] })
  const errors = captureErrors(() => assert.doesNotThrow(() => apply(ctx, APPLY_CONFIG)))
  for (const key of USAGE_KEYS) assert.ok(m.services.has(key), `${key} is provided`)
  for (const name of USAGE_COMMANDS) assert.ok(m.commands.has(name), `${name} is registered`)
  assert.equal(m.effects.length, 8)
  assert.ok(m.commands.has('provider-login'), 'the sign-in command is registered')
  assert.equal(errors.length, 1, `one console.error: ${errors.join(' | ')}`)
  assert.match(errors[0], /providerLogin/)
})

test('apply: both sign-in surfaces failing still does not throw; each failure is logged once', () => {
  const { ctx, m } = fakeCtx({ failProvide: ['providerLogin'], failRegister: ['provider-login'] })
  const errors = captureErrors(() => assert.doesNotThrow(() => apply(ctx, APPLY_CONFIG)))
  assert.equal(errors.length, 2, errors.join(' | '))
  assert.match(errors.join('\n'), /providerLogin/)
  assert.match(errors.join('\n'), /provider-login/)
  assert.equal(m.effects.length, 8)
})

test('apply: a host whose commands.register replaces a duplicate silently mounts everything with no error', () => {
  const { ctx, m } = fakeCtx()
  ctx.commands.register = (definition) => { m.commands.set(definition.name, definition) }
  m.commands.set('provider-login', { name: 'provider-login', stale: true })
  const errors = captureErrors(() => assert.doesNotThrow(() => apply(ctx, APPLY_CONFIG)))
  assert.deepEqual(errors, [])
  assert.notEqual(m.commands.get('provider-login').stale, true, 'replaced by this plugin')
  assert.ok(m.services.has('providerLogin'))
})

test('mountProviderLogin: a duplicate command leaves the service usable by the card', async () => {
  const { ctx, m } = fakeCtx({ failRegister: ['provider-login'] })
  ctx.credentials.readRecord = async (key) => (key === 'llm-pi-ai/anthropic' ? { kind: 'grant' } : undefined)
  const errors = captureErrors(() => assert.doesNotThrow(() => mountProviderLogin(ctx)))
  assert.equal(m.commands.has('provider-login'), false)
  const service = m.services.get('providerLogin')
  assert.ok(service, 'the service is provided')
  assert.deepEqual(await service.status({ provider: 'anthropic' }), { configured: true })
  assert.deepEqual(await service.status({ provider: 'openai-codex' }), { configured: false })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /provider-login/)
})

test('mountProviderLogin: a duplicate service leaves the command registered and working', async () => {
  const { ctx, m } = fakeCtx({ failProvide: ['providerLogin'] })
  const errors = captureErrors(() => assert.doesNotThrow(() => mountProviderLogin(ctx)))
  assert.equal(m.services.has('providerLogin'), false)
  const command = m.commands.get('provider-login')
  assert.ok(command, 'the command is registered')
  const result = await command.handler({ agent: {}, rawInput: 'Bad Name', signal: undefined })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Usage: \/provider-login/)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /providerLogin/)
})

for (const p of PROVIDERS) {
  test(`${p.id}: when provide throws, no command and no poll effect are registered`, () => {
    const { ctx, m } = fakeCtx({ failProvide: [p.key] })
    assert.throws(() => p.mount(ctx, p.config), /duplicate service/)
    assert.equal(m.commands.size, 0, 'no command')
    assert.equal(m.effects.length, 0, 'no poll effect')
    assert.equal(m.services.size, 0)
  })

  test(`${p.id}: when commands.register throws, it is logged once and the service and the poll stay mounted`, () => {
    const { ctx, m } = fakeCtx({ failRegister: [p.command] })
    const errors = captureErrors(() => assert.doesNotThrow(() => p.mount(ctx, p.config)))
    assert.ok(m.services.has(p.key), 'service stays provided')
    assert.equal(m.effects.length, 1, 'the poll effect is registered, so the card leaves idle')
    assert.equal(typeof m.effects[0].fn, 'function')
    assert.equal(m.commands.size, 0)
    assert.equal(errors.length, 1, errors.join(' | '))
    assert.match(errors[0], new RegExp(p.command))
  })

  test(`${p.id}: with no failure it mounts the service, the command and one poll effect, silently`, () => {
    const { ctx, m } = fakeCtx()
    const errors = captureErrors(() => p.mount(ctx, p.config))
    assert.ok(m.services.has(p.key))
    assert.ok(m.commands.has(p.command))
    assert.equal(m.effects.length, 1)
    assert.deepEqual(errors, [])
  })
}

for (const p of RUNTIMES) {
  test(`${p.id} runtime: the poll effect of a half-failed mount really refreshes the card off idle`, async () => {
    const { ctx, m } = fakeCtx({ failRegister: [p.command] })
    captureErrors(() => p.mount(ctx, p.config))
    const api = m.services.get(p.key)
    assert.equal((await api.snapshot()).status, 'idle')
    // The effect is the poll: run it, and the first tick fires a refresh.
    const realFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('{}', { status: 500 })
    const dispose = m.effects[0].fn()
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_200))
    } finally {
      dispose()
      globalThis.fetch = realFetch
    }
    const after = (await api.snapshot()).status
    assert.notEqual(after, 'idle', `status after poll: ${after}`)
  })
}

for (const failing of PROVIDERS) {
  test(`apply: a throw while mounting ${failing.id} leaves the other seven mounted and is logged once`, () => {
    const { ctx, m } = fakeCtx({ failProvide: [failing.key] })
    const errors = captureErrors(() => assert.doesNotThrow(() => apply(ctx, APPLY_CONFIG)))
    for (const p of PROVIDERS.filter((q) => q.id !== failing.id)) {
      assert.ok(m.services.has(p.key), `${p.id} service`)
      assert.ok(m.commands.has(p.command), `${p.id} command`)
    }
    assert.equal(m.services.has(failing.key), false)
    assert.equal(m.commands.has(failing.command), false)
    assert.equal(m.effects.length, 7, 'seven poll effects')
    assert.ok(m.services.has('providerLogin') && m.commands.has('provider-login'), 'sign-in mounted')
    assert.equal(errors.length, 1, errors.join(' | '))
    assert.match(errors[0], new RegExp(`"${failing.id}"`))
  })
}

test('apply: a duplicate usage command is logged once, names its provider, and leaves all eight polls mounted', () => {
  const { ctx, m } = fakeCtx({ failRegister: ['usage-deepseek'] })
  const errors = captureErrors(() => assert.doesNotThrow(() => apply(ctx, APPLY_CONFIG)))
  assert.equal(m.effects.length, 8)
  for (const key of USAGE_KEYS) assert.ok(m.services.has(key))
  assert.equal(errors.length, 1, errors.join(' | '))
  assert.match(errors[0], /usage-deepseek/)
})
