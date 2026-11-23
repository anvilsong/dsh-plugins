import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { apply } from '../src/index.host.js'

const ORIGINAL_CLEAR_INTERVAL = globalThis.clearInterval
after(() => { globalThis.clearInterval = ORIGINAL_CLEAR_INTERVAL })

const upstream = {
  'gpt-6.2-astra': {
    id: 'gpt-6.2-astra', name: 'GPT-6.2 Astra', api: 'openai-codex-responses', provider: 'openai-codex',
    baseUrl: 'https://chatgpt.com/backend-api', reasoning: true, input: ['text', 'image'],
    cost: {}, contextWindow: 272000, maxTokens: 128000,
    thinkingLevelMap: { low: 'low', high: 'high', xhigh: 'xhigh', max: 'max' }, type: 'chat',
    compat: { supportsMidConvoSystemMessages: true },
  },
  'gpt-6.1-terra': {
    id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', api: 'openai-codex-responses', provider: 'openai-codex',
    baseUrl: 'https://chatgpt.com/backend-api', reasoning: true, input: ['text', 'image'],
    cost: {}, contextWindow: 500000, maxTokens: 128000,
    thinkingLevelMap: { off: 'none', low: 'low', high: 'high', xhigh: 'xhigh', max: 'max' }, type: 'chat',
  },
}

