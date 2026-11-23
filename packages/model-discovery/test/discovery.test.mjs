import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  latestCatalogUrl,
  mergeAllowedModels,
  mapCatalog,
  mergeConfig,
  mergeProvider,
  providerCatalogUrl,
  resolveSettings,
  statusText,
} from '../src/discovery.js'

const astra = {
  id: 'gpt-6.2-astra', name: 'GPT-6.2 Astra', api: 'openai-codex-responses', provider: 'openai-codex',
  baseUrl: 'https://chatgpt.com/backend-api', reasoning: true, input: ['text', 'image'],
  cost: { input: 8, output: 40 }, contextWindow: 272000, maxTokens: 128000,
  thinkingLevelMap: { off: null, low: 'low', high: 'high', xhigh: 'xhigh', max: 'max', future: 'future' },
  compat: { supportsMidConvoSystemMessages: true, supportsToolSearch: true }, type: 'chat',
}
const terra = {
  ...astra, id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', contextWindow: 500000,
  thinkingLevelMap: { off: 'none', low: 'low', high: 'high', xhigh: 'xhigh', max: 'max' },
}

test('mapCatalog copies only DSH-supported model fields, never upstream compat', () => {
  const { models, issues } = mapCatalog({ 'openai-codex-responses': { 'chat:gpt-6.2-astra': astra } }, 'openai-codex')
  assert.equal(issues.length, 0)
  assert.deepEqual(models, [{
    id: 'gpt-6.2-astra', name: 'GPT-6.2 Astra', contextWindow: 272000, maxTokens: 128000,
    input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', high: 'high', xhigh: 'xhigh', max: 'max' },
  }])
  assert.equal(Object.hasOwn(models[0], 'compat'), false)
  assert.equal(Object.hasOwn(models[0], 'cost'), false)
  assert.equal(Object.hasOwn(models[0], 'api'), false)
})

test('unsupported modalities are dropped without discarding text and image', () => {
  const { models } = mapCatalog({ group: { one: { ...astra, input: ['text', 'image', 'video'] } } }, 'openai-codex')
  assert.deepEqual(models[0].input, ['text', 'image'])
})

test('a model with no supported modality is skipped with a reason', () => {
  const { models, issues } = mapCatalog({ group: { one: { ...astra, input: ['video'] } } }, 'openai-codex')
  assert.equal(models.length, 0)
  assert.equal(issues.length, 1)
  assert.match(issues[0].reason, /no supported input modality/)
})

test('reasoning efforts preserve null and string wire values and ignore unknown levels', () => {
  const { models } = mapCatalog({ group: { one: terra } }, 'openai-codex')
  assert.deepEqual(models[0].reasoningEfforts, { off: 'none', low: 'low', high: 'high', xhigh: 'xhigh', max: 'max' })
  assert.equal(Object.hasOwn(models[0].reasoningEfforts, 'future'), false)
})

test('a reasoning model without a thinking map is refused rather than made non-reasoning', () => {
  const { models, issues } = mapCatalog({ group: { one: { ...astra, thinkingLevelMap: undefined } } }, 'openai-codex')
  assert.equal(models.length, 0)
  assert.match(issues[0].reason, /needs thinkingLevelMap/)
})

test('malformed and non-chat models are skipped with per-model reasons', () => {
  const { models, issues } = mapCatalog({ group: {
    badHttp: { ...astra, id: 'bad-http', baseUrl: 'http://example.test' },
    wrongProvider: { ...astra, id: 'wrong-provider', provider: 'other' },
    wrongType: { ...astra, id: 'wrong-type', type: 'embedding' },
    badWindow: { ...astra, id: 'bad-window', contextWindow: 0 },
    badTokens: { ...astra, id: 'bad-tokens', maxTokens: 0 },
  } }, 'openai-codex')
  assert.equal(models.length, 0)
  assert.equal(issues.length, 5)
  assert.ok(issues.some((issue) => issue.reason.includes('https')))
  assert.ok(issues.some((issue) => issue.reason.includes('expected openai-codex')))
  assert.ok(issues.some((issue) => issue.reason.includes('unsupported model type')))
})

