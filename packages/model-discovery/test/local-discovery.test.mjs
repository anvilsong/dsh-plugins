// Local-route reconciliation: settings, URL pins, llama.cpp snapshots and the plan (plan bd791fa9ddef T1).
// Offline and pure: no fetch, no filesystem, no clock.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clean } from '../src/discovery.js'
import {
  localPrecheck,
  localRoutesOf,
  localSnapshot,
  modelsUrl,
  normalizePin,
  planLocalRoute,
  planSignature,
  splitLocalRoutes,
} from '../src/local-discovery.js'

// The real llama.cpp /v1/models shape, as supplied evidence (not a live capture).
const record = (id, { args = ['--ctx-size', '262144'], context_length, inputs = ['text'], extra = {} } = {}) => ({
  id,
  aliases: [],
  architecture: inputs === undefined ? {} : { input_modalities: inputs },
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

const BASELINE = {
  displayName: 'Custom llama.cpp',
  api: 'openai-completions',
  baseURL: 'http://127.0.0.1:8898/v1',
  models: [
    { id: 'a', contextWindow: 262144, input: ['text', 'image'] },
    { id: 'b', contextWindow: 131072, input: ['text'], reasoningEfforts: { low: 'low' } },
    { id: 'hand-only', contextWindow: 4096 },
  ],
}

// --- settings ---

test('localRoutes defaults to {} and keeps catalog behaviour unchanged', () => {
  assert.deepEqual(localRoutesOf(undefined), {})
  assert.deepEqual(localRoutesOf({}), {})
})

test('localRoutes accepts {baseURL, mode} per provider id and defaults mode to manual', () => {
  const routes = localRoutesOf({ 'llamacpp-local': { baseURL: 'http://127.0.0.1:8898/v1' } })
  assert.deepEqual(routes, { 'llamacpp-local': { baseURL: 'http://127.0.0.1:8898/v1', mode: 'manual' } })
  assert.equal(localRoutesOf({ x: { baseURL: 'http://127.0.0.1:1/v1', mode: 'auto' } }).x.mode, 'auto')
})

test('localRoutes rejects malformed records, unknown keys and bad modes', () => {
  for (const bad of [null, [], 'x', 1]) assert.match(localRoutesOf(bad).error, /localRoutes must be an object/)
  assert.match(localRoutesOf({ X: { baseURL: 'http://127.0.0.1:1/v1' } }).error, /lowercase provider ids/)
  assert.match(localRoutesOf({ a: {} }).error, /baseURL is required/)
  assert.match(localRoutesOf({ a: { baseURL: 'http://127.0.0.1:1/v1', mode: 'always' } }).error, /mode must be manual or auto/)
  assert.match(localRoutesOf({ a: { baseURL: 'http://127.0.0.1:1/v1', extra: 1 } }).error, /only baseURL and mode/)
})

test('localRoutes refuses a route that is also a catalog provider', () => {
  const result = localRoutesOf({ openrouter: { baseURL: 'http://127.0.0.1:1/v1' } }, ['openrouter'])
  assert.match(result.error, /cannot also be a catalog provider/)
})

test('splitLocalRoutes lets providers be empty when a local route exists', () => {
  const both = splitLocalRoutes({ providers: [], localRoutes: { a: { baseURL: 'http://127.0.0.1:1/v1' } } })
  assert.equal(both.error, undefined)
  assert.deepEqual(both.settings.providers, [])
  assert.deepEqual(Object.keys(both.settings.localRoutes), ['a'])
  const none = splitLocalRoutes({ providers: [], localRoutes: {} })
  assert.match(none.error, /providers must be a non-empty array/)
})

// --- URL pins ---

test('a pin accepts canonical dotted loopback literals and [::1] only', () => {
  for (const url of ['http://127.0.0.1:8898/v1', 'https://127.0.0.1:1/v1', 'http://[::1]:8898/v1', 'http://127.5.6.7:9/v1/']) {
    assert.equal(normalizePin(url).error, undefined, url)
  }
  for (const url of [
    'http://localhost:8898/v1', 'http://0.0.0.0:8898/v1', 'http://192.168.1.5:8898/v1', 'http://127.1:8898/v1',
    'http://0x7f.0.0.1:8898/v1', 'http://0177.0.0.1:8898/v1', 'http://[::ffff:127.0.0.1]:8898/v1',
    'ftp://127.0.0.1/v1', 'http://user:pass@127.0.0.1:8898/v1', 'http://127.0.0.1:8898/v1?x=1',
    'http://127.0.0.1:8898/v1#x', 'http://127.0.0.1:8898/v1/../admin', 'http://127.0.0.1:8898/v1/%2e%2e/x',
    'http://127.0.0.1:8898/v1%2f', 'http://127.0.0.1:8898\\v1', 'http://127.0.0.1:8898/', 'http://127.0.0.1/v1', 'http://127.0.0.1/',
    'http://127.0.0.1:8898/v1\u0000', 'not a url', '', undefined, null,
  ]) {
    assert.match(normalizePin(url).error ?? 'accepted', /pin|http|baseURL|path|port|dot/i, String(url))
  }
})

test('the pin normalizes only a trailing slash and the provider baseURL must match it', () => {
  assert.equal(normalizePin('http://127.0.0.1:8898/v1/').pin, 'http://127.0.0.1:8898/v1')
  assert.equal(normalizePin('http://127.0.0.1:8898/v1').pin, 'http://127.0.0.1:8898/v1')
  const pin = normalizePin('http://127.0.0.1:8898/v1').pin
  assert.equal(normalizePin('http://127.0.0.1:8898/v2').pin !== pin, true)
})

test('modelsUrl appends /models to the pinned prefix', () => {
  assert.equal(modelsUrl('http://127.0.0.1:8898/v1'), 'http://127.0.0.1:8898/v1/models')
  assert.equal(modelsUrl('http://127.0.0.1:8898/v1/'), 'http://127.0.0.1:8898/v1/models')
})

// --- preconditions ---

const route = (over = {}) => ({ ...BASELINE, ...over })
const precheck = (provider = 'llamacpp-local', over = {}) => localPrecheck(provider, 'http://127.0.0.1:8898/v1', provider === 'x' ? undefined : route(over))

test('preconditions: the route must match the pin and speak openai-completions with a list', () => {
  assert.match(precheck('x').error, /not found/)
  assert.match(precheck('llamacpp-local', { baseURL: 'http://127.0.0.1:9999/v1' }).error, /baseURL .*does not match the pinned/)
  assert.match(precheck('llamacpp-local', { api: 'anthropic-messages' }).error, /api must be openai-completions/)
  assert.match(precheck('llamacpp-local', { api: undefined }).error, /api must be openai-completions/)
  assert.match(precheck('llamacpp-local', { models: [] }).error, /no models list/)
  assert.match(precheck('llamacpp-local', { models: undefined }).error, /no models list/)
  assert.match(precheck('llamacpp-local', { modelOverrides: {} }).error, /modelOverrides/)
})

test('preconditions refuse duplicate ids, invalid ids and per-model routing overrides', () => {
  const base = BASELINE.models
  assert.match(precheck('llamacpp-local', { models: [...base, { id: 'a' }] }).error, /duplicate/)
  assert.match(precheck('llamacpp-local', { models: [{ id: 'bad id' }] }).error, /unsupported characters/)
  assert.match(precheck('llamacpp-local', { models: [{ id: 'a', api: 'openai-responses' }] }).error, /per-model api/)
  assert.match(precheck('llamacpp-local', { models: [{ id: 'a', baseURL: 'http://127.0.0.1:2/v1' }] }).error, /per-model baseURL/)
})

// --- snapshot ---

test('a snapshot needs a non-empty data array of unique records', () => {
  assert.match(localSnapshot(undefined, 'p').error, /not an object/)
  assert.match(localSnapshot({ data: [] }, 'p').error, /no models/)
  assert.match(localSnapshot({ data: 'x' }, 'p').error, /data/)
  assert.match(localSnapshot(snapshot([record('a'), record('a')]), 'p').error, /duplicate/)
  assert.match(localSnapshot(snapshot([{ context_length: 1 }]), 'p').error, /id/)
  const big = snapshot(Array.from({ length: 2001 }, (_, i) => record(`m${i}`)))
  assert.match(localSnapshot(big, 'p').error, /more than 2000/)
  assert.equal(localSnapshot(snapshot(Array.from({ length: 2000 }, (_, i) => record(`m${i}`))), 'p').error, undefined)
})

test('identity is the id only: aliases, can_remove, status and tags do not decide membership', () => {
  const weird = record('a', { extra: { aliases: ['other'], can_remove: false, tags: ['x'], status: { value: 'error', args: ['--ctx-size', '1024'] } } })
  const parsed = localSnapshot(snapshot([weird]), 'p')
  assert.equal(parsed.error, undefined)
  assert.deepEqual(parsed.models.map((m) => m.id), ['a'])
  assert.equal(parsed.models[0].contextWindow, 1024)
})

test('an unloaded model is present', () => {
  const parsed = localSnapshot(snapshot([record('a', { extra: { status: { value: 'unloaded', args: ['--ctx-size', '4096'] } } })]), 'p')
  assert.deepEqual(parsed.models.map((m) => m.id), ['a'])
})

test('a malformed record fails the whole snapshot, never a truncated subset', () => {
  assert.match(localSnapshot({ data: [record('a'), { object: 'model' }] }, 'p').error, /entry 1/)
  assert.match(localSnapshot({ data: {} }, 'p').error, /data/)
  assert.match(localSnapshot({ data: [record('a'), null] }, 'p').error, /object/)
})

// --- context ---

const ctx = (entry) => localSnapshot(snapshot([entry]), 'p')

test('context comes from one --ctx-size, else from context_length', () => {
  assert.equal(ctx(record('a', { args: ['--ctx-size', '8192'] })).models[0].contextWindow, 8192)
  assert.equal(ctx(record('a', { args: ['--ctx-size=8192'] })).models[0].contextWindow, 8192)
  assert.equal(ctx(record('a', { args: ['--port', '0'], context_length: 4096 })).models[0].contextWindow, 4096)
})

test('--ctx-size is the authority; a lower context_length only produces a note', () => {
  const parsed = ctx(record('a', { args: ['--ctx-size', '524288'], context_length: 262144 }))
  assert.equal(parsed.error, undefined)
  assert.equal(parsed.models[0].contextWindow, 524288)
  assert.match(parsed.models[0].contextNote, /524288.*262144|262144.*524288/)
  const reversed = ctx(record('a', { args: ['--ctx-size', '262144'], context_length: 524288 }))
  assert.equal(reversed.models[0].contextWindow, 262144)
})

test('--n-predict becomes maxTokens; -1 and 0 mean no limit and an absent flag means none', () => {
  assert.equal(ctx(record('a', { args: ['--ctx-size', '8192', '--n-predict', '4096'] })).models[0].maxTokens, 4096)
  assert.equal(ctx(record('a', { args: ['--ctx-size', '8192', '--n-predict=512'] })).models[0].maxTokens, 512)
  assert.equal(ctx(record('a', { args: ['--ctx-size', '8192', '--n-predict', '-1'] })).models[0].maxTokens, undefined)
  assert.equal(ctx(record('a', { args: ['--ctx-size', '8192', '--n-predict', '0'] })).models[0].maxTokens, undefined)
  assert.equal(ctx(record('a', { args: ['--ctx-size', '8192'] })).models[0].maxTokens, undefined)
})

test('a malformed or repeated --n-predict fails the snapshot, and one above the context is refused', () => {
  for (const args of [['--ctx-size', '8192', '--n-predict', 'x'], ['--ctx-size', '8192', '--n-predict', '1.5'],
    ['--ctx-size', '8192', '--n-predict', '100', '--n-predict', '200'], ['--ctx-size', '8192', '--n-predict', '99999']]) {
    const parsed = ctx(record('a', { args }))
    assert.match(parsed.error ?? 'accepted', /n-predict/, JSON.stringify(args))
  }
})

test('a malformed, repeated or ambiguous context flag fails the snapshot', () => {
  for (const args of [
    ['--ctx-size', '0'], ['--ctx-size', '-1'], ['--ctx-size', '1.5'], ['--ctx-size', 'nope'], ['--ctx-size'],
    ['--ctx-size', '100', '--ctx-size', '200'], ['--ctx-size=100', '--ctx-size', '200'], ['-c', '4096'],
    ['--ctx-size', String(Number.MAX_SAFE_INTEGER + 2)],
  ]) {
    const parsed = ctx(record('a', { args, context_length: 4096 }))
    assert.match(parsed.error ?? 'accepted', /ctx-size|context/, JSON.stringify(args))
  }
})

test('a model with no usable context fails the snapshot', () => {
  assert.match(ctx(record('a', { args: [] })).error, /context/)
  assert.match(ctx(record('a', { args: [], context_length: 0 })).error, /context/)
})

test('input modalities are text plus image only when the server advertises image', () => {
  assert.deepEqual(ctx(record('a', { inputs: ['text', 'image'] })).models[0].input, ['text', 'image'])
  assert.deepEqual(ctx(record('a', { inputs: ['text'] })).models[0].input, ['text'])
  assert.deepEqual(ctx(record('a', { inputs: undefined })).models[0].input, ['text'])
  assert.deepEqual(ctx(record('a', { inputs: ['image'] })).models[0].input, ['text', 'image'])
})

// --- plans ---

const live = (...entries) => localSnapshot(snapshot(entries), 'llamacpp-local').models

test('a manual plan adds, updates context, removes absent ids and preserves survivors', () => {
  const models = live(
    record('a', { args: ['--ctx-size', '300000'] }),
    record('b', { args: ['--ctx-size', '131072'] }),
    record('c', { args: ['--ctx-size', '1024'], inputs: ['text', 'image'] }),
  )
  const plan = planLocalRoute({ provider: 'llamacpp-local', pin: 'http://127.0.0.1:8898/v1', mode: 'manual', route: route(), models })
  assert.equal(plan.error, undefined)
  assert.deepEqual(plan.added, ['c'])
  assert.deepEqual(plan.removed, ['hand-only'])
  assert.deepEqual(plan.contextChanges, [{ id: 'a', from: 262144, to: 300000 }])
  assert.deepEqual(plan.route.models.map((m) => m.id), ['a', 'b', 'c'])
  assert.equal(plan.route.models[0].contextWindow, 300000)
  // every other field of a survivor is kept exactly
  assert.deepEqual(plan.route.models[1], { id: 'b', contextWindow: 131072, input: ['text'], reasoningEfforts: { low: 'low' } })
  assert.deepEqual(plan.route.models[2], { id: 'c', contextWindow: 1024, input: ['text', 'image'] })
  // the input is never mutated
  assert.deepEqual(BASELINE.models.map((m) => m.id), ['a', 'b', 'hand-only'])
})

test('an automatic plan never removes: absent ids become pending removals', () => {
  const models = live(record('a', { args: ['--ctx-size', '300000'] }))
  const plan = planLocalRoute({ provider: 'llamacpp-local', pin: 'http://127.0.0.1:8898/v1', mode: 'auto', route: route(), models })
  assert.deepEqual(plan.removed, [])
  assert.deepEqual(plan.pendingRemovals, ['b', 'hand-only'])
  assert.deepEqual(plan.route.models.map((m) => m.id), ['a', 'b', 'hand-only'])
  assert.deepEqual(plan.contextChanges, [{ id: 'a', from: 262144, to: 300000 }])
})

test('new ids are appended in response order and survivors keep their relative order', () => {
  const models = live(record('b'), record('z'), record('a'), record('y'))
  const plan = planLocalRoute({ provider: 'llamacpp-local', pin: 'http://127.0.0.1:8898/v1', mode: 'manual', route: route(), models })
  assert.deepEqual(plan.route.models.map((m) => m.id), ['a', 'b', 'z', 'y'])
})

test('a route is never left with an empty list and a re-applied snapshot is a no-op', () => {
  const one = live(record('a'))
  const first = planLocalRoute({ provider: 'llamacpp-local', pin: 'http://127.0.0.1:8898/v1', mode: 'manual', route: route(), models: one })
  assert.equal(first.error, undefined)
  const second = planLocalRoute({ provider: 'llamacpp-local', pin: 'http://127.0.0.1:8898/v1', mode: 'manual', route: first.route, models: one })
  assert.equal(second.changed, false)
  assert.deepEqual(second.route, first.route)
})

test('an automatic plan keeps absent ids and appends new ones; a manual plan drops them once the server serves some listed id', () => {
  // The server serves one listed id (b) and one it never listed (c).
  const models = live(record('b'), record('c'))
  const base = route({ models: [{ id: 'a', contextWindow: 1 }, { id: 'b', contextWindow: 2 }] })
  const call = (mode, r = base) => planLocalRoute({ provider: 'llamacpp-local', pin: 'http://127.0.0.1:8898/v1', mode, route: r, models })
  const auto = call('auto')
  assert.equal(auto.error, undefined)
  assert.deepEqual(auto.removed, [])
  assert.deepEqual(auto.pendingRemovals, ['a'])
  assert.deepEqual(auto.route.models.map((m) => m.id), ['a', 'b', 'c'])
  const manual = call('manual')
  assert.equal(manual.error, undefined)
  assert.deepEqual(manual.removed, ['a'])
  assert.deepEqual(manual.pendingRemovals, ['a'])
  assert.deepEqual(manual.route.models.map((m) => m.id), ['b', 'c'])

  // When NO listed id survives, a manual plan has nothing to keep and is refused.
  const none = call('manual', route({ models: [{ id: 'a', contextWindow: 1 }, { id: 'd', contextWindow: 1 }] }))
  assert.match(none.error, /would empty the models list/)
})

test('a manual plan that would write an empty list is refused', () => {
  // Both listed ids are absent and the server serves neither, so there is nothing to append:
  // the list would be empty.
  const only = planLocalRoute({ provider: 'llamacpp-local', pin: 'http://127.0.0.1:8898/v1', mode: 'manual', route: route({ models: [{ id: 'x', contextWindow: 1 }, { id: 'y', contextWindow: 1 }] }), models: live(record('z')) })
  assert.match(only.error, /would empty the models list/)
  assert.equal(only.route, undefined, 'nothing is proposed')
})

test('a proposed context below an explicit maxTokens is refused, not applied', () => {
  const models = live(record('a', { args: ['--ctx-size', '1000'] }))
  const plan = planLocalRoute({ provider: 'llamacpp-local', pin: 'http://127.0.0.1:8898/v1', mode: 'manual', route: route({ models: [{ id: 'a', maxTokens: 4096 }] }), models })
  assert.match(plan.error, /maxTokens/)
})

test('a context warning is carried into the plan', () => {
  const models = live(record('a', { args: ['--ctx-size', '524288'], context_length: 262144 }))
  const plan = planLocalRoute({ provider: 'llamacpp-local', pin: 'http://127.0.0.1:8898/v1', mode: 'manual', route: route(), models })
  assert.ok(plan.warnings.some((w) => /a:/.test(w) && /524288/.test(w) && /262144/.test(w)))
  assert.equal(plan.contextChanges.length, 1)
  assert.equal(plan.contextChanges[0].to, 524288)
})

test('maxTokens is written only when the server states one, and is kept otherwise', () => {
  const listed = route({ models: [{ id: 'a', contextWindow: 262144, maxTokens: 8192 }, { id: 'b', contextWindow: 262144 }] })
  // a: the server states 4096; b: the server states nothing, so b keeps no cap
  const models = live(record('a', { args: ['--ctx-size', '524288', '--n-predict', '4096'] }), record('b', { args: ['--ctx-size', '524288'] }))
  const plan = planLocalRoute({ provider: 'llamacpp-local', pin: 'http://127.0.0.1:8898/v1', mode: 'manual', route: listed, models })
  assert.equal(plan.error, undefined)
  assert.deepEqual(plan.maxTokensChanges, [{ id: 'a', from: 8192, to: 4096 }])
  assert.equal(plan.route.models[0].maxTokens, 4096)
  assert.equal(plan.route.models[1].maxTokens, undefined, 'no server cap means the user cap stays absent')
  // with no server cap at all, a user-set cap survives untouched
  const quiet = planLocalRoute({ provider: 'llamacpp-local', pin: 'http://127.0.0.1:8898/v1', mode: 'manual', route: listed, models: live(record('a', { args: ['--ctx-size', '524288'] }), record('b', { args: ['--ctx-size', '524288'] })) })
  assert.equal(quiet.route.models[0].maxTokens, 8192)
  assert.deepEqual(quiet.maxTokensChanges, [])
})

test('the plan signature changes with the target image and with the source data, not with unrelated fields', () => {
  const models = live(record('a', { args: ['--ctx-size', '300000'] }), record('b'))
  const plan = planLocalRoute({ provider: 'llamacpp-local', pin: 'http://127.0.0.1:8898/v1', mode: 'manual', route: route(), models })
  const same = planLocalRoute({ provider: 'llamacpp-local', pin: 'http://127.0.0.1:8898/v1', mode: 'manual', route: route(), models })
  assert.equal(planSignature(plan), planSignature(same))
  const other = planLocalRoute({ provider: 'llamacpp-local', pin: 'http://127.0.0.1:8898/v1', mode: 'manual', route: route(), models: live(record('a', { args: ['--ctx-size', '300001'] }), record('b')) })
  assert.notEqual(planSignature(plan), planSignature(other))
  const extra = planLocalRoute({ provider: 'llamacpp-local', pin: 'http://127.0.0.1:8898/v1', mode: 'manual', route: route(), models: live(record('a', { args: ['--ctx-size', '300000'], extra: { tags: ['other'], source: '/elsewhere' } }), record('b')) })
  assert.equal(planSignature(plan), planSignature(extra))
})

test('clean still strips control characters from anything the module reports', () => {
  assert.equal(clean('a\nb', 10), 'a b')
})
