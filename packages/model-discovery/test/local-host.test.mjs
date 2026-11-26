// Host wiring of the local-route sync (plan bd791fa9ddef T2): the command, the pinned probe,
// the shared lock, the edit callback and the automatic poll. Offline: an injected getJson, a
// clock and a fake configEditor over a config object held in memory.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { apply } from '../src/index.host.js'

const LLM = '@deepseek-ai/dsh-llm-pi-ai'
const PIN = 'http://127.0.0.1:8898/v1'
const ORIGINAL_SET_INTERVAL = globalThis.setInterval
const ORIGINAL_CLEAR_INTERVAL = globalThis.clearInterval
after(() => {
  globalThis.setInterval = ORIGINAL_SET_INTERVAL
  globalThis.clearInterval = ORIGINAL_CLEAR_INTERVAL
})

// The real llama.cpp /v1/models shape, as supplied evidence (a labelled fixture, not a capture
// made by this test).
const record = (id, { args = ['--ctx-size', '262144'], context_length, inputs = ['text'], extra = {} } = {}) => ({
  id,
  aliases: [],
  architecture: { input_modalities: inputs },
  can_remove: true,
  context_length,
  created: 1795683077,
  object: 'model',
  owned_by: 'llamacpp',
  source: '/models/x.gguf',
  status: { value: 'unloaded', args },
  tags: [],
  ...extra,
})
const snapshot = (data) => ({ object: 'list', data })

function routeConfig() {
  return {
    keep: true,
    providers: {
      'llamacpp-local': {
        displayName: 'Custom llama.cpp',
        api: 'openai-completions',
        baseURL: PIN,
        models: [
          { id: 'a', contextWindow: 262144, input: ['text', 'image'] },
          { id: 'b', contextWindow: 131072, input: ['text'], reasoningEfforts: { low: 'low' } },
          { id: 'hand-only', contextWindow: 4096 },
        ],
      },
      other: { enabled: true },
    },
  }
}

function harness({ config = {}, current = routeConfig(), home, localRoutes = { 'llamacpp-local': { baseURL: PIN, mode: 'manual' } } } = {}) {
  const commands = []
  const edits = []
  const rows = [{ options: { id: 'llm-pi-ai', name: LLM, config: current }, fiber: { state: 2 } }]
  const editor = {
    entries: () => rows,
    async edit(entry, change) {
      const next = change(structuredClone(entry.options.config), {})
      edits.push(next)
      entry.options.config = next
    },
  }
  const ctx = {
    logger: { warn() {}, error() {} },
    get: (name) => {
      if (name === 'configEditor') return editor
      if (name === 'profileContext' && home !== undefined) return { home }
      return undefined
    },
    inject(names, callback) {
      if (names.includes('commands')) callback({ commands: { register: (command) => commands.push(command) } })
      if (names.includes('configEditor')) callback({ ...editor, effect: (fn) => fn() })
    },
    effect: () => {},
  }
  const calls = []
  let body = snapshot([record('a', { args: ['--ctx-size', '524288', '--n-predict', '4096'] }), record('b'), record('c', { inputs: ['text', 'image'] })])
  // One fake HTTP layer for both paths: fetchJson (the pinned probe) and getJson (npm/unpkg).
  const respond = (url) => {
    calls.push(url)
    if (typeof body === 'function') {
      const direct = url === `${PIN}/models` ? body(url) : body(url)
      return direct
    }
    return body
  }
  const fetch = async (url) => {
    const data = respond(url)
    if (data instanceof Error) throw data
    return { ok: true, headers: new Map([['content-length', String(JSON.stringify(data).length)]]), body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(data))); controller.close() } }) }
  }
  const getJson = async (url) => {
    if (url === `${PIN}/models`) return respond(url)
    calls.push(url)
    const data = respond(url)
    if (data === undefined) throw new Error(`unexpected URL ${url}`)
    return data
  }
  const intervals = []
  const timeouts = []
  globalThis.setInterval = (fn, ms) => {
    const timer = { fn, ms, cleared: false, unref() {} }
    intervals.push(timer)
    return timer
  }
  globalThis.setInterval = globalThis.setInterval
  globalThis.clearInterval = (timer) => { timer.cleared = true }
  // The first automatic run is a setTimeout(fire, 0): capture it so the test drives it, and let
  // the remaining requests settle under the real scheduler.
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms === 0 && typeof fn === 'function') { timeouts.push(fn); return { unref() {} } }
    return realSetTimeout(fn, ms, ...rest)
  }
  const realClearTimeout = globalThis.clearTimeout
  globalThis.clearTimeout = (timer) => { if (timer !== undefined) realClearTimeout(timer) }
  const h = {
    calls, commands, edits, intervals, timeouts, tick: () => intervals[0]?.fn,
    get llm() { return rows[0].options.config },
    get provider() { return rows[0].options.config.providers['llamacpp-local'] },
    setBody: (next) => { body = next },
    run: (input) => commands[0].handler({ rawInput: input }),
    async start() {
      try {
        await apply(ctx, { enabled: true, syncAllowedModels: false, localRoutes, ...config }, { getJson, fetch, now: () => 1000 })
      } finally {
        globalThis.setInterval = ORIGINAL_SET_INTERVAL
        globalThis.clearInterval = ORIGINAL_CLEAR_INTERVAL
        globalThis.setTimeout = realSetTimeout
        globalThis.clearTimeout = realClearTimeout
      }
    },
  }
  return h
}

