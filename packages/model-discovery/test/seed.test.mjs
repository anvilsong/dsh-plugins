import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { catalogProtocols, planSeed, seedPrecheck } from '../src/discovery.js'
import { apply } from '../src/index.host.js'

const LLM = '@deepseek-ai/dsh-llm-pi-ai'
const COMPLETIONS = 'openai-completions'
const ANTHROPIC = 'anthropic-messages'
const SECRET = 'SECRET-KEY-VALUE'

const chat = (id, group, extra = {}) => ({
  id, name: id.toUpperCase(), api: group, provider: 'openrouter',
  baseUrl: group === ANTHROPIC ? 'https://openrouter.ai/api' : 'https://openrouter.ai/api/v1',
  reasoning: false, input: ['text'], cost: {}, contextWindow: 100000, maxTokens: 8000, type: 'chat', ...extra,
})
const NEON_MAP = { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: null }
const rawCatalog = (groups) => Object.fromEntries(Object.entries(groups).map(([group, ids]) => [
  group, Object.fromEntries(ids.map((id) => [`chat:${id}`, chat(id, group)])),
]))
// Served by DSH (listModels order): five ids, one of which the catalog lacks.
const SERVED = ['a/one', 'b/two', 'c/three', 'old/gone', 'd/four']
const CATALOG = () => rawCatalog({ [COMPLETIONS]: ['a/one', 'b/two', 'c/three', 'z/unserved'], [ANTHROPIC]: ['d/four'] })
const served = (ids) => ids.map((id) => ({ provider: 'openrouter', id, name: id }))

function config() {
  return {
    keep: { nested: true },
    providers: {
      openrouter: { apiKeyEnv: SECRET, baseURL: 'https://openrouter.ai/api/v1', order: ['x'] },
      other: { enabled: true, models: [{ id: 'keep-me' }] },
    },
  }
}

function harness({
  settings = {}, current, llmRows, servedIds = SERVED, catalog = CATALOG(), version = '1.6.1', statusFile, llm = 'default',
} = {}) {
  const commands = []
  const edits = []
  const beforeChange = []
  const rows = (llmRows ?? [{ id: 'llm-pi-ai', config: current ?? config() }]).map((row) => ({
    options: { id: row.id, name: LLM, config: row.config },
  }))
  const editor = {
    entries: () => rows,
    async edit(entry, change) {
      assert.ok(rows.includes(entry))
      for (const fn of beforeChange) fn(entry)
      const next = change(structuredClone(entry.options.config), {})
      edits.push(next)
      entry.options.config = next
    },
  }
  const state = { servedIds, catalog, version, listCalls: [], urls: [], llm, fetchError: undefined, hold: undefined, listImpl: undefined, home: undefined }
  const service = {
    async listModels(provider) {
      state.listCalls.push(provider)
      if (state.listImpl !== undefined) return state.listImpl(provider)
      return served(state.servedIds)
    },
  }
  const ctx = {
    logger: { warn() {}, error() {} },
    get: (name) => {
      if (name === 'configEditor') return editor
      if (name === 'llm') return state.llm === 'default' ? service : state.llm
      if (name === 'profileContext') return state.home === undefined ? undefined : { home: state.home }
      return undefined
    },
    inject(names, callback) {
      if (names.includes('commands')) callback({ commands: { register: (command) => commands.push(command) } })
    },
  }
  const getJson = async (url) => {
    state.urls.push(url)
    const failure = state.fetchError?.(url)
    if (failure !== undefined) throw failure
    if (state.hold !== undefined && url.endsWith('/latest')) await state.hold
    if (url.endsWith('/latest')) return { version: state.version }
    if (url.includes('/dist/providers/data/openrouter.json')) return state.catalog
    throw new Error(`unexpected URL ${url}`)
  }
  const h = {
    commands, edits, rows, state, beforeChange,
    get llm() { return rows[0].options.config },
    get provider() { return rows[0].options.config.providers.openrouter },
    run: (input) => commands[0].handler({ rawInput: input }),
    async start() {
      await apply(ctx, { enabled: false, ...settings }, { getJson, now: () => 1000, ...(statusFile === undefined ? {} : { statusFile }) })
      return h
    },
  }
  return h
}

async function started(options) {
  return harness(options).start()
}
const SEED_ALL = 'seed openrouter'
const SEED_COMPLETIONS = `seed openrouter ${COMPLETIONS}`

test('a preview writes nothing and names the row, version, api, count and every left-out id with its reason', async () => {
  const h = await started()
  const before = structuredClone(h.llm)
  const result = await h.run(SEED_COMPLETIONS)
  assert.equal(result.kind, 'success')
  assert.equal(h.edits.length, 0)
  assert.deepEqual(h.llm, before)
  assert.match(result.text, /llm-pi-ai/)
  assert.match(result.text, /1\.6\.1/)
  assert.match(result.text, /openai-completions/)
  assert.match(result.text, /3 ids/)
  assert.match(result.text, /d\/four: .*anthropic-messages/)
  assert.match(result.text, /old\/gone: .*not .*chat model/)
  assert.doesNotMatch(result.text, /a\/one: /, 'a listed id is not a left-out line')
  assert.match(result.text, /seed openrouter openai-completions confirm/)
  assert.doesNotMatch(result.text, new RegExp(SECRET))
})

test('a preview with a route api names that api is not added', async () => {
  const h = await started({ current: { providers: { openrouter: { api: COMPLETIONS, apiKeyEnv: SECRET } } } })
  const preview = await h.run(SEED_ALL)
  assert.equal(preview.kind, 'success')
  assert.match(preview.text, /no api is added \(the route already sets openai-completions\)/)
  assert.match(preview.text, /5 ids/)
  assert.equal(h.edits.length, 0)
})

