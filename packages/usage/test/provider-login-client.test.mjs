import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

async function boot(route) {
  let factory
  globalThis.window = { __ModuleLoader__: { load(value) { factory = value.factory } } }
  vm.runInThisContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'))
  const React = {
    Fragment: 'fragment',
    createElement(type, props, ...children) {
      return typeof type === 'function' ? type({ ...props, children }) : { type, props: props ?? {}, children }
    },
    useState(initial) { return [initial, () => {}] },
    useEffect() {},
    useMemo(fn) { return fn() },
    useRef(value) { return { current: value } },
    useCallback(fn) { return fn },
  }
  const cards = new Map()
  const calls = []
  const answers = []
  let mountedContribution
  let resolveAnswer
  const stream = {
    send(value) { answers.push(value); resolveAnswer?.() },
    async *[Symbol.asyncIterator]() {
      yield { type: 'notice', notice: { message: 'Continue', url: 'https://example.com' } }
      yield { type: 'prompt', id: 'prompt-1', prompt: { kind: 'select', message: 'Choose', options: [{ id: 'code', label: 'Code' }] } }
      await new Promise((resolve) => { resolveAnswer = resolve })
      yield { type: 'settled', status: 'authorized' }
    },
  }
  const ctx = {
    effect(fn, label) { if (label === 'usage: mount remotes') void fn() },
    get(name) {
      if (name === 'remote.providerLogin') {
        return { begin(request) { calls.push(request); return stream } }
      }
      return undefined
    },
    remote: { $mount: async (value) => { mountedContribution = value; return () => {} } },
    slots: {
      inject(_name, callback) {
        const registration = callback()
        if (registration.meta.name === 'settings.models.provider-card') cards.set(registration.meta.key, registration.component)
      },
      register(meta, component) { return { meta, component } },
    },
  }
  factory((specifier) => specifier === 'react' ? React : { Button: 'Button' }).apply(ctx)
  await new Promise((resolve) => setImmediate(resolve))
  const component = cards.get('llm-pi-ai')
  const rendered = component({
    provider: { provider: route, nativeAuth: { env: [], oauth: true } },
    configured: false,
    keyConfigured: false,
  })
  return { rendered, calls, answers, mountedContribution, sendAnswer: (value) => stream.send(value) }
}

function findByText(node, text) {
  if (!node || typeof node !== 'object') return null
  if ((node.children ?? []).includes(text)) return node
  for (const child of node.children ?? []) {
    const found = findByText(child, text)
    if (found) return found
  }
  return null
}

for (const [route, label] of [['openai-codex', 'Sign in with ChatGPT'], ['anthropic', 'Sign in with Claude']]) {
  test(`${route} card runs OAuth inside Models`, async () => {
    const { rendered, calls, answers, mountedContribution, sendAnswer } = await boot(route)
    const button = findByText(rendered, label)
    assert.ok(button)
    assert.equal(button.props.variant, 'outline')
    assert.equal(button.props.size, 'sm')
    const pending = button.props.onClick()
    await new Promise((resolve) => setImmediate(resolve))
    sendAnswer({ type: 'answer', id: 'prompt-1', answer: 'code' })
    await pending
    assert.deepEqual(calls, [{ provider: route, method: 'oauth' }])
    assert.deepEqual(answers, [{ type: 'answer', id: 'prompt-1', answer: 'code' }])
    const descriptor = mountedContribution.descriptors.find((item) => item.method === 'begin')
    assert.equal(descriptor.parameters[0].wire, 'request')
    assert.equal(descriptor.parameters[0].codec.mode, 'strict')
    assert.equal(descriptor.uplink.codec.mode, 'strict')
    assert.deepEqual(descriptor.parameters[0].codec.create().parse({ provider: route }), { provider: route })
  })
}