test('local: a preview reads only the pinned endpoint, writes nothing and names every change', async () => {
  const h = harness()
  await h.start()
  const before = structuredClone(h.llm)
  const result = await h.run('local llamacpp-local')
  assert.equal(result.kind, 'success', result.text)
  assert.deepEqual(h.calls, [`${PIN}/models`], 'no npm and no catalog request')
  assert.equal(h.edits.length, 0)
  assert.deepEqual(h.llm, before)
  assert.match(result.text, /Add \(1\): c/)
  assert.match(result.text, /a 262144 => 524288/)
  assert.match(result.text, /maxTokens \(1\): a 8192 => 4096|maxTokens \(1\): a none => 4096/)
  assert.match(result.text, /Remove \(1\): hand-only/)
  assert.match(result.text, /Backup|backup/)
  assert.match(result.text, /run: \/model-discovery local llamacpp-local confirm/)
})

test('local: confirm writes context, maxTokens, additions and the removal, keeps every other field, and backs the patch up', async () => {
  const home = await mkdtemp(join(tmpdir(), 'model-discovery-local-'))
  try {
    const patchDir = join(home, 'profiles', 'web')
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(patchDir, { recursive: true })
    await writeFile(join(patchDir, 'cordis.patch.yml'), '# comments\n')
    const h = harness({ home })
    await h.start()
    await h.run('local llamacpp-local')
    const result = await h.run('local llamacpp-local confirm')
    assert.equal(result.kind, 'success', result.text)
    const models = h.provider.models
    assert.deepEqual(models.map((m) => m.id), ['a', 'b', 'c'])
    assert.deepEqual(models[0], { id: 'a', contextWindow: 524288, maxTokens: 4096, input: ['text', 'image'] })
    assert.deepEqual(models[1], { id: 'b', contextWindow: 262144, input: ['text'], reasoningEfforts: { low: 'low' } }, 'b follows the server context and keeps its fields; no server cap, so no maxTokens')
    assert.deepEqual(models[2], { id: 'c', contextWindow: 262144, input: ['text', 'image'] })
    assert.equal(h.provider.api, 'openai-completions')
    assert.equal(h.provider.baseURL, PIN)
    assert.deepEqual(h.llm.providers.other, { enabled: true })
    assert.equal(h.llm.keep, true)
    assert.equal(h.edits.length, 1)
    const copies = (await readdir(patchDir)).filter((name) => name.startsWith('cordis.patch.yml.bak-model-discovery-'))
    assert.equal(copies.length, 1)
    assert.match(await readFile(join(patchDir, copies[0]), 'utf8'), /# comments/)
    assert.match(result.text, /Backup of the profile patch/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('local: confirm without a preview changes nothing, and a preview is used once', async () => {
  const h = harness()
  await h.start()
  const none = await h.run('local llamacpp-local confirm')
  assert.equal(none.kind, 'error')
  assert.match(none.text, /no preview/)
  assert.equal(h.edits.length, 0)
  await h.run('local llamacpp-local')
  const first = await h.run('local llamacpp-local confirm')
  assert.equal(first.kind, 'success', first.text)
  const second = await h.run('local llamacpp-local confirm')
  assert.equal(second.kind, 'error')
  assert.equal(h.edits.length, 1)
})

test('local: a server answer that changed since the preview refuses the write', async () => {
  const h = harness()
  await h.start()
  await h.run('local llamacpp-local')
  h.setBody(snapshot([record('a', { args: ['--ctx-size', '600000'] }), record('b')]))
  const result = await h.run('local llamacpp-local confirm')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /differs from the preview/)
  assert.equal(h.edits.length, 0)
})

test('local: a route that is not pinned, a server error and an empty answer all write nothing', async () => {
  const notPinned = harness({ config: { localRoutes: {} } })
  await notPinned.start()
  const r1 = await notPinned.run('local llamacpp-local')
  assert.equal(r1.kind, 'error')
  assert.equal(notPinned.calls.length, 0, 'refused before any request')
  const down = harness()
  await down.start()
  down.setBody(() => { throw new Error('HTTP 502') })
  const r2 = await down.run('local llamacpp-local')
  assert.equal(r2.kind, 'error')
  assert.equal(down.edits.length, 0)
  const empty = harness()
  await empty.start()
  empty.setBody(snapshot([]))
  const r3 = await empty.run('local llamacpp-local')
  assert.equal(r3.kind, 'error')
  assert.equal(empty.edits.length, 0)
})

test('local: a route whose baseURL drifts from the pin is refused', async () => {
  const current = routeConfig()
  current.providers['llamacpp-local'].baseURL = 'http://127.0.0.1:9999/v1'
  const h = harness({ current })
  await h.start()
  const result = await h.run('local llamacpp-local')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /does not match the pinned/)
  assert.equal(h.edits.length, 0)
})

test('local: an automatic route is polled by the timer and never removes', async () => {
  // The timer serves the catalog provider too; answer its package request so the tick reaches
  // the local half, and point the local route at the same fake.
  const h = harness({ localRoutes: { 'llamacpp-local': { baseURL: PIN, mode: 'auto' } } })
  await h.start()
  assert.equal(h.intervals.length, 1, 'the one refresh timer')
  const tick = h.tick()
  // The timer also runs the catalog sync for the default provider (openai-codex). This fixture
  // serves only the local route, so that request fails; the local run must still happen.
  h.setBody((url) => {
    if (url === `${PIN}/models`) return snapshot([record('a', { args: ['--ctx-size', '524288'] }), record('b'), record('c', { inputs: ['text', 'image'] })])
    if (url.endsWith('/latest')) return { version: '1.6.1' }
    throw new Error(`unexpected URL ${url}`)
  })
  await tick()
  // The local run is chained after the catalog sync, so let its promise settle.
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(h.calls.includes(`${PIN}/models`), 'the local route was probed')
  // a is kept with the new context, b and hand-only stay (absent ids are never removed), c is added
  assert.deepEqual(h.provider.models.map((m) => m.id), ['a', 'b', 'hand-only', 'c'])
  assert.equal(h.provider.models[0].contextWindow, 524288)
})

test('local: a write with no DSH home folder still writes and says no backup was taken', async () => {
  const h = harness()
  await h.start()
  await h.run('local llamacpp-local')
  const result = await h.run('local llamacpp-local confirm')
  assert.equal(result.kind, 'success', result.text)
  assert.match(result.text, /Backup: none could be taken \(.*\)/)
  assert.equal(h.edits.length, 1)
})

test('local: a manual route is never touched by the timer', async () => {
  const h = harness({ localRoutes: { 'llamacpp-local': { baseURL: PIN, mode: 'manual' } } })
  await h.start()
  const before = h.calls.length
  await h.tick()()
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.calls.filter((url) => url === `${PIN}/models`).length, h.calls.slice(0, before).filter((url) => url === `${PIN}/models`).length, 'no probe of a manual route')
  assert.equal(h.edits.length, 0)
})

test('local: the status names the local route and its last outcome', async () => {
  const h = harness({ localRoutes: { 'llamacpp-local': { baseURL: PIN, mode: 'manual' } } })
  await h.start()
  await h.run('local llamacpp-local')
  const status = await h.run('status')
  assert.match(status.text, /Local routes: llamacpp-local \(manual\)/)
  assert.match(status.text, /llamacpp-local: manual, last preview\./)
})