test('a preview lists at most 200 left-out ids and then a count', async () => {
  const many = Array.from({ length: 250 }, (_, index) => `gone/m-${index}`)
  const h = await started({ servedIds: ['a/one', ...many] })
  const result = await h.run(SEED_COMPLETIONS)
  assert.equal(result.kind, 'success')
  assert.equal(h.edits.length, 0)
  assert.match(result.text, /gone\/m-199:/)
  assert.doesNotMatch(result.text, /gone\/m-200:/)
  assert.match(result.text, /and 50 more/)
})

test('no api and the route already sets one: confirm writes id-only entries in listModels order and adds no api', async () => {
  for (const models of [undefined, []]) {
    const base = config()
    base.providers.openrouter.api = COMPLETIONS
    if (models !== undefined) base.providers.openrouter.models = models
    const h = await started({ current: base })
    const expected = structuredClone(base)
    await h.run(SEED_ALL)
    const result = await h.run(`${SEED_ALL} confirm`)
    assert.equal(result.kind, 'success', result.text)
    assert.equal(h.edits.length, 1)
    expected.providers.openrouter.models = SERVED.map((id) => ({ id }))
    assert.deepEqual(h.llm, expected)
    assert.equal(h.provider.api, COMPLETIONS)
  }
})

test('no api and the served ids resolve to one protocol: all served ids are listed in order and no api is added', async () => {
  const h = await started({ servedIds: ['c/three', 'a/one', 'old/gone', 'b/two'] })
  const expected = structuredClone(h.llm)
  const preview = await h.run(SEED_ALL)
  assert.equal(preview.kind, 'success')
  assert.match(preview.text, /4 ids/)
  const result = await h.run(`${SEED_ALL} confirm`)
  assert.equal(result.kind, 'success', result.text)
  assert.equal(h.edits.length, 1)
  expected.providers.openrouter.models = ['c/three', 'a/one', 'old/gone', 'b/two'].map((id) => ({ id }))
  assert.deepEqual(h.llm, expected)
  assert.equal(Object.hasOwn(h.provider, 'api'), false)
})

test('no api and several protocols: an error names each protocol with its count and the command; nothing is written', async () => {
  const h = await started()
  const result = await h.run(SEED_ALL)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /openai-completions \(3\)/)
  assert.match(result.text, /anthropic-messages \(1\)/)
  assert.match(result.text, /\/model-discovery seed openrouter openai-completions/)
  assert.match(result.text, /\/model-discovery seed openrouter anthropic-messages/)
  assert.equal((await h.run(`${SEED_ALL} confirm`)).kind, 'error')
  assert.equal(h.edits.length, 0)
})

test('with an api: writes api and only the served ids of that protocol; the rest is left out and named', async () => {
  const h = await started()
  const expected = structuredClone(h.llm)
  const preview = await h.run(SEED_COMPLETIONS)
  assert.equal(preview.kind, 'success')
  const result = await h.run(`${SEED_COMPLETIONS} confirm`)
  assert.equal(result.kind, 'success', result.text)
  assert.equal(h.edits.length, 1)
  expected.providers.openrouter.api = COMPLETIONS
  expected.providers.openrouter.models = ['a/one', 'b/two', 'c/three'].map((id) => ({ id }))
  assert.deepEqual(h.llm, expected)
  assert.match(result.text, /d\/four/)
  assert.match(result.text, /old\/gone/)
  // The other protocol works the same way.
  const other = await started()
  await other.run(`seed openrouter ${ANTHROPIC}`)
  assert.equal((await other.run(`seed openrouter ${ANTHROPIC} confirm`)).kind, 'success')
  assert.deepEqual(other.provider.models, [{ id: 'd/four' }])
  assert.equal(other.provider.api, ANTHROPIC)
})

test('an id whose first chat entry is unusable, duplicated, non-chat or invalid is left out, never listed', async () => {
  const odd = rawCatalog({ [COMPLETIONS]: ['a/one'] })
  // dup: an id with two chat entries has no usable protocol (F2), whichever comes first.
  odd[ANTHROPIC] = { 'chat:dup': chat('a/one', ANTHROPIC) }
  const catalog = { [ANTHROPIC]: odd[ANTHROPIC], [COMPLETIONS]: odd[COMPLETIONS] }
  catalog[COMPLETIONS]['chat:other'] = chat('mismatch', COMPLETIONS, { api: ANTHROPIC })
  catalog[COMPLETIONS]['chat:foreign'] = chat('foreign', COMPLETIONS, { provider: 'someone-else' })
  catalog[COMPLETIONS]['chat:embed'] = chat('embed', COMPLETIONS, { type: 'embedding' })
  catalog[COMPLETIONS]['chat:b'] = chat('b/two', COMPLETIONS)
  const h = await started({ catalog, servedIds: ['a/one', 'mismatch', 'foreign', 'embed', 'b/two', 'bad id', 'b/two'] })
  const preview = await h.run(SEED_COMPLETIONS)
  assert.equal(preview.kind, 'success', preview.text)
  assert.match(preview.text, /1 id\b/)
  for (const id of ['a/one', 'mismatch', 'foreign', 'embed', 'bad id']) assert.match(preview.text, new RegExp(`${id}: `))
  assert.match(preview.text, /b\/two: .*duplicate/)
  assert.match(preview.text, /a\/one: .*more than one chat entry/)
  assert.match(preview.text, /mismatch: .*names api anthropic-messages but sits in group openai-completions/)
  await h.run(`${SEED_COMPLETIONS} confirm`)
  assert.deepEqual(h.provider.models, [{ id: 'b/two' }])
})

test('with no api, a served id with unsupported characters is still left out, never listed', async () => {
  const h = await started({ servedIds: ['a/one', 'bad id', 'b/two'] })
  const preview = await h.run(SEED_ALL)
  assert.equal(preview.kind, 'success', preview.text)
  assert.match(preview.text, /bad id: id is empty, longer than 128 characters or has unsupported characters/)
  await h.run(`${SEED_ALL} confirm`)
  assert.deepEqual(h.provider.models, [{ id: 'a/one' }, { id: 'b/two' }])
})

