import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { apply, pickLlmEntry } from '../src/index.host.js'

const ORIGINAL_CLEAR_INTERVAL = globalThis.clearInterval
after(() => { globalThis.clearInterval = ORIGINAL_CLEAR_INTERVAL })

const LLM = '@deepseek-ai/dsh-llm-pi-ai'
const SETTINGS = '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
const GROUP = 'openai-codex-responses'
const model = (id, extra = {}) => ({
  id, name: id.toUpperCase(), api: GROUP, provider: 'openai-codex',
  baseUrl: 'https://chatgpt.com/backend-api', reasoning: true, input: ['text', 'image'],
  cost: {}, contextWindow: 272000, maxTokens: 128000,
  thinkingLevelMap: { xhigh: 'xhigh', minimal: 'low' }, type: 'chat',
  compat: { supportsMidConvoSystemMessages: true }, ...extra,
})
const catalog = (...ids) => ({ [GROUP]: Object.fromEntries(ids.map((id) => [`chat:${id}`, model(id)])) })

function defaultConfig() {
  return {
    keep: true,
    providers: {
      'openai-codex': { apiKeyEnv: 'KEY', models: [{ id: 'gpt-6-astra', name: 'my custom entry' }] },
      other: { enabled: true },
    },
  }
}

function harness({ enabled = true, config = {}, current, llmRows, allowed, getJsonError, statusFile, settingsRow = true } = {}) {
  const commands = []
  const cleanups = []
  const intervals = []
  const edits = []
  const warnings = []
  const failures = new Map()
  const beforeChange = new Map()
  const rows = (llmRows ?? [{ id: 'llm-pi-ai', config: current ?? defaultConfig() }]).map((row) => ({
    options: { id: row.id, name: LLM, config: row.config },
    fiber: { state: 2 },
  }))
  const settingsEntry = {
    options: {
      id: 'subagent-model-selection-settings',
      name: SETTINGS,
      config: {
        enabled: true,
        allowedModels: allowed ?? [
          { provider: 'openai-codex', model: 'gpt-6-astra' },
          { provider: 'anthropic', model: 'claude-sonnet-5-5' },
        ],
      },
    },
    fiber: { state: 2 },
  }
  const all = () => [...rows, ...(settingsRow ? [settingsEntry] : [])]
  const editor = {
    entries: () => all(),
    async edit(receivedEntry, change) {
      assert.ok(all().includes(receivedEntry))
      const kind = receivedEntry === settingsEntry ? 'settings' : 'llm'
      const failure = failures.get(kind)
      if (failure !== undefined) {
        if (failure.once) failures.delete(kind)
        throw new Error(failure.message)
      }
      beforeChange.get(kind)?.(receivedEntry)
      const next = change(structuredClone(receivedEntry.options.config), {})
      edits.push({ kind, next })
      receivedEntry.options.config = next
    },
  }
  const ctx = {
    logger: { warn: (line) => warnings.push(line), error: (line) => warnings.push(line) },
    get: (name) => (name === 'configEditor' ? editor : undefined),
    inject(names, callback) {
      if (names.includes('commands')) callback({ commands: { register: (command) => commands.push(command) } })
      if (names.includes('configEditor')) callback({ ...editor, effect: ctx.effect })
    },
    effect: (fn) => { cleanups.push(fn()) },
  }
  const calls = []
  let version = '1.6.0'
  let ids = ['gpt-6.2-astra', 'gpt-6.1-terra']
  let getJsonImpl = getJsonError ?? (async (url) => {
    calls.push(url)
    if (url.endsWith('/latest')) return { version }
    if (url.includes('/dist/providers/data/openai-codex.json')) return catalog(...ids)
    throw new Error(`unexpected URL ${url}`)
  })
  const getJson = (...args) => getJsonImpl(...args)
  let clock = 1000
  const setInterval = (fn, ms) => {
    const timer = { fn, ms, cleared: false, unref() {} }
    intervals.push(timer)
    return timer
  }
  const clearInterval = (timer) => { timer.cleared = true }
  const originalSetInterval = globalThis.setInterval
  globalThis.setInterval = setInterval
  globalThis.clearInterval = clearInterval
  const h = {
    ctx, commands, cleanups, intervals, edits, warnings, calls, rows, settingsEntry, editor,
    get llm() { return rows[0].options.config },
    get allowed() { return settingsEntry.options.config.allowedModels },
    setClock: (value) => { clock = value },
    failEdit: (kind, message, once = false) => { failures.set(kind, { message, once }) },
    clearFailure: (kind) => failures.delete(kind),
    setBeforeChange: (kind, fn) => beforeChange.set(kind, fn),
    setUpstream: (nextVersion, nextIds) => { version = nextVersion; ids = nextIds },
    setGetJson: (fn) => { getJsonImpl = fn },
    run: (input) => commands[0].handler({ rawInput: input }),
    async start() {
      try {
        await apply(ctx, { enabled, ...config }, { getJson, now: () => clock, ...(statusFile === undefined ? {} : { statusFile }) })
      } finally {
        globalThis.setInterval = originalSetInterval
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setImmediate(resolve))
    },
  }
  return h
}