test('duplicate ids do not produce duplicate entries', () => {
  const { models, issues } = mapCatalog({
    one: { a: astra }, two: { b: astra },
  }, 'openai-codex')
  assert.equal(models.length, 1)
  assert.equal(issues.filter((issue) => issue.reason === 'duplicate model id').length, 1)
})

test('mergeProvider adds only missing ids and preserves existing entries and provider fields', () => {
  const current = { credentialRef: 'KEY', models: [{ id: 'old', name: 'mine', custom: true }] }
  const result = mergeProvider(current, [
    { id: 'old', name: 'upstream replacement' },
    { id: 'new', name: 'new model' },
  ])
  assert.deepEqual(result.added, ['new'])
  assert.deepEqual(result.provider.models[0], current.models[0])
  assert.equal(result.provider.credentialRef, 'KEY')
  assert.equal(result.provider.models[1].name, 'new model')
})

test('mergeProvider refuses a non-array models field instead of replacing it', () => {
  const result = mergeProvider({ models: { old: {} } }, [])
  assert.match(result.error, /not an array/)
})

test('mergeConfig preserves top-level fields and every other provider', () => {
  const current = { otherSetting: true, providers: { other: { enabled: true }, 'openai-codex': {} } }
  const next = mergeConfig(current, 'openai-codex', { models: [{ id: 'new' }] })
  assert.equal(next.otherSetting, true)
  assert.deepEqual(next.providers.other, { enabled: true })
  assert.equal(next.providers['openai-codex'].models.length, 1)
  assert.deepEqual(current.providers['openai-codex'], {}, 'the input is not mutated')
})

test('allowed-model merge adds only missing provider/model routes and preserves others', () => {
  const current = [
    { provider: 'openai-codex', model: 'gpt-6-astra' },
    { provider: 'anthropic', model: 'claude-sonnet-5-5' },
  ]
  const result = mergeAllowedModels(current, 'openai-codex', [
    { id: 'gpt-6-astra' }, { id: 'gpt-6.2-astra' },
  ])
  assert.deepEqual(result.added, ['gpt-6.2-astra'])
  assert.deepEqual(result.allowedModels[0], current[0])
  assert.deepEqual(result.allowedModels[1], current[1])
  assert.deepEqual(result.allowedModels[2], { provider: 'openai-codex', model: 'gpt-6.2-astra' })
  assert.equal(mergeAllowedModels({}, 'openai-codex', []).error, 'allowedModels is not an array')
})

test('settings have safe defaults and reject invalid values', () => {
  const defaults = resolveSettings()
  assert.equal(defaults.settings.enabled, true)
  assert.deepEqual(defaults.settings.providers, ['openai-codex'])
  assert.equal(defaults.settings.refreshMs, 21600000)
  assert.equal(resolveSettings(null).error, 'config must be an object')
  assert.equal(resolveSettings([]).error, 'config must be an object')
  assert.equal(resolveSettings({ enabled: 'yes' }).error, 'enabled must be a boolean')
  assert.match(resolveSettings({ providers: [] }).error, /non-empty array/)
  assert.match(resolveSettings({ refreshMs: 1 }).error, /between 60000/)
  assert.match(resolveSettings({ timeoutMs: 0 }).error, /between 1000/)
  assert.match(resolveSettings({ packageName: 'other' }).error, /packageName/)
})

test('catalog URLs are version-pinned and validated', () => {
  assert.equal(providerCatalogUrl('1.6.0', 'openai-codex'),
    'https://unpkg.com/@earendil-works/pi-ai@1.6.0/dist/providers/data/openai-codex.json')
  assert.equal(latestCatalogUrl(), 'https://registry.npmjs.org/@earendil-works/pi-ai/latest')
  assert.throws(() => providerCatalogUrl('next', 'openai-codex'), /invalid package version/)
  assert.throws(() => providerCatalogUrl('1.6.0', '../secret'), /invalid provider id/)
})

test('statusText reports version, additions and errors', () => {
  const text = statusText(
    { enabled: true, providers: ['openai-codex'], refreshMs: 60000 },
    { lastVersion: '1.6.0', lastAdded: ['gpt-6.2-astra'], lastError: 'HTTP 500', lastFinishedAt: 0, nextCheckAt: 60000 },
  )
  assert.match(text, /1.6.0/)
  assert.match(text, /gpt-6.2-astra/)
  assert.match(text, /HTTP 500/)
})