test('catalogProtocols: an id has a protocol only with one chat entry of this provider whose api equals its group; ambiguous ones are named unusable', () => {
  const group = (api, entries) => Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, { ...chat(entry.id, api), ...entry }]))
  const raw = {
    [COMPLETIONS]: group(COMPLETIONS, {
      first: { id: 'x' },
      nonchat: { id: 'y', type: 'embedding' },
      wrongProvider: { id: 'z', provider: 'else' },
      okAfter: { id: 'w' },
    }),
    [ANTHROPIC]: group(ANTHROPIC, {
      again: { id: 'x' },
      chatAfterNonChat: { id: 'y' },
      zAgain: { id: 'z' },
      mismatched: { id: 'm', api: COMPLETIONS },
      badId: { id: 'has space' },
    }),
  }
  const { protocols, unusable } = catalogProtocols(raw, 'openrouter')
  assert.deepEqual([...protocols], [['w', COMPLETIONS], ['y', ANTHROPIC]])
  assert.deepEqual([...unusable.keys()], ['x', 'z', 'm'])
  assert.match(unusable.get('x'), /more than one chat entry/)
  assert.match(unusable.get('m'), /names api openai-completions but sits in group anthropic-messages/)
  assert.equal(catalogProtocols(null, 'openrouter').error, 'catalog JSON is not an object')
  assert.deepEqual([...catalogProtocols({ [COMPLETIONS]: 5, [ANTHROPIC]: { k: 5 } }, 'openrouter').protocols], [])
})

test('confirm needs a preview of the same provider and api in this process, and a preview is used once', async () => {
  const h = await started()
  let result = await h.run(`${SEED_COMPLETIONS} confirm`)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /There is no preview of \/model-discovery seed openrouter openai-completions/)
  await h.run(SEED_COMPLETIONS)
  result = await h.run(`seed openrouter ${ANTHROPIC} confirm`)
  assert.equal(result.kind, 'error', 'a preview of another api does not count')
  assert.equal(h.edits.length, 0)
  result = await h.run(`${SEED_COMPLETIONS} confirm`)
  assert.equal(result.kind, 'success', result.text)
  assert.equal(h.edits.length, 1)
  // Used once: a second confirm needs a new preview, even after the seeded config is restored by hand.
  h.rows[0].options.config = config()
  result = await h.run(`${SEED_COMPLETIONS} confirm`)
  assert.equal(result.kind, 'error')
  assert.equal(h.edits.length, 1)
  // A failed confirm also consumes the preview.
  await h.run(SEED_COMPLETIONS)
  h.state.servedIds = ['a/one']
  assert.equal((await h.run(`${SEED_COMPLETIONS} confirm`)).kind, 'error')
  h.state.servedIds = SERVED
  assert.equal((await h.run(`${SEED_COMPLETIONS} confirm`)).kind, 'error')
  assert.equal(h.edits.length, 1)
})

test('a plan that differs at confirm time writes nothing: served list, catalog version, or catalog protocols changed', async () => {
  for (const change of [
    (h) => { h.state.servedIds = [...SERVED, 'a/new'] },
    (h) => { h.state.servedIds = ['a/one', 'b/two', 'c/three', 'd/four', 'old/gone'] },
    (h) => { h.state.version = '1.6.2' },
    (h) => { h.state.catalog = rawCatalog({ [COMPLETIONS]: ['a/one', 'b/two', 'd/four'], [ANTHROPIC]: ['c/three'] }) },
  ]) {
    const h = await started()
    const before = structuredClone(h.llm)
    await h.run(SEED_COMPLETIONS)
    change(h)
    const result = await h.run(`${SEED_COMPLETIONS} confirm`)
    assert.equal(result.kind, 'error')
    assert.match(result.text, /differs from the preview/)
    assert.equal(h.edits.length, 0)
    assert.deepEqual(h.llm, before)
  }
})

test('inside the edit, a config another writer changed since the preview throws and writes nothing', async () => {
  for (const [name, mutate, pattern] of [
    ['models added', (config) => { config.providers.openrouter.models = [{ id: 'external' }] }, /already lists models/],
    ['api added', (config) => { config.providers.openrouter.api = ANTHROPIC }, /differs from the provider api setting/],
    ['same api added', (config) => { config.providers.openrouter.api = COMPLETIONS }, /differs from the preview/],
    ['modelOverrides added', (config) => { config.providers.openrouter.modelOverrides = { 'a/one': { name: 'x' } } }, /modelOverrides/],
    ['provider removed', (config) => { delete config.providers.openrouter }, /not configured/],
  ]) {
    const h = await started()
    await h.run(SEED_COMPLETIONS)
    let after
    h.beforeChange.push((entry) => { mutate(entry.options.config); after = structuredClone(entry.options.config) })
    const result = await h.run(`${SEED_COMPLETIONS} confirm`)
    assert.equal(result.kind, 'error', name)
    assert.match(result.text, pattern, name)
    assert.equal(h.edits.length, 0, name)
    assert.deepEqual(h.llm, after, `${name}: nothing of the seed was written`)
  }
})

test('an editor that rejects the edit gives an error and no success text', async () => {
  const h = await started()
  await h.run(SEED_COMPLETIONS)
  h.beforeChange.push(() => { throw new Error('Configuration for "llm-pi-ai" is overridden by a home patch') })
  const result = await h.run(`${SEED_COMPLETIONS} confirm`)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /overridden by a home patch/)
  assert.equal(h.edits.length, 0)
})

const EARLY = new Set([
  'provider not configured', 'providers missing', 'providers not an object', 'config not an object', 'non-empty models',
  'models not an array', 'modelOverrides present', 'api differs from the route api', 'route api is not a string',
  'several rows own the provider', 'no row configures it', 'invalid plugin config',
])