const ids = (h) => h.llm.providers['openai-codex'].models.map((entry) => entry.id)

test('sync appends only missing models, preserves existing config, and does not rewrite an unchanged config', async () => {
  const h = harness()
  await h.start()
  const provider = h.llm.providers['openai-codex']
  assert.equal(provider.apiKeyEnv, 'KEY')
  assert.deepEqual(provider.models[0], { id: 'gpt-6-astra', name: 'my custom entry' })
  assert.deepEqual(ids(h), ['gpt-6-astra', 'gpt-6.2-astra', 'gpt-6.1-terra'])
  assert.equal(h.llm.keep, true)
  assert.deepEqual(h.llm.providers.other, { enabled: true })
  assert.equal(provider.models[1].compat, undefined)
  assert.deepEqual(provider.models[1].reasoningEfforts,
    { off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' })
  assert.equal(h.edits.length, 1, 'one catalog edit; subagent routes are opt-in')
  const result = await h.run('sync')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Models added: none/)
  assert.equal(h.edits.length, 1, 'a second sync writes nothing')
})

test('a newer package version adds newly discovered models without replacing old ones', async () => {
  const h = harness()
  await h.start()
  h.setUpstream('1.7.0', ['gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6.3-test'])
  const result = await h.run('sync')
  assert.match(result.text, /Models added: openai-codex\/gpt-6.3-test\./)
  assert.deepEqual(ids(h), ['gpt-6-astra', 'gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6.3-test'])
})

test('a provider that serves pi-ai\'s installed catalog is never converted', async () => {
  for (const current of [
    { providers: { 'openai-codex': { apiKeyEnv: 'KEY' } } },
    { providers: { 'openai-codex': { models: [] } } },
  ]) {
    const h = harness({ current })
    await h.start()
    assert.equal(h.edits.length, 0)
    assert.deepEqual(h.llm, current)
    const status = await h.run('status')
    assert.match(status.text, /serves pi-ai's installed catalog; list its models explicitly first/)
    assert.equal((await h.run('sync')).kind, 'error')
    assert.equal(h.edits.length, 0)
  }
})

test('a missing provider is never created and a malformed providers value is never replaced', async () => {
  for (const [current, pattern] of [
    [{}, /openai-codex is not configured/],
    [{ providers: { other: { models: [{ id: 'x' }] } } }, /openai-codex is not configured/],
    [{ providers: [{ provider: 'openai-codex' }] }, /providers setting is not an object/],
  ]) {
    const h = harness({ current })
    await h.start()
    assert.equal(h.edits.length, 0)
    assert.deepEqual(h.llm, current)
    assert.match(h.warnings.join('\n'), pattern)
  }
})

test('an invalid existing models field blocks that provider only', async () => {
  const h = harness({ current: { providers: { 'openai-codex': { models: {} } } } })
  await h.start()
  assert.match(h.warnings.join('\n'), /not an array/)
  assert.deepEqual(h.llm.providers['openai-codex'].models, {})
})

test('a model added by another writer between precheck and edit is preserved', async () => {
  const h = harness()
  await h.start()
  h.setUpstream('1.7.0', ['gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6.3-test'])
  h.setBeforeChange('llm', (entry) => {
    entry.options.config.providers['openai-codex'].models.push({ id: 'external-writer', name: 'added by another writer' })
  })
  const result = await h.run('sync')
  assert.deepEqual(ids(h), ['gpt-6-astra', 'gpt-6.2-astra', 'gpt-6.1-terra', 'external-writer', 'gpt-6.3-test'])
  assert.match(result.text, /gpt-6.3-test/)
})

test('when another writer already added everything, the edit is abandoned and nothing is written', async () => {
  const h = harness()
  await h.start()
  h.setUpstream('1.7.0', ['gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6.3-test'])
  h.setBeforeChange('llm', (entry) => {
    entry.options.config.providers['openai-codex'].models.push({ id: 'gpt-6.3-test' })
  })
  const before = h.edits.length
  const result = await h.run('sync')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Models added: none/)
  assert.equal(h.edits.length, before)
})

test('a fetch failure is reported as an error, does not throw, and a manual sync retries', async () => {
  let failed = true
  const h = harness({
    getJsonError: async (url) => {
      if (failed) throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') })
      if (url.endsWith('/latest')) return { version: '1.6.0' }
      return catalog('gpt-6.2-astra')
    },
  })
  await h.start()
  const status = await h.run('status')
  assert.match(status.text, /fetch failed \(unexpected redirect\)/)
  failed = false
  const result = await h.run('sync')
  assert.match(result.text, /gpt-6.2-astra/)
  assert.equal(ids(h).length, 2)
})

test('a missing config editor is an explicit sync error, not a crash', async () => {
  const h = harness()
  await h.start()
  h.ctx.get = () => undefined
  const result = await h.run('sync')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /configEditor is unavailable/)
})

