import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

function boot() {
  let registration
  let factory
  globalThis.window = {
    __ModuleLoader__: { load(value) { factory = value.factory } },
  }
  vm.runInThisContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'))

  const React = {
    Fragment: 'fragment',
    createElement(type, props, ...children) {
      return typeof type === 'function' ? type({ ...props, children }) : { type, props: props ?? {}, children }
    },
    useState(initial) {
      let value = initial
      return [value, (next) => { value = next }]
    },
    useRef(initial) { return { current: initial } },
    useEffect(fn) { fn() },
  }
  const primitives = {
    Tooltip: 'Tooltip', Button: 'Button', IconInfoOutlineRegular: 'IconInfo', Switch: 'Switch',
  }
  const calls = []
  const ctx = {
    get(name) {
      if (name === 'locale') return { bind: () => (key) => key, register: () => () => {} }
      if (name === 'commandUi') {
        return {
          execute: async (session, line) => {
            calls.push({ sessionId: session.sessionId, line })
            return { kind: 'success', text: 'ok' }
          },
        }
      }
      return undefined
    },
    effect: () => {},
    slots: {
      inject: (_slot, callback) => { registration = callback() },
      register: (meta, component) => ({ meta, component }),
    },
  }

  const plugin = factory((specifier) => specifier === 'react' ? React : primitives)
  assert.deepEqual(plugin.inject, ['slots'])
  plugin.apply(ctx)
  return { registration, calls }
}

test('client registers the model-option switch and sends an explicit command', async () => {
  const { registration, calls } = boot()
  assert.equal(registration.meta.id, 'ultracode-option')
  assert.equal(registration.meta.name, 'conversation.input.model.options')
  const rendered = registration.component({ sessionId: 'session-1', locked: false, useProjection: () => ({ active: true, pending: false }) })
  const row = rendered.children.find((child) => child?.type === 'div')
  assert.ok(row)
  const toggle = row.children.find((child) => child?.type === 'Switch')
  assert.ok(toggle)
  assert.equal(toggle.props.checked, true)
  await toggle.props.onChange(false)
  assert.deepEqual(calls, [{ sessionId: 'session-1', line: '/ultracode off' }])
})