test('every refusal returns an error and writes nothing', async () => {
  const cases = [
    ['provider not configured', { current: { providers: { other: {} } } }, SEED_COMPLETIONS, /openrouter is not configured/],
    ['providers missing', { current: {} }, SEED_COMPLETIONS, /openrouter is not configured/],
    ['providers not an object', { current: { providers: [] } }, SEED_COMPLETIONS, /providers setting is not an object/],
    ['config not an object', { current: { providers: { openrouter: 'x' } } }, SEED_COMPLETIONS, /not an object/],
    ['non-empty models', { current: { providers: { openrouter: { models: [{ id: 'a/one' }] } } } }, SEED_COMPLETIONS, /already lists models/],
    ['models not an array', { current: { providers: { openrouter: { models: {} } } } }, SEED_COMPLETIONS, /models is not an array/],
    ['modelOverrides present', { current: { providers: { openrouter: { modelOverrides: {} } } } }, SEED_COMPLETIONS, /modelOverrides/],
    ['api differs from the route api', { current: { providers: { openrouter: { api: ANTHROPIC } } } }, SEED_COMPLETIONS, /differs from the provider api setting/],
    ['route api is not a string', { current: { providers: { openrouter: { api: 7 } } } }, SEED_ALL, /api setting/],
    ['api used by no served id', {}, 'seed openrouter openai-responses', /no served model uses openai-responses/],
    ['llm service missing', { llm: null }, SEED_COMPLETIONS, /llm service is unavailable/],
    ['llm without listModels', { llm: {} }, SEED_COMPLETIONS, /llm service is unavailable/],
    ['npm fetch fails', { fetchFail: '/latest' }, SEED_COMPLETIONS, /boom/],
    ['unpkg fetch fails', { fetchFail: 'openrouter.json' }, SEED_COMPLETIONS, /boom/],
    ['npm version invalid', { version: 'next' }, SEED_COMPLETIONS, /no valid version/],
    ['catalog is not an object', { catalog: [] }, SEED_COMPLETIONS, /catalog JSON is not an object/],
    ['several rows own the provider', { llmRows: [{ id: 'a', config: config() }, { id: 'b', config: config() }] }, SEED_COMPLETIONS, /several llm-pi-ai rows \(a, b\)/],
    ['no row configures it', { llmRows: [{ id: 'a', config: {} }, { id: 'b', config: { providers: {} } }] }, SEED_COMPLETIONS, /not configured in any of the llm-pi-ai rows/],
    ['invalid plugin config', { settings: { refreshMs: 1 } }, SEED_COMPLETIONS, /disabled by its config/],
  ]
  for (const [name, options, input, pattern] of cases) {
    const { fetchFail, ...rest } = options
    const h = await started(rest)
    if (fetchFail !== undefined) h.state.fetchError = (url) => (url.includes(fetchFail) ? new Error('boom') : undefined)
    const before = structuredClone(h.rows.map((row) => row.options.config))
    const result = await h.run(input)
    assert.equal(result.kind, 'error', name)
    assert.match(result.text, pattern, name)
    assert.equal((await h.run(`${input} confirm`)).kind, 'error', `${name}: confirm`)
    if (EARLY.has(name)) {
      assert.equal(h.state.listCalls.length, 0, `${name}: no listModels call`)
      assert.equal(h.state.urls.length, 0, `${name}: no fetch`)
    }
    assert.equal(h.edits.length, 0, name)
    assert.deepEqual(h.rows.map((row) => row.options.config), before, name)
  }
})

test('listModels failures are refusals: throwing, non-array, zero ids, over 2000 ids, an entry without id, another provider', async () => {
  const cases = [
    ['throws', () => { throw new Error('discovery exploded') }, /discovery exploded/],
    ['rejects', async () => { throw new Error('rejected') }, /rejected/],
    ['not an array', () => ({ models: [] }), /did not return a list/],
    ['zero ids', () => [], /no models/],
    ['too many', () => Array.from({ length: 2001 }, (_, index) => ({ provider: 'openrouter', id: `m-${index}` })), /more than 2000/],
    ['entry without id', () => [{ provider: 'openrouter' }], /without an id/],
    ['entry is not an object', () => ['a/one'], /without an id/],
    ['another provider', () => [{ provider: 'anthropic', id: 'a/one' }], /another provider/],
  ]
  for (const [name, impl, pattern] of cases) {
    const h = await started()
    h.state.listImpl = impl
    const result = await h.run(SEED_COMPLETIONS)
    assert.equal(result.kind, 'error', name)
    assert.match(result.text, pattern, name)
    assert.equal(h.edits.length, 0, name)
  }
  const exactly = await started()
  exactly.state.listImpl = () => Array.from({ length: 2000 }, (_, index) => ({ provider: 'openrouter', id: `m-${index}` }))
  assert.equal((await exactly.run('seed openrouter')).kind, 'success', 'exactly 2000 ids is accepted')
})

test('the seed holds the run lock: a sync or a second seed during a seed is refused, and a seed during a sync is refused', async () => {
  const h = await started({ settings: { providers: ['openrouter'] } })
  let release
  h.state.listImpl = () => new Promise((resolve) => { release = () => resolve(served(SERVED)) })
  const first = h.run(SEED_COMPLETIONS)
  await new Promise((resolve) => setImmediate(resolve))
  const second = await h.run(SEED_COMPLETIONS)
  assert.equal(second.kind, 'error')
  assert.match(second.text, /already running a sync or a seed/)
  const sync = await h.run('sync')
  assert.equal(sync.kind, 'error')
  assert.match(sync.text, /already syncing/)
  release()
  assert.equal((await first).kind, 'success')
  assert.equal(h.edits.length, 0)

  // A running sync refuses a seed.
  const g = await started({ settings: { providers: ['openrouter'] } })
  let unblock
  g.state.hold = new Promise((resolve) => { unblock = resolve })
  const running = g.run('sync')
  await new Promise((resolve) => setImmediate(resolve))
  const refused = await g.run(SEED_COMPLETIONS)
  assert.equal(refused.kind, 'error')
  assert.match(refused.text, /already running a sync or a seed/)
  assert.equal(g.state.listCalls.length, 0)
  unblock()
  await running
})