test('an editor rejection is not reported as an addition and is retried', async () => {
  const h = harness()
  h.failEdit('llm', 'Configuration for "llm-pi-ai" is overridden by a home patch or command-line overlay')
  await h.start()
  assert.deepEqual(ids(h), ['gpt-6-astra'])
  const status = await h.run('status')
  assert.match(status.text, /Models added: none/)
  assert.match(status.text, /overridden by a home patch/)
  h.clearFailure('llm')
  const result = await h.run('sync')
  assert.match(result.text, /gpt-6.2-astra/)
})

test('any error makes a manual sync report kind error, even when another provider added models', async () => {
  const h = harness({ config: { providers: ['openai-codex', 'anthropic'] } })
  await h.start()
  h.setUpstream('1.7.0', ['gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6.3-test'])
  const result = await h.run('sync')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Models added: openai-codex\/gpt-6.3-test/)
  assert.match(result.text, /anthropic: unexpected URL/)
})

test('disabled discovery does no scheduled work, shows no next check, but still allows a manual sync', async () => {
  const h = harness({ enabled: false })
  await h.start()
  assert.equal(h.calls.length, 0)
  assert.equal(h.intervals.length, 0)
  const result = await h.run('sync')
  assert.match(result.text, /gpt-6.2-astra/)
  const status = await h.run('status')
  assert.doesNotMatch(status.text, /Next automatic check/)
  assert.match(status.text, /Automatic checks are off/)
})

test('an invalid metadata version is reported', async () => {
  const h = harness({ getJsonError: async () => ({ version: 'next' }) })
  await h.start()
  const result = await h.run('status')
  assert.match(result.text, /no valid version/)
})

test('concurrent syncs are refused while one is running', async () => {
  let release
  const h = harness({
    getJsonError: async (url) => {
      if (url.endsWith('/latest')) return new Promise((resolve) => { release = () => resolve({ version: '1.6.0' }) })
      return catalog('gpt-6.2-astra', 'gpt-6.1-terra')
    },
  })
  await h.start()
  release()
  await new Promise((resolve) => setImmediate(resolve))
  const first = h.run('sync')
  const second = await h.run('sync')
  assert.equal(second.kind, 'error')
  assert.match(second.text, /already syncing/)
  release()
  await first
  assert.equal(ids(h).length, 3)
})

test('status includes the last result, and unknown arguments return usage', async () => {
  const h = harness()
  await h.start()
  const status = await h.run('status')
  assert.match(status.text, /1.6.0/)
  assert.match(status.text, /Next automatic check: 1970-01-01T06:00:01.000Z/)
  const usage = await h.run('on')
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
  assert.equal(ids(h).length, 3)
})

