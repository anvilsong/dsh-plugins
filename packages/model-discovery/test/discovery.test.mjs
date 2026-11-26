import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clean,
  latestCatalogUrl,
  mapCatalog,
  mapEfforts,
  MAX_MODELS_PER_SYNC,
  mergeAllowedModels,
  mergeConfig,
  planProvider,
  providerCatalogUrl,
  resolveSettings,
  seedPrecheck,
  statusText,
} from '../src/discovery.js'

const GROUP = 'openai-codex-responses'
const astra = {
  id: 'gpt-6.2-astra', name: 'GPT-6.2 Astra', api: GROUP, provider: 'openai-codex',
  baseUrl: 'https://chatgpt.com/backend-api', reasoning: true, input: ['text', 'image'],
  cost: { input: 8, output: 40 }, contextWindow: 272000, maxTokens: 128000,
  thinkingLevelMap: { off: null, low: 'low', high: 'high', xhigh: 'xhigh', max: 'max', future: 'future' },
  compat: { supportsMidConvoSystemMessages: true, supportsToolSearch: true }, type: 'chat',
  inputLimits: { image: 10 },
}
const terra = {
  ...astra, id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', contextWindow: 500000,
  thinkingLevelMap: { off: 'none', low: 'low', high: 'high', xhigh: 'xhigh', max: 'max' },
}
const catalogOf = (...models) => mapCatalog({ [GROUP]: Object.fromEntries(models.map((model) => [`chat:${model.id}`, model])) }, 'openai-codex')

// pi-ai 1.3.0 getSupportedThinkingLevels (dist/models.js) and DSH 0.2.2
// resolveModelReasoning (dsh-llm-pi-ai/src/catalog.ts), restated so the test
// shows the mapping offers the same levels pi-ai offers for the upstream map.
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const piAiLevels = (map) => LEVELS.filter((level) => {
  const mapped = map[level]
  if (mapped === null) return false
  if (level === 'xhigh' || level === 'max') return mapped !== undefined
  return true
})
const dshLevels = (efforts) => LEVELS.filter((level) => Object.hasOwn(efforts, level))
const piAiWire = (map, level) => map[level] ?? level
const dshWire = (efforts, level) => efforts[level] ?? level

test('mapCatalog copies only id, name, contextWindow, input and reasoningEfforts', () => {
  const { models, issues, apis } = catalogOf(astra)
  assert.equal(issues.length, 0)
  // maxTokens is NOT copied: in DSH an entry's maxTokens is also that model's default per-request
  // output cap, so copying the upstream capability would ask for it on every turn.
  assert.deepEqual(models, [{
    id: 'gpt-6.2-astra', name: 'GPT-6.2 Astra', contextWindow: 272000,
    input: ['text', 'image'],
    reasoningEfforts: { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  }])
  for (const field of ['compat', 'cost', 'api', 'baseUrl', 'type', 'inputLimits', 'provider', 'thinkingLevelMap']) {
    assert.equal(Object.hasOwn(models[0], field), false, field)
  }
  assert.equal(apis.get('gpt-6.2-astra'), GROUP)
})

const efforts = (map, api = GROUP) => mapEfforts(map, api).efforts

test('the real sparse pi-ai 1.3.0 Codex maps keep every level pi-ai offers', () => {
  // gpt-5.5 / gpt-5.3-codex-spark and gpt-5.6-* in pi-ai 1.3.0 openai-codex.json.
  for (const map of [{ xhigh: 'xhigh', minimal: 'low' }, { xhigh: 'xhigh', max: 'max', minimal: 'low' }]) {
    const mapped = efforts(map)
    assert.deepEqual(dshLevels(mapped), piAiLevels(map))
    for (const level of piAiLevels(map).filter((name) => name !== 'off')) {
      assert.equal(dshWire(mapped, level), piAiWire(map, level), level)
    }
    // An absent upstream off stays "supported, send pi-ai's default" in DSH.
    assert.equal(mapped.off, null)
  }
  assert.deepEqual(efforts({ xhigh: 'xhigh', minimal: 'low' }), {
    off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh',
  })
  for (const api of ['openai-responses', 'azure-openai-responses']) {
    assert.deepEqual(dshLevels(efforts({ xhigh: 'xhigh' }, api)), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])
  }
})