test('a hanging listModels is abandoned after timeoutMs, releases the lock and leaves no timer behind', async () => {
  const h = await started({ settings: { timeoutMs: 1000 } })
  h.state.listImpl = () => new Promise(() => {})
  const started1 = Date.now()
  const result = await h.run(SEED_COMPLETIONS)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /listModels did not answer within 1000 ms/)
  assert.ok(Date.now() - started1 < 5000)
  h.state.listImpl = undefined
  assert.equal((await h.run(SEED_COMPLETIONS)).kind, 'success', 'the lock was released')
})

test('seed works while enabled is false and for a provider absent from providers; the success text says how to undo and what to do next', async () => {
  const h = await started({ settings: { enabled: false, providers: ['openai-codex'] } })
  await h.run(SEED_COMPLETIONS)
  const result = await h.run(`${SEED_COMPLETIONS} confirm`)
  assert.equal(result.kind, 'success', result.text)
  assert.match(result.text, /Undo: remove `models` and `api` from providers\.openrouter/)
  assert.match(result.text, /add openrouter to the plugin's `providers`/i)
  assert.match(result.text, /\/model-discovery sync/)
  assert.match(result.text, /3 ids/)
  // No api added: the undo removes only models.
  const route = config()
  route.providers.openrouter.api = COMPLETIONS
  const g = await started({ current: route })
  await g.run(SEED_ALL)
  const done = await g.run(`${SEED_ALL} confirm`)
  assert.match(done.text, /Undo: remove `models` from providers\.openrouter/)
  assert.doesNotMatch(done.text, /remove `models` and `api`/)
})

test('usage and command hint name seed, and malformed seed input is a usage error that touches nothing', async () => {
  const h = await started()
  assert.match(h.commands[0].input.hint, /seed/)
  for (const input of ['on', 'seed', 'seed confirm', 'seed openrouter a b', 'seed openrouter a confirm extra', 'seed OpenRouter!', 'seed openrouter bad_api', 'seeds openrouter']) {
    const result = await h.run(input)
    assert.equal(result.kind, 'error', input)
    assert.match(result.text, /Usage: .*seed <provider> \[<api>\] \[confirm\]/, input)
  }
  assert.equal(h.state.listCalls.length, 0)
  assert.equal(h.state.urls.length, 0)
  // Input is case-insensitive like the other subcommands.
  const upper = await h.run('SEED openrouter OpenAI-Completions')
  assert.equal(upper.kind, 'success')
})

test('seed then sync: a new completions model gets exact efforts, anthropic models stay out, and nothing seeded is rewritten', async () => {
  const h = await started({ settings: { providers: ['openrouter'] } })
  await h.run(SEED_COMPLETIONS)
  assert.equal((await h.run(`${SEED_COMPLETIONS} confirm`)).kind, 'success')
  assert.equal(h.edits.length, 1)
  const catalog = rawCatalog({
    [COMPLETIONS]: ['a/one', 'b/two', 'c/three'],
    [ANTHROPIC]: ['d/four', 'e/new-anthropic'],
  })
  catalog[COMPLETIONS]['chat:neon'] = chat('google/neon', COMPLETIONS, { reasoning: true, thinkingLevelMap: NEON_MAP })
  h.state.catalog = catalog
  const result = await h.run('sync')
  assert.equal(result.kind, 'success', result.text)
  assert.match(result.text, /Models added: openrouter\/google\/neon\./)
  assert.match(result.text, /e\/new-anthropic: upstream api anthropic-messages differs from openai-completions \(the provider api setting\)/)
  assert.match(result.text, /d\/four: upstream api anthropic-messages differs/)
  assert.deepEqual(h.provider.models.map((entry) => entry.id), ['a/one', 'b/two', 'c/three', 'google/neon'])
  assert.deepEqual(h.provider.models[3].reasoningEfforts, { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' })
  assert.equal(h.provider.api, COMPLETIONS)
  assert.equal(h.provider.apiKeyEnv, SECRET)
})

test('the receipt seed-<provider>.json sits beside status.json, is private, and holds no config values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-discovery-seed-'))
  try {
    const statusFile = join(dir, 'model-discovery', 'status.json')
    const h = await started({ statusFile })
    await h.run(SEED_COMPLETIONS)
    const result = await h.run(`${SEED_COMPLETIONS} confirm`)
    assert.equal(result.kind, 'success', result.text)
    const file = join(dir, 'model-discovery', 'seed-openrouter.json')
    const text = await readFile(file, 'utf8')
    const receipt = JSON.parse(text)
    assert.equal(receipt.provider, 'openrouter')
    assert.equal(receipt.row, 'llm-pi-ai')
    assert.equal(receipt.version, '1.6.1')
    assert.equal(receipt.apiAdded, COMPLETIONS)
    assert.equal(receipt.listedCount, 3)
    assert.equal(receipt.leftOutCount, 2)
    assert.equal(receipt.leftOut.length, 2)
    assert.match(receipt.leftOut.join('\n'), /d\/four/)
    assert.match(receipt.undo, /remove `models` and `api` from providers\.openrouter/)
    assert.equal(typeof receipt.seededAt, 'number')
    assert.doesNotMatch(text, new RegExp(SECRET))
    assert.doesNotMatch(text, /openrouter\.ai/)
    assert.match(result.text, /seed-openrouter\.json/)
    if (process.platform !== 'win32') {
      assert.equal((await stat(file)).mode & 0o777, 0o600)
      assert.equal((await stat(join(dir, 'model-discovery'))).mode & 0o777, 0o700)
    }
    // No api added when the route already sets one: the receipt says null.
    const route = config()
    route.providers.openrouter.api = COMPLETIONS
    const g = await started({ statusFile, current: route })
    await g.run(SEED_ALL)
    await g.run(`${SEED_ALL} confirm`)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).apiAdded, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed receipt write neither fails nor undoes the seed, and the reply says so', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-discovery-seed-'))
  try {
    const statusFile = join(dir, 'model-discovery', 'status.json')
    // A non-empty directory where the receipt file belongs makes the atomic rename fail.
    await mkdir(join(dir, 'model-discovery', 'seed-openrouter.json'), { recursive: true })
    await writeFile(join(dir, 'model-discovery', 'seed-openrouter.json', 'keep'), 'x')
    const h = await started({ statusFile })
    await h.run(SEED_COMPLETIONS)
    const result = await h.run(`${SEED_COMPLETIONS} confirm`)
    assert.equal(result.kind, 'success', result.text)
    assert.match(result.text, /receipt .*could not be written/i)
    assert.equal(h.edits.length, 1)
    assert.deepEqual(h.provider.models.map((entry) => entry.id), ['a/one', 'b/two', 'c/three'])
    // Without any profile folder there is no receipt, and the reply says that too.
    const bare = await started()
    await bare.run(SEED_COMPLETIONS)
    const done = await bare.run(`${SEED_COMPLETIONS} confirm`)
    assert.equal(done.kind, 'success')
    assert.match(done.text, /receipt .*not written/i)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('planSeed and seedPrecheck are pure: they never mutate their input', () => {
  const providers = structuredClone(config().providers)
  const before = structuredClone(providers)
  const protocols = new Map([['a/one', COMPLETIONS], ['b/two', ANTHROPIC]])
  assert.equal(seedPrecheck(providers, 'openrouter', undefined).error, undefined)
  const plan = planSeed(providers, 'openrouter', COMPLETIONS, ['a/one', 'b/two'], protocols, '1.6.1')
  assert.deepEqual(plan.ids, ['a/one'])
  assert.equal(plan.api, COMPLETIONS)
  assert.deepEqual(plan.provider.models, [{ id: 'a/one' }])
  assert.deepEqual(providers, before)
  assert.match(planSeed(providers, 'openrouter', undefined, ['a/one', 'b/two'], protocols, '1.6.1').error, /several protocols/)
})

test('F3: no raw catalog group key or route api reaches the reply: control and bidi characters become spaces', async () => {
  const evil = 'openai-completions\nFORGED: write everything\u202e'
  const catalog = rawCatalog({ [COMPLETIONS]: ['a/one'] })
  catalog[evil] = { 'chat:evil': chat('evil/one', evil) }
  const h = await started({ catalog, servedIds: ['a/one', 'evil/one'] })
  for (const input of [SEED_COMPLETIONS, SEED_ALL]) {
    const result = await h.run(input)
    assert.equal(result.kind, 'success', result.text)
    assert.doesNotMatch(result.text, /^FORGED/m)
    assert.doesNotMatch(result.text, /[\u202e\u2028]/)
    if (input === SEED_COMPLETIONS) assert.match(result.text, /evil\/one: .*group name .*FORGED/, 'named, with the newline replaced')
  }
  assert.equal(h.edits.length, 0)
  // The configured route api is cleaned too.
  const route = config()
  route.providers.openrouter.api = 'x\nFORGED: listed'
  const g = await started({ current: route })
  const preview = await g.run(SEED_ALL)
  assert.equal(preview.kind, 'success', preview.text)
  assert.doesNotMatch(preview.text, /^FORGED/m)
  assert.match(preview.text, /already sets x FORGED: listed/)
  const done = await g.run(`${SEED_ALL} confirm`)
  assert.equal(done.kind, 'success', done.text)
  assert.doesNotMatch(done.text, /^FORGED/m)
})

test('F2: ids with several chat entries or an api that differs from the group are left out under an api with their own reasons; without an api nothing is claimed', async () => {
  const catalog = { [COMPLETIONS]: {
    'chat:ok': chat('ok/one', COMPLETIONS),
    'chat:dup-a': chat('dup/one', COMPLETIONS),
    'chat:dup-b': chat('dup/one', COMPLETIONS),
    'chat:skew': chat('skew/one', COMPLETIONS, { api: ANTHROPIC }),
  } }
  const h = await started({ catalog, servedIds: ['ok/one', 'dup/one', 'skew/one'] })
  const preview = await h.run(SEED_COMPLETIONS)
  assert.equal(preview.kind, 'success', preview.text)
  assert.match(preview.text, /dup\/one: .*more than one chat entry/)
  assert.match(preview.text, /skew\/one: .*names api anthropic-messages but sits in group openai-completions/)
  await h.run(`${SEED_COMPLETIONS} confirm`)
  assert.deepEqual(h.provider.models, [{ id: 'ok/one' }])
  // Without an api no protocol is claimed, so the same ids are listed.
  const g = await started({ catalog, servedIds: ['ok/one', 'dup/one', 'skew/one'] })
  await g.run(SEED_ALL)
  await g.run(`${SEED_ALL} confirm`)
  assert.deepEqual(g.provider.models.map((entry) => entry.id), ['ok/one', 'dup/one', 'skew/one'])
  assert.equal(Object.hasOwn(g.provider, 'api'), false)
})

test('F4: when no id is left to list the seed refuses instead of writing an empty models list', async () => {
  const h = await started({ servedIds: ['bad id', 'also bad'] })
  const result = await h.run(SEED_ALL)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /no id is left to list/)
  assert.equal((await h.run(`${SEED_ALL} confirm`)).kind, 'error')
  assert.equal(h.edits.length, 0)
  assert.equal(Object.hasOwn(h.provider, 'models'), false)
})