test('the timer computes the next check from each tick and is disposed on unload', async () => {
  const h = harness()
  await h.start()
  assert.equal(h.intervals.length, 1)
  assert.equal(h.intervals[0].ms, 21600000)
  h.setClock(50_000)
  h.intervals[0].fn()
  await new Promise((resolve) => setImmediate(resolve))
  assert.match((await h.run('status')).text, /Next automatic check: 1970-01-01T06:00:50.000Z/)
  h.cleanups.forEach((cleanup) => cleanup())
  assert.equal(h.intervals[0].cleared, true)
  assert.doesNotMatch((await h.run('status')).text, /Next automatic check/)
})

test('automatic checks skip a provider already checked at the same version; manual sync refetches', async () => {
  const h = harness()
  await h.start()
  const before = h.calls.length
  h.intervals[0].fn()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.calls.length, before + 1, 'only npm latest is fetched')
  await h.run('sync')
  assert.equal(h.calls.length, before + 3)
})

test('an invalid config logs an error and does not start a timer', async () => {
  const h = harness({ config: { refreshMs: 1 } })
  await h.start()
  assert.equal(h.intervals.length, 0)
  assert.match(h.warnings.join('\n'), /refreshMs/)
  const result = await h.run('sync')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /disabled by its config/)
})

test('at most 200 models are added per sync and the rest follow on the next automatic check', async () => {
  const many = Array.from({ length: 230 }, (_, index) => `m-${index}`)
  const h = harness({ enabled: true })
  h.setUpstream('1.6.0', many)
  await h.start()
  assert.equal(ids(h).length, 201)
  h.intervals[0].fn()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(ids(h).length, 231)
})

test('subagent routes are not touched unless syncAllowedModels is true', async () => {
  const h = harness()
  await h.start()
  assert.deepEqual(h.allowed, [
    { provider: 'openai-codex', model: 'gpt-6-astra' },
    { provider: 'anthropic', model: 'claude-sonnet-5-5' },
  ])
  assert.ok(h.edits.every((edit) => edit.kind === 'llm'))
})

test('with syncAllowedModels, routes are added only for models added in this sync and reported separately', async () => {
  const h = harness({ config: { syncAllowedModels: true }, allowed: [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }] })
  await h.start()
  // gpt-6-astra was already listed and has no route: the plugin did not add it, so it gets none.
  assert.deepEqual(h.allowed, [
    { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    { provider: 'openai-codex', model: 'gpt-6.2-astra' },
    { provider: 'openai-codex', model: 'gpt-6.1-terra' },
  ])
  const status = await h.run('status')
  assert.match(status.text, /Models added: openai-codex\/gpt-6.2-astra, openai-codex\/gpt-6.1-terra\./)
  assert.match(status.text, /Subagent routes added: openai-codex\/gpt-6.2-astra, openai-codex\/gpt-6.1-terra\./)
  const again = await h.run('sync')
  assert.match(again.text, /Subagent routes added: none/)
  assert.equal(h.edits.filter((edit) => edit.kind === 'settings').length, 1)
})

test('a route added by another writer during the allowedModels edit is preserved', async () => {
  const h = harness({ config: { syncAllowedModels: true } })
  h.setBeforeChange('settings', (entry) => {
    entry.options.config.allowedModels.push({ provider: 'user', model: 'added-concurrently' })
  })
  await h.start()
  assert.ok(h.allowed.some((route) => route.provider === 'user' && route.model === 'added-concurrently'))
  assert.ok(h.allowed.some((route) => route.model === 'gpt-6.2-astra'))
  assert.ok(h.allowed.some((route) => route.provider === 'anthropic'))
})

test('a failed route edit is retried on the next sync even when no catalog model is new', async () => {
  const h = harness({ config: { syncAllowedModels: true } })
  h.failEdit('settings', 'rejected once', true)
  await h.start()
  assert.equal(ids(h).length, 3)
  assert.equal(h.allowed.length, 2)
  const status = await h.run('status')
  assert.match(status.text, /waiting for a retry: openai-codex\/gpt-6.2-astra, openai-codex\/gpt-6.1-terra/)
  // Automatic check at the same version: no catalog fetch, but the routes are retried.
  h.intervals[0].fn()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.allowed.length, 4)
  assert.doesNotMatch((await h.run('status')).text, /waiting for a retry/)
})

