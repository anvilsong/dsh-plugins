import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

function boot() {
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
  const ctx = {
    effect() {},
    get(name) {
      if (name === 'commandUi') {
        return { execute: async (session, line) => {
          calls.push({ sessionId: session.sessionId, line })
          return { kind: 'success', text: 'authorized' }
        } }
      }
      return undefined
    },
    remote: { $mount: async () => () => {} },
    slots: {
      inject(_name, callback) {
        const registration = callback()
        if (registration.meta.name === 'settings.models.provider-card') cards.set(registration.meta.key, registration.component)
      },
      register(meta, component) { return { meta, component } },
    },
  }
  factory((specifier) => specifier === 'react' ? React : { Button: 'Button' }).apply(ctx)
  return { component: cards.get('llm-pi-ai'), calls }
}

function props(route) {
  return {
    provider: { provider: route, nativeAuth: { env: [], oauth: true } },
    configured: false,
    keyConfigured: false,
    useSessions(selector) { return selector({ currentId: 'session-test', byId: {}, ids: [] }) },
  }
}

function findButton(node) {
  if (!node || typeof node !== 'object') return null
  if (node.type === 'button' || node.type === 'Button') return node
  for (const child of node.children ?? []) {
    const found = findButton(child)
    if (found) return found
  }
  return null
}

for (const [route, label] of [['openai-codex', 'Sign in with ChatGPT'], ['anthropic', 'Sign in with Claude']]) {
  test(`${route} card exposes a sign-in action`, async () => {
    const { component, calls } = boot()
    const rendered = component(props(route))
    const button = findButton(rendered)
    assert.ok(button)
    assert.equal(button.children[0], label)
    assert.equal(button.props.variant, 'outline')
    assert.equal(button.props.size, 'sm')
    await button.props.onClick()
    assert.deepEqual(calls, [{ sessionId: 'session-test', line: `/provider-login ${route}` }])
  })
}