test('F5: a catalog with no chat model of the provider is refused, whatever the api argument', async () => {
  const foreign = { [COMPLETIONS]: { 'chat:x': chat('a/one', COMPLETIONS, { provider: 'someone-else' }) } }
  const nonChat = { [COMPLETIONS]: { 'e:x': chat('a/one', COMPLETIONS, { type: 'embedding' }) } }
  for (const [name, catalog] of [['empty', {}], ['foreign provider', foreign], ['no chat type', nonChat]]) {
    const h = await started({ catalog })
    for (const input of [SEED_ALL, SEED_COMPLETIONS]) {
      const result = await h.run(input)
      assert.equal(result.kind, 'error', name)
      assert.match(result.text, /has no chat model for provider openrouter/, name)
    }
    assert.equal(h.edits.length, 0, name)
  }
})

test('F6: the receipt keeps its "and N more left out" line beyond 200 left-out ids, and has no such line at exactly 200', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-discovery-seed-'))
  try {
    const statusFile = join(dir, 'model-discovery', 'status.json')
    const file = join(dir, 'model-discovery', 'seed-openrouter.json')
    for (const [extra, expectLine] of [[250, 'and 51 more left out'], [200, undefined]]) {
      const many = Array.from({ length: extra }, (_, index) => `gone/m-${index}`)
      const h = await started({ statusFile, servedIds: ['a/one', ...many] })
      await h.run(SEED_COMPLETIONS)
      assert.equal((await h.run(`${SEED_COMPLETIONS} confirm`)).kind, 'success')
      const receipt = JSON.parse(await readFile(file, 'utf8'))
      assert.equal(receipt.leftOutCount, extra)
      assert.equal(receipt.leftOut.length, 200)
      if (expectLine === undefined) assert.doesNotMatch(receipt.leftOut.join('\n'), /more left out/)
      else assert.equal(receipt.leftOut.at(-1), expectLine)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('F7: the reply names the receipt as $DSH_HOME/model-discovery/seed-<provider>.json and never prints an absolute or temp path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-discovery-seed-'))
  try {
    const statusFile = join(dir, 'model-discovery', 'status.json')
    const h = await started({ statusFile })
    await h.run(SEED_COMPLETIONS)
    const result = await h.run(`${SEED_COMPLETIONS} confirm`)
    assert.match(result.text, /Receipt: \$DSH_HOME\/model-discovery\/seed-openrouter\.json/)
    assert.equal(result.text.includes(dir), false)
    assert.doesNotMatch(result.text, /\.tmp/)
    await rm(join(dir, 'model-discovery', 'seed-openrouter.json'))
    await mkdir(join(dir, 'model-discovery', 'seed-openrouter.json'))
    await writeFile(join(dir, 'model-discovery', 'seed-openrouter.json', 'keep'), 'x')
    const g = await started({ statusFile })
    await g.run(SEED_COMPLETIONS)
    const failed = await g.run(`${SEED_COMPLETIONS} confirm`)
    assert.match(failed.text, /receipt .*could not be written/i)
    assert.equal(failed.text.includes(dir), false)
    assert.doesNotMatch(failed.text, /\.tmp/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('F8: the route api (or its absence) is part of the plan: removing or changing it after the preview refuses the confirm', async () => {
  const only = ['a/one', 'b/two']
  for (const via of ['between', 'inside']) {
    const route = config()
    route.providers.openrouter.api = COMPLETIONS
    const h = await started({ current: route, servedIds: only })
    const preview = await h.run(SEED_ALL)
    assert.equal(preview.kind, 'success', preview.text)
    const drop = (value) => { delete value.providers.openrouter.api }
    let before
    if (via === 'between') drop(h.llm)
    else h.beforeChange.push((entry) => { drop(entry.options.config); before = structuredClone(entry.options.config) })
    if (via === 'between') before = structuredClone(h.llm)
    const result = await h.run(`${SEED_ALL} confirm`)
    assert.equal(result.kind, 'error', via)
    assert.match(result.text, /differs from the preview/, via)
    assert.equal(h.edits.length, 0, via)
    assert.deepEqual(h.llm, before, via)
  }
})

test('T1: an unrelated provider or top-level key changed before the edit is kept, not overwritten by a stale snapshot', async () => {
  const h = await started()
  await h.run(SEED_COMPLETIONS)
  h.beforeChange.push((entry) => {
    entry.options.config.keep = { nested: 'changed' }
    entry.options.config.providers.other = { enabled: false, models: [{ id: 'new-one' }] }
    entry.options.config.providers.added = { x: 1 }
  })
  const result = await h.run(`${SEED_COMPLETIONS} confirm`)
  assert.equal(result.kind, 'success', result.text)
  assert.deepEqual(h.llm.keep, { nested: 'changed' })
  assert.deepEqual(h.llm.providers.other, { enabled: false, models: [{ id: 'new-one' }] })
  assert.deepEqual(h.llm.providers.added, { x: 1 })
  assert.deepEqual(h.provider.models, ['a/one', 'b/two', 'c/three'].map((id) => ({ id })))
})

test('T1: the pi-ai version is part of the plan, even when no left-out reason quotes it', async () => {
  const h = await started({ servedIds: ['a/one', 'b/two', 'c/three', 'd/four'] })
  const preview = await h.run(SEED_COMPLETIONS)
  assert.doesNotMatch(preview.text.split('Left out')[1] ?? '', /1\.6\.1/, 'no reason quotes the version')
  h.state.version = '1.6.2'
  const result = await h.run(`${SEED_COMPLETIONS} confirm`)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /differs from the preview/)
  assert.equal(h.edits.length, 0)
})

test('real OpenRouter shape: four groups, image and classifier entries, an id shared by a chat and an image entry', async () => {
  const entry = (type, group, id, extra = {}) => ({ ...chat(id, group), type, ...extra })
  const catalog = {
    'anthropic-messages': {
      'chat:~anthropic/claude-fable-latest': entry('chat', 'anthropic-messages', '~anthropic/claude-fable-latest'),
      'chat:anthropic/claude-opus-5': entry('chat', 'anthropic-messages', 'anthropic/claude-opus-5'),
    },
    'openai-completions': {
      'chat:openrouter/auto': entry('chat', 'openai-completions', 'openrouter/auto'),
      'chat:deepseek/deepseek-v4': entry('chat', 'openai-completions', 'deepseek/deepseek-v4'),
      'chat:~deepseek/deepseek-flash-latest': entry('chat', 'openai-completions', '~deepseek/deepseek-flash-latest'),
      'chat:google/gemini-4-neon': entry('chat', 'openai-completions', 'google/gemini-4-neon'),
    },
    'openrouter-images': {
      'image:openrouter/auto': entry('image', 'openrouter-images', 'openrouter/auto', { output: ['image'] }),
      'image:black-forest-labs/flux-3-image': entry('image', 'openrouter-images', 'black-forest-labs/flux-3-image'),
    },
    'typesafe-system-one': {
      'classifier:~liquid/d1-latest': entry('classifier', 'typesafe-system-one', '~liquid/d1-latest'),
    },
  }
  const { protocols, unusable, error } = catalogProtocols(catalog, 'openrouter')
  assert.equal(error, undefined)
  assert.deepEqual([...protocols].sort(), [
    ['openrouter/auto', COMPLETIONS], ['deepseek/deepseek-v4', COMPLETIONS], ['~deepseek/deepseek-flash-latest', COMPLETIONS],
    ['google/gemini-4-neon', COMPLETIONS], ['~anthropic/claude-fable-latest', ANTHROPIC], ['anthropic/claude-opus-5', ANTHROPIC],
  ].sort())
  assert.equal(unusable.size, 0, 'the image entry does not make openrouter/auto ambiguous')
  const served = ['openrouter/auto', 'deepseek/deepseek-v4', '~anthropic/claude-fable-latest', 'black-forest-labs/flux-3-image', '~liquid/d1-latest', 'google/gemini-4-neon', 'gone/old']
  const plan = planSeed(config().providers, 'openrouter', COMPLETIONS, served, protocols, '1.6.1', unusable)
  assert.equal(plan.error, undefined)
  assert.deepEqual(plan.ids, ['openrouter/auto', 'deepseek/deepseek-v4', 'google/gemini-4-neon'])
  assert.deepEqual(plan.leftOut.map((item) => item.id), ['~anthropic/claude-fable-latest', 'black-forest-labs/flux-3-image', '~liquid/d1-latest', 'gone/old'])
  assert.equal(plan.api, COMPLETIONS)
  const several = planSeed(config().providers, 'openrouter', undefined, served, protocols, '1.6.1', unusable)
  assert.match(several.error, /openai-completions \(4\), anthropic-messages \(1\)|openai-completions \(3\), anthropic-messages \(1\)/)
})

test('F1: with a seed-written api, the preview counts channel aliases (ids starting with ~) listed and left out and says to check them', async () => {
  const catalog = rawCatalog({ [COMPLETIONS]: ['a/one', '~x/alias-ok'], [ANTHROPIC]: ['~x/alias-moved'] })
  const h = await started({ catalog, servedIds: ['a/one', '~x/alias-ok', '~x/alias-moved'] })
  const preview = await h.run(SEED_COMPLETIONS)
  assert.equal(preview.kind, 'success', preview.text)
  assert.match(preview.text, /Note: .*channel aliases \(1 listed, 1 left out\)/)
  assert.match(preview.text, /check them after the seed/)
  // No alias, or no protocol filter: no note.
  const plain = await started()
  assert.doesNotMatch((await plain.run(SEED_COMPLETIONS)).text, /channel alias/)
  const noFilter = await started({ catalog: rawCatalog({ [COMPLETIONS]: ['a/one', '~x/alias-ok'] }), servedIds: ['a/one', '~x/alias-ok'] })
  assert.doesNotMatch((await noFilter.run(SEED_ALL)).text, /channel alias/)
})

test('an api argument equal to the route api filters the list but adds no api and says so', async () => {
  const route = config()
  route.providers.openrouter.api = COMPLETIONS
  const h = await started({ current: route })
  const preview = await h.run(SEED_COMPLETIONS)
  assert.match(preview.text, /no api is added \(the route already sets openai-completions\)/)
  const result = await h.run(`${SEED_COMPLETIONS} confirm`)
  assert.equal(result.kind, 'success', result.text)
  assert.match(result.text, /and no api\./)
  assert.match(result.text, /Undo: remove `models` from providers\.openrouter/)
  assert.deepEqual(h.provider.models, ['a/one', 'b/two', 'c/three'].map((id) => ({ id })))
  assert.equal(h.provider.api, COMPLETIONS)
})

test('a seed copies the profile patch beside itself before the edit and names the copy', async () => {
  const home = await mkdtemp(join(tmpdir(), 'model-discovery-home-'))
  try {
    const patchDir = join(home, 'profiles', 'web')
    await mkdir(patchDir, { recursive: true })
    const patch = join(patchDir, 'cordis.patch.yml')
    await writeFile(patch, '# my comments\n- id: llm-pi-ai\n  config:\n    providers: {}\n')
    const h = harness()
    h.state.home = home
    await h.start()
    const preview = await h.run(SEED_COMPLETIONS)
    assert.equal(preview.kind, 'success')
    const result = await h.run(`${SEED_COMPLETIONS} confirm`)
    assert.equal(result.kind, 'success', result.text)
    assert.match(result.text, /Backup of the profile patch: \$DSH_HOME\/profiles\/web\/cordis\.patch\.yml\.bak-model-discovery-/)
    const { readdir } = await import('node:fs/promises')
    const copies = (await readdir(patchDir)).filter((name) => name.startsWith('cordis.patch.yml.bak-model-discovery-'))
    assert.equal(copies.length, 1)
    assert.equal(await readFile(join(patchDir, copies[0]), 'utf8'), '# my comments\n- id: llm-pi-ai\n  config:\n    providers: {}\n')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a seed whose backup cannot be taken still writes, and says so', async () => {
  const home = await mkdtemp(join(tmpdir(), 'model-discovery-home-'))
  try {
    // No profiles/web patch: copyFile fails with ENOENT.
    const h = harness()
    h.state.home = home
    await h.start()
    await h.run(SEED_COMPLETIONS)
    const result = await h.run(`${SEED_COMPLETIONS} confirm`)
    assert.equal(result.kind, 'success', result.text)
    assert.match(result.text, /Backup: none could be taken \(ENOENT\)/)
    assert.equal(h.edits.length, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