test('a pending route is dropped when its model is no longer listed', async () => {
  const h = harness({ config: { syncAllowedModels: true } })
  h.failEdit('settings', 'rejected')
  await h.start()
  h.clearFailure('settings')
  h.llm.providers['openai-codex'].models = h.llm.providers['openai-codex'].models.filter((entry) => entry.id !== 'gpt-6.1-terra')
  // Automatic check at the same version: the catalog is not refetched, so the
  // removed model is not re-added (a manual sync would add it back).
  h.intervals[0].fn()
  await new Promise((resolve) => setImmediate(resolve))
  const status = await h.run('status')
  assert.match(status.text, /gpt-6.1-terra: no longer listed/)
  assert.ok(!h.allowed.some((route) => route.model === 'gpt-6.1-terra'))
  assert.ok(h.allowed.some((route) => route.model === 'gpt-6.2-astra'))
})

test('deleting a discovered model does not stick: a manual sync adds it back', async () => {
  const h = harness()
  await h.start()
  h.llm.providers['openai-codex'].models = h.llm.providers['openai-codex'].models.filter((entry) => entry.id !== 'gpt-6.1-terra')
  await h.run('sync')
  assert.ok(ids(h).includes('gpt-6.1-terra'))
})

test('a missing subagent settings row keeps routes pending and reports it', async () => {
  const h = harness({ config: { syncAllowedModels: true }, settingsRow: false })
  await h.start()
  const status = await h.run('status')
  assert.match(status.text, /subagent-model-selection-settings is not editable/)
  assert.match(status.text, /waiting for a retry/)
})

test('the llm-pi-ai row that owns the provider is chosen; ambiguity is refused', async () => {
  const owner = { id: 'b', config: defaultConfig() }
  let h = harness({ llmRows: [{ id: 'a', config: { providers: { deepseek: { models: [{ id: 'x' }] } } } }, owner] })
  await h.start()
  assert.equal(h.rows[1].options.config.providers['openai-codex'].models.length, 3)
  assert.deepEqual(h.rows[0].options.config, { providers: { deepseek: { models: [{ id: 'x' }] } } })

  h = harness({ llmRows: [{ id: 'a', config: defaultConfig() }, { id: 'b', config: defaultConfig() }] })
  await h.start()
  assert.equal(h.edits.length, 0)
  assert.match(h.warnings.join('\n'), /configured in several llm-pi-ai rows \(a, b\)/)

  h = harness({ llmRows: [{ id: 'a', config: {} }, { id: 'b', config: { providers: {} } }] })
  await h.start()
  assert.equal(h.edits.length, 0)
  assert.match(h.warnings.join('\n'), /not configured in any of the llm-pi-ai rows \(a, b\)/)

  assert.match(pickLlmEntry([], 'openai-codex').error, /not editable in this profile/)
})

test('status.json is written atomically with private modes and sanitized strings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-discovery-test-'))
  try {
    const statusFile = join(dir, 'model-discovery', 'status.json')
    const h = harness({
      enabled: false,
      statusFile,
      getJsonError: async (url) => {
        if (url.endsWith('/latest')) return { version: '1.6.0' }
        return { [GROUP]: { 'chat:\u001b[31mevil\u202e': { id: 'bad id\n' }, 'chat:ok': model('ok') } }
      },
    })
    await h.start()
    await h.run('sync')
    const text = await readFile(statusFile, 'utf8')
    const status = JSON.parse(text)
    assert.deepEqual(Object.keys(status), ['version', 'modelsAdded', 'routesAdded', 'pendingRoutes', 'skipped', 'error', 'result', 'finishedAt'])
    assert.equal(status.version, '1.6.0')
    assert.deepEqual(status.modelsAdded, ['openai-codex/ok'])
    assert.equal(status.error, null)
    assert.doesNotMatch(text, /\\u001b|\\u202e|\u202e/)
    assert.doesNotMatch(text, /KEY/, 'no config values')
    if (process.platform !== 'win32') {
      assert.equal((await stat(statusFile)).mode & 0o777, 0o600)
      assert.equal((await stat(join(dir, 'model-discovery'))).mode & 0o777, 0o700)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