test('a sparse map is refused on protocols where an absent level is not the level name', () => {
  // Anthropic and Bedrock send "low" for an absent minimal; Mistral falls back to "high".
  for (const api of ['anthropic-messages', 'bedrock-converse-stream', 'mistral-conversations', 'openai-completions', 'pi-messages']) {
    const result = mapEfforts({ low: 'low', high: 'high', xhigh: 'xhigh' }, api)
    assert.equal(result.efforts, undefined)
    assert.match(result.error, /DSH cannot express/)
    // A map that states every base level is exact on any protocol.
    const full = mapEfforts({ minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: null }, api)
    assert.deepEqual(dshLevels(full.efforts), ['off', 'minimal', 'low', 'medium', 'high'])
  }
  const { models, issues } = mapCatalog({ 'anthropic-messages': { 'chat:c': {
    ...astra, id: 'c', api: 'anthropic-messages', provider: 'anthropic', thinkingLevelMap: { xhigh: 'xhigh' },
  } } }, 'anthropic')
  assert.equal(models.length, 0)
  assert.match(issues[0].reason, /leaves minimal to pi-ai's anthropic-messages default/)
})

test('full and null-bearing maps match pi-ai: null stays unsupported, strings are copied', () => {
  for (const map of [astra.thinkingLevelMap, terra.thinkingLevelMap,
    { off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }]) {
    assert.deepEqual(dshLevels(efforts(map)), piAiLevels(map))
  }
  assert.equal(Object.hasOwn(efforts({ off: null, high: 'high' }), 'off'), false)
  assert.equal(efforts({ off: 'none', high: 'high' }).off, 'none')
  assert.equal(Object.hasOwn(efforts({ future: 'future' }), 'future'), false)
})

test('string wire values are kept and unknown levels are ignored', () => {
  const { models } = catalogOf(terra)
  assert.deepEqual(models[0].reasoningEfforts, {
    off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
  })
})

test('malformed wire values are treated as unsupported', () => {
  const mapped = efforts({ low: '', medium: 'bad value\n', high: 42, xhigh: 'x'.repeat(65) })
  assert.deepEqual(dshLevels(mapped), ['off', 'minimal'])
})

test('a reasoning model offering nothing beyond off is skipped', () => {
  const offOnly = catalogOf({ ...astra, id: 'off-only', thinkingLevelMap: { off: 'none', minimal: null, low: null, medium: null, high: null } })
  assert.equal(offOnly.models.length, 0)
  assert.match(offOnly.issues[0].reason, /no supported level besides off/)
})

test('a reasoning model without a thinking map is refused rather than made non-reasoning', () => {
  const { models, issues } = catalogOf({ ...astra, thinkingLevelMap: undefined })
  assert.equal(models.length, 0)
  assert.match(issues[0].reason, /needs thinkingLevelMap/)
})

test('unsupported modalities are dropped without discarding text and image', () => {
  const { models } = catalogOf({ ...astra, input: ['text', 'image', 'video'] })
  assert.deepEqual(models[0].input, ['text', 'image'])
})

test('a model with no supported modality is skipped with a reason', () => {
  const { models, issues } = catalogOf({ ...astra, input: ['video'] })
  assert.equal(models.length, 0)
  assert.match(issues[0].reason, /no supported input modality/)
})

test('model ids must be 1-128 plain characters; the catalog key is never used as an id', () => {
  const ids = ['', 'a'.repeat(129), 'has space', 'line\nbreak', 'mark\u202edown']
  const { models, issues } = mapCatalog({ [GROUP]: {
    ...Object.fromEntries(ids.map((id, index) => [`chat:${index}`, { ...astra, id }])),
    'chat:no-id': { ...astra, id: undefined },
    'chat:cf': { ...astra, id: 'workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
    'chat:long-ok': { ...astra, id: 'a'.repeat(128) },
  } }, 'openai-codex')
  assert.deepEqual(models.map((model) => model.id), ['workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'a'.repeat(128)])
  assert.equal(issues.length, ids.length + 1)
  assert.ok(issues.every((issue) => /id is missing/.test(issue.reason)))
  assert.ok(issues.every((issue) => !/[\n\u202e]/.test(issue.id)))
})

test('names are capped at 120 characters and control characters are removed', () => {
  const { models } = catalogOf({ ...astra, name: `Evil\u0000\u001b[31m\u202e${'n'.repeat(300)}` })
  assert.ok(models[0].name.length <= 120)
  assert.doesNotMatch(models[0].name, /[\u0000-\u001f\u202e]/)
  const blank = catalogOf({ ...astra, name: '\u0000\u0001' })
  assert.equal(blank.models[0].name, 'gpt-6.2-astra')
})

test('malformed, non-chat and mismatched models are skipped with per-model reasons', () => {
  const { models, issues } = mapCatalog({ [GROUP]: {
    badHttp: { ...astra, id: 'bad-http', baseUrl: 'http://example.test' },
    wrongProvider: { ...astra, id: 'wrong-provider', provider: 'other' },
    wrongType: { ...astra, id: 'wrong-type', type: 'embedding' },
    badWindow: { ...astra, id: 'bad-window', contextWindow: 0 },
    badTokens: { ...astra, id: 'bad-tokens', maxTokens: 1.5 },
    wrongApi: { ...astra, id: 'wrong-api', api: 'openai-responses' },
    badReasoning: { ...astra, id: 'bad-reasoning', reasoning: 'yes' },
  } }, 'openai-codex')
  assert.equal(models.length, 0)
  assert.equal(issues.length, 7)
  for (const pattern of [/https/, /expected openai-codex/, /unsupported model type/, /contextWindow/, /maxTokens/,
    /does not match its catalog group/, /reasoning must be a boolean/]) {
    assert.ok(issues.some((issue) => pattern.test(issue.reason)), String(pattern))
  }
})

test('duplicate ids do not produce duplicate entries', () => {
  const { models, issues } = mapCatalog({ [GROUP]: { a: astra, b: astra } }, 'openai-codex')
  assert.equal(models.length, 1)
  assert.equal(issues.filter((issue) => issue.reason === 'duplicate model id').length, 1)
})

test('a non-chat entry that shares an id with a chat model does not hide the chat model', () => {
  const classifier = { ...astra, id: 'shared', type: 'classifier' }
  const chat = { ...astra, id: 'shared' }
  // The classifier comes first in the file, as in pi-ai's openai catalog.
  const { models, issues } = mapCatalog({ [GROUP]: { 'classifier:shared': classifier, 'chat:shared': chat } }, 'openai-codex')
  assert.deepEqual(models.map((model) => model.id), ['shared'])
  assert.equal(issues.filter((issue) => issue.reason === 'duplicate model id').length, 0)
  assert.equal(issues.filter((issue) => /unsupported model type/.test(issue.reason)).length, 1)
})

test('a __proto__ catalog key cannot pollute prototypes', () => {
  const raw = JSON.parse(`{"__proto__":{"chat:p":${JSON.stringify({ ...astra, id: 'p', api: '__proto__', reasoning: false })}}}`)
  const { models } = mapCatalog(raw, 'openai-codex')
  assert.deepEqual(models.map((model) => model.id), ['p'])
  assert.equal(({}).p, undefined)
  assert.equal(({})['chat:p'], undefined)
})

test('planProvider appends only missing ids and preserves existing entries and provider fields', () => {
  const providers = { 'openai-codex': { apiKeyEnv: 'KEY', models: [{ id: 'gpt-6.2-astra', name: 'mine', custom: true }] } }
  const plan = planProvider(providers, 'openai-codex', catalogOf(astra, terra))
  assert.deepEqual(plan.added, ['gpt-6.1-terra'])
  assert.deepEqual(plan.provider.models[0], providers['openai-codex'].models[0])
  assert.equal(plan.provider.apiKeyEnv, 'KEY')
  assert.equal(plan.provider.models.length, 2)
  assert.equal(providers['openai-codex'].models.length, 1, 'the input is not mutated')
})

test('planProvider never converts a provider that serves the installed catalog', () => {
  for (const current of [{ apiKeyEnv: 'KEY' }, { models: [] }, { modelOverrides: { 'gpt-6.2-astra': { name: 'x' } } }]) {
    const plan = planProvider({ 'openai-codex': current }, 'openai-codex', catalogOf(astra))
    assert.match(plan.error, /serves pi-ai's installed catalog; list its models explicitly first/)
    assert.equal(plan.provider, undefined)
  }
})

test('planProvider never creates a provider or replaces a malformed providers setting', () => {
  assert.match(planProvider(undefined, 'openai-codex', catalogOf(astra)).error, /openai-codex is not configured/)
  assert.match(planProvider({ other: { models: [{ id: 'x' }] } }, 'openai-codex', catalogOf(astra)).error, /not configured/)
  assert.match(planProvider([{ provider: 'openai-codex' }], 'openai-codex', catalogOf(astra)).error, /providers setting is not an object/)
  assert.match(planProvider({ 'openai-codex': null }, 'openai-codex', catalogOf(astra)).error, /is not an object/)
  assert.match(planProvider({ 'openai-codex': { models: { old: {} } } }, 'openai-codex', catalogOf(astra)).error, /not an array/)
})

test('planProvider only adds models of the protocol DSH will use for the provider', () => {
  const raw = { [GROUP]: { 'chat:a': { ...astra, id: 'a' }, 'chat:b': { ...astra, id: 'b' } },
    'openai-responses': { 'chat:c': { ...astra, id: 'c', api: 'openai-responses' } } }
  const catalog = mapCatalog(raw, 'openai-codex')
  // Listed models show the protocol.
  let plan = planProvider({ 'openai-codex': { models: [{ id: 'a' }] } }, 'openai-codex', catalog)
  assert.deepEqual(plan.added, ['b'])
  assert.ok(plan.skipped.some((line) => /c: upstream api openai-responses differs/.test(line)))
  // The provider's own api setting wins.
  plan = planProvider({ 'openai-codex': { api: 'openai-responses', models: [{ id: 'a' }] } }, 'openai-codex', catalog)
  assert.deepEqual(plan.added, ['c'])
  // Nothing shows the protocol and the catalog mixes protocols: add nothing.
  plan = planProvider({ 'openai-codex': { models: [{ id: 'custom' }] } }, 'openai-codex', catalog)
  assert.deepEqual(plan.added, [])
  assert.equal(plan.skipped.length, 3)
})

test('planProvider adds nothing when the models you list span several protocols', () => {
  const raw = { [GROUP]: { 'chat:a': { ...astra, id: 'a' }, 'chat:new-codex': { ...astra, id: 'new-codex' } },
    'openai-responses': { 'chat:b': { ...astra, id: 'b', api: 'openai-responses' }, 'chat:new-resp': { ...astra, id: 'new-resp', api: 'openai-responses' } } }
  const catalog = mapCatalog(raw, 'openai-codex')
  const plan = planProvider({ 'openai-codex': { models: [{ id: 'a' }, { id: 'b' }] } }, 'openai-codex', catalog)
  assert.deepEqual(plan.added, [])
  assert.equal(plan.skipped.length, 2)
  assert.ok(plan.skipped.every((line) => /cannot be determined/.test(line)))
})

test(`planProvider adds at most ${MAX_MODELS_PER_SYNC} models per sync`, () => {
  const many = Array.from({ length: MAX_MODELS_PER_SYNC + 25 }, (_, index) => ({ ...astra, id: `m-${index}` }))
  const plan = planProvider({ 'openai-codex': { models: [{ id: 'm-0' }] } }, 'openai-codex', catalogOf(...many))
  assert.equal(plan.added.length, MAX_MODELS_PER_SYNC)
  assert.equal(plan.deferred, 24)
  assert.ok(plan.skipped.some((line) => /24 more new openai-codex models wait/.test(line)))
})

test('mergeConfig preserves top-level fields and every other provider, and refuses a malformed providers value', () => {
  const current = { otherSetting: true, providers: { other: { enabled: true }, 'openai-codex': { models: [{ id: 'a' }] } } }
  const next = mergeConfig(current, 'openai-codex', { models: [{ id: 'a' }, { id: 'new' }] })
  assert.equal(next.otherSetting, true)
  assert.deepEqual(next.providers.other, { enabled: true })
  assert.equal(next.providers['openai-codex'].models.length, 2)
  assert.equal(current.providers['openai-codex'].models.length, 1, 'the input is not mutated')
  assert.throws(() => mergeConfig({ providers: [{ provider: 'openai' }] }, 'openai-codex', {}), /not an object/)
  assert.throws(() => mergeConfig({}, 'openai-codex', {}), /not an object/)
})

test('allowed-model merge adds only missing routes for the given ids and preserves others', () => {
  const current = [
    { provider: 'openai-codex', model: 'gpt-6-astra' },
    { provider: 'anthropic', model: 'claude-sonnet-5-5' },
  ]
  const result = mergeAllowedModels(current, 'openai-codex', ['gpt-6-astra', 'gpt-6.2-astra', 'gpt-6.2-astra'])
  assert.deepEqual(result.added, ['gpt-6.2-astra'])
  assert.deepEqual(result.allowedModels.slice(0, 2), current)
  assert.deepEqual(result.allowedModels[2], { provider: 'openai-codex', model: 'gpt-6.2-astra' })
  assert.deepEqual(mergeAllowedModels(undefined, 'openai-codex', ['a']).allowedModels, [{ provider: 'openai-codex', model: 'a' }])
  assert.equal(mergeAllowedModels({}, 'openai-codex', []).error, 'allowedModels is not an array')
})

test('settings have safe defaults and reject invalid values', () => {
  const defaults = resolveSettings()
  assert.equal(defaults.settings.enabled, true)
  assert.equal(defaults.settings.syncAllowedModels, false)
  assert.deepEqual(defaults.settings.providers, ['openai-codex'])
  assert.equal(defaults.settings.refreshMs, 21600000)
  assert.equal(defaults.settings.timeoutMs, 15000)
  assert.equal(resolveSettings(null).error, 'config must be an object')
  assert.equal(resolveSettings([]).error, 'config must be an object')
  assert.equal(resolveSettings({ enabled: 'yes' }).error, 'enabled must be a boolean')
  assert.equal(resolveSettings({ syncAllowedModels: 'yes' }).error, 'syncAllowedModels must be a boolean')
  assert.match(resolveSettings({ providers: [] }).error, /non-empty array/)
  assert.match(resolveSettings({ providers: ['-bad'] }).error, /lowercase provider ids/)
  assert.match(resolveSettings({ refreshMs: 1 }).error, /between 60000/)
  assert.match(resolveSettings({ refreshMs: 60000.5 }).error, /integer/)
  assert.equal(resolveSettings({ refreshMs: 604800000 }).settings.refreshMs, 604800000)
  assert.match(resolveSettings({ timeoutMs: 0 }).error, /between 1000/)
  assert.match(resolveSettings({ packageName: 'other' }).error, /packageName/)
  assert.deepEqual(resolveSettings({ providers: ['a', 'a'] }).settings.providers, ['a'])
})

test('catalog URLs are version-pinned and validated', () => {
  assert.equal(providerCatalogUrl('1.6.0', 'openai-codex'),
    'https://unpkg.com/@earendil-works/pi-ai@1.6.0/dist/providers/data/openai-codex.json')
  assert.equal(latestCatalogUrl(), 'https://registry.npmjs.org/@earendil-works/pi-ai/latest')
  assert.throws(() => providerCatalogUrl('next', 'openai-codex'), /invalid package version/)
  assert.throws(() => providerCatalogUrl('1.6.0', '../secret'), /invalid provider id/)
})

test('clean strips control and bidirectional characters and caps the length', () => {
  assert.equal(clean('a\u0000b\u001b[1m\u202ec'), 'a b [1m c')
  assert.equal(clean('x'.repeat(10), 5), 'xxxx…')
})

test('statusText reports version, the timer only when it exists, and route policy', () => {
  const settings = { enabled: true, syncAllowedModels: false, providers: ['openai-codex'], refreshMs: 60000 }
  const text = statusText(settings, { lastVersion: '1.6.0', lastResult: 'Models added: x.', lastFinishedAt: 0, nextCheckAt: 60000 })
  assert.match(text, /1.6.0/)
  assert.match(text, /Next automatic check/)
  assert.match(text, /Subagent routes: not changed/)
  const off = statusText({ ...settings, enabled: false, syncAllowedModels: true }, { pendingRoutes: ['openai-codex/a'] })
  assert.doesNotMatch(off, /Next automatic check/)
  assert.match(off, /Automatic checks are off/)
  assert.match(off, /waiting for a retry: openai-codex\/a/)
})

test('seedPrecheck names the local route in its refusal when asked to', () => {
  const providers = { 'llamacpp-local': { api: 'openai-completions', models: [{ id: 'a' }] } }
  assert.match(seedPrecheck(providers, 'llamacpp-local').error, /seed only converts/)
  assert.match(seedPrecheck(providers, 'llamacpp-local', undefined, { local: true }).error, /local route reconciles that list/)
})