function harness({ enabled = true, config = {}, current, editorError, getJsonError } = {}) {
  const commands = []
  const cleanups = []
  const intervals = []
  const edits = []
  const warnings = []
  let editorErrorValue = editorError
  let beforeChange
  const state = {
    config: current ?? {
      keep: true,
      providers: {
        'openai-codex': { credentialRef: 'KEY', models: [{ id: 'gpt-6-astra', name: 'my custom entry' }] },
        other: { enabled: true },
      },
    },
  }
  const entry = {
    options: { name: '@deepseek-ai/dsh-llm-pi-ai', config: state.config },
    fiber: { state: 2 },
  }
  const editor = {
    entries: () => [entry],
    async edit(receivedEntry, change) {
      assert.equal(receivedEntry, entry)
      if (editorErrorValue !== undefined) throw new Error(editorErrorValue)
      beforeChange?.()
      const next = change(state.config, {})
      edits.push(next)
      state.config = next
      entry.options.config = next
    },
  }
  const ctx = {
    logger: { warn: (line) => warnings.push(line), error: (line) => warnings.push(line) },
    get: (name) => name === 'configEditor' ? editor : undefined,
    inject(names, callback) {
      if (names.includes('commands')) callback({ commands: { register: (command) => commands.push(command) } })
      if (names.includes('configEditor')) callback({ ...editor, effect: ctx.effect })
    },
    effect: (fn) => { cleanups.push(fn()) },
  }
  const calls = []
  let getJsonImpl = getJsonError ?? (async (url) => {
    calls.push(url)
    if (url.endsWith('/latest')) return { version: '1.6.0' }
    if (url.includes('/dist/providers/data/openai-codex.json')) return { 'openai-codex-responses': upstream }
    throw new Error(`unexpected URL ${url}`)
  })
  const getJson = (...args) => getJsonImpl(...args)
  const setInterval = (fn, ms) => {
    const timer = { fn, ms, cleared: false }
    intervals.push(timer)
    return timer
  }
  const clearInterval = (timer) => { timer.cleared = true }
  const originalSetInterval = globalThis.setInterval
  globalThis.setInterval = setInterval
  globalThis.clearInterval = clearInterval
  return {
    ctx, commands, cleanups, intervals, edits, warnings, calls, state, getJson, editor,
    setEditorError: (value) => { editorErrorValue = value },
    setGetJson: (fn) => { getJsonImpl = fn },
    setBeforeChange: (fn) => { beforeChange = fn },
    async start() {
      try {
        await apply(ctx, { enabled, ...config }, { getJson, now: () => 1000 })
      } finally {
        globalThis.setInterval = originalSetInterval
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('sync adds only missing models, preserves existing config, and is idempotent', async () => {
  const h = harness()
  await h.start()
  const provider = h.state.config.providers['openai-codex']
  assert.equal(provider.credentialRef, 'KEY')
  assert.deepEqual(provider.models[0], { id: 'gpt-6-astra', name: 'my custom entry' })
  assert.deepEqual(provider.models.slice(1).map((model) => model.id).sort(), ['gpt-6.1-terra', 'gpt-6.2-astra'])
  assert.equal(h.state.config.keep, true)
  assert.deepEqual(h.state.config.providers.other, { enabled: true })
  assert.equal(provider.models[1].compat, undefined)
  assert.equal(h.edits.length, 1)
  const result = await h.commands[0].handler({ rawInput: 'sync' })
  assert.match(result.text, /Added: nothing new/)
  assert.equal(h.edits.length, 1, 'a second sync does not rewrite identical entries')
})

test('a newer package version adds newly discovered models without replacing old ones', async () => {
  const h = harness()
  await h.start()
  h.setGetJson(async (url) => {
    if (url.endsWith('/latest')) return { version: '1.7.0' }
    return { 'openai-codex-responses': { ...upstream, 'gpt-6.3-test': { ...upstream['gpt-6.2-astra'], id: 'gpt-6.3-test', name: 'GPT-6.3 Test' } } }
  })
  const result = await h.commands[0].handler({ rawInput: 'sync' })
  assert.match(result.text, /gpt-6.3-test/)
  assert.equal(h.state.config.providers['openai-codex'].models.length, 4)
})

test('a fetch failure is reported, does not throw, and a manual sync retries', async () => {
  let failed = true
  const h = harness({
    getJsonError: async (url) => {
      if (failed) throw new Error('HTTP 503')
      if (url.endsWith('/latest')) return { version: '1.6.0' }
      return { 'openai-codex-responses': upstream }
    },
  })
  await h.start()
  const status = await h.commands[0].handler({ rawInput: 'status' })
  assert.match(status.text, /HTTP 503/)
  failed = false
  const result = await h.commands[0].handler({ rawInput: 'sync' })
  assert.match(result.text, /gpt-6.2-astra/)
  assert.equal(h.state.config.providers['openai-codex'].models.length, 3)
})

test('a missing config editor is an explicit sync error, not a crash', async () => {
  const h = harness()
  await h.start()
  h.ctx.get = () => undefined
  const result = await h.commands[0].handler({ rawInput: 'sync' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /configEditor is unavailable/)
})

test('a model added by another writer between precheck and edit is preserved', async () => {
  const h = harness()
  await h.start()
  h.setGetJson(async (url) => {
    if (url.endsWith('/latest')) return { version: '1.7.0' }
    return { 'openai-codex-responses': { ...upstream, 'gpt-6.3-test': { ...upstream['gpt-6.2-astra'], id: 'gpt-6.3-test', name: 'GPT-6.3 Test' } } }
  })
  h.setBeforeChange(() => {
    h.state.config.providers['openai-codex'].models.push({ id: 'external-writer', name: 'added by another writer' })
  })
  const result = await h.commands[0].handler({ rawInput: 'sync' })
  const models = h.state.config.providers['openai-codex'].models
  assert.equal(models.some((model) => model.id === 'external-writer'), true)
  assert.equal(models.some((model) => model.id === 'gpt-6.3-test'), true)
  assert.match(result.text, /gpt-6.3-test/)
})

test('an editor rejection is not reported as an addition and is retried', async () => {
  const h = harness({ editorError: 'overridden by a home patch' })
  await h.start()
  assert.equal(h.state.config.providers['openai-codex'].models.length, 1)
  const status = await h.commands[0].handler({ rawInput: 'status' })
  assert.doesNotMatch(status.text, /Added in the last sync/)
  h.setEditorError(undefined)
  const result = await h.commands[0].handler({ rawInput: 'sync' })
  assert.match(result.text, /gpt-6.2-astra/)
})

test('an invalid existing models field blocks that provider only', async () => {
  const h = harness({ current: { providers: { 'openai-codex': { models: {} } } } })
  await h.start()
  assert.match(h.warnings.join('\n'), /not an array/)
  assert.equal(h.state.config.providers['openai-codex'].models.length, undefined)
})

test('disabled discovery does no scheduled work but still allows a manual sync', async () => {
  const h = harness({ enabled: false })
  await h.start()
  assert.equal(h.calls.length, 0)
  assert.equal(h.intervals.length, 0)
  const result = await h.commands[0].handler({ rawInput: 'sync' })
  assert.match(result.text, /gpt-6.2-astra/)
})

test('an invalid metadata version is reported', async () => {
  const h = harness({ getJsonError: async () => ({ version: 'next' }) })
  await h.start()
  const result = await h.commands[0].handler({ rawInput: 'status' })
  assert.match(result.text, /no valid version/)
})

test('concurrent syncs do not duplicate entries', async () => {
  let release
  const h = harness({
    getJsonError: async (url) => {
      if (url.endsWith('/latest')) return new Promise((resolve) => { release = () => resolve({ version: '1.6.0' }) })
      return { 'openai-codex-responses': upstream }
    },
  })
  await h.start()
  const first = h.commands[0].handler({ rawInput: 'sync' })
  const second = await h.commands[0].handler({ rawInput: 'sync' })
  assert.equal(second.kind, 'error')
  assert.match(second.text, /already syncing/)
  release()
  await first
  await flush()
  assert.equal(h.state.config.providers['openai-codex'].models.length, 3)
})

test('status includes the last result, and unknown arguments return usage', async () => {
  const h = harness()
  await h.start()
  const status = await h.commands[0].handler({ rawInput: 'status' })
  assert.match(status.text, /1.6.0/)
  assert.match(status.text, /Next automatic check/)
  const usage = await h.commands[0].handler({ rawInput: 'on' })
  assert.equal(usage.kind, 'error')
  assert.match(usage.text, /Usage:/)
})

test('automatic sync leaves the HMR activation transaction before editing', async () => {
  const h = harness()
  let exits = 0
  h.ctx.get = (name) => {
    if (name === 'configEditor') return h.editor
    if (name === 'hmr') return { executing: { exit: (fn) => { exits += 1; return fn() } } }
    return undefined
  }
  await h.start()
  assert.ok(exits > 0)
  assert.equal(h.state.config.providers['openai-codex'].models.length, 3)
})

test('the scheduled timer is disposed on unload', async () => {
  const h = harness()
  await h.start()
  assert.equal(h.intervals.length, 1)
  assert.equal(h.intervals[0].ms, 21600000)
  h.cleanups.forEach((cleanup) => cleanup())
  assert.equal(h.intervals[0].cleared, true)
})

test('an invalid config logs an error and does not start a timer', async () => {
  const h = harness({ config: { refreshMs: 1 } })
  await h.start()
  assert.equal(h.intervals.length, 0)
  assert.match(h.warnings.join('\n'), /refreshMs/)
  const result = await h.commands[0].handler({ rawInput: 'sync' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /disabled by its config/)
})
