import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const clientSource = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const immediate = () => new Promise((resolve) => setImmediate(resolve))

function sameDeps(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
}

async function boot(route, options = {}) {
  let factory
  globalThis.window = { __ModuleLoader__: { load(value) { factory = value.factory } } }
  vm.runInThisContext(clientSource)

  // A small hook-aware renderer: effects run after each render and state
  // setters persist until the explicit rerender, like the client slot host.
  const hooks = new Map()
  const cursors = new Map()
  let currentComponent
  let pendingEffects = []
  function hookCell() {
    assert.ok(currentComponent, 'hook called outside a component')
    const cells = hooks.get(currentComponent) ?? []
    hooks.set(currentComponent, cells)
    const index = cursors.get(currentComponent) ?? 0
    cursors.set(currentComponent, index + 1)
    if (!cells[index]) cells[index] = {}
    return cells[index]
  }
  function memo(cell, create, deps) {
    if (!cell.initialized || !sameDeps(cell.deps, deps)) {
      cell.value = create()
      cell.deps = deps
      cell.initialized = true
    }
    return cell.value
  }
  const React = {
    Fragment: 'fragment',
    createElement(type, props, ...children) {
      if (typeof type !== 'function') return { type, props: props ?? {}, children }
      const previous = currentComponent
      currentComponent = type
      cursors.set(type, 0)
      try {
        return type({ ...props, children })
      } finally {
        currentComponent = previous
      }
    },
    useState(initial) {
      const cell = hookCell()
      if (!cell.initialized) {
        cell.value = typeof initial === 'function' ? initial() : initial
        cell.initialized = true
        cell.set = (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next }
      }
      return [cell.value, cell.set]
    },
    useEffect(fn, deps) {
      const cell = hookCell()
      if (cell.initialized && sameDeps(cell.deps, deps)) return
      cell.deps = deps
      cell.initialized = true
      pendingEffects.push(() => {
        if (typeof cell.cleanup === 'function') cell.cleanup()
        const cleanup = fn()
        cell.cleanup = typeof cleanup === 'function' ? cleanup : null
      })
    },
    useMemo(fn, deps) { return memo(hookCell(), fn, deps) },
    useRef(value) {
      const cell = hookCell()
      if (!cell.initialized) {
        cell.value = { current: value }
        cell.initialized = true
      }
      return cell.value
    },
    useCallback(fn, deps) { return memo(hookCell(), () => fn, deps) },
  }

  const cards = new Map()
  const calls = []
  const statusCalls = []
  const answers = []
  let mountedContribution
  let resolveAnswer
  const prompt = options.prompt ?? {
    kind: 'select',
    message: 'Choose',
    options: [{ id: 'code', label: 'Code' }],
  }
  const stream = {
    send(value) {
      answers.push(value)
      resolveAnswer?.()
      resolveAnswer = undefined
    },
    async *[Symbol.asyncIterator]() {
      yield { type: 'notice', notice: { message: 'Continue', url: 'https://example.com' } }
      yield { type: 'prompt', id: 'prompt-1', prompt }
      await new Promise((resolve) => { resolveAnswer = resolve })
      yield { type: 'settled', status: 'authorized' }
    },
  }
  const ctx = {
    effect(fn, label) { if (label === 'usage: mount remotes') void fn() },
    get(name) {
      if (name === 'remote.providerLogin') {
        return {
          async status(request) {
            statusCalls.push(request)
            return { configured: options.configured === true }
          },
          begin(request) { calls.push(request); return stream },
        }
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
  await immediate()
  const component = cards.get('llm-pi-ai')
  const props = {
    provider: { provider: route, nativeAuth: { env: [], oauth: true } },
    configured: false,
    keyConfigured: options.keyConfigured ?? false,
  }
  let rendered
  const render = () => {
    rendered = React.createElement(component, props)
    const effects = pendingEffects
    pendingEffects = []
    for (const run of effects) run()
    return rendered
  }
  const settle = async () => {
    for (let index = 0; index < 3; index += 1) {
      await immediate()
      render()
    }
    return rendered
  }
  render()
  await settle()
  return {
    get rendered() { return rendered },
    render,
    settle,
    calls,
    statusCalls,
    answers,
    mountedContribution,
  }
}

function find(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, predicate)
      if (found) return found
    }
    return null
  }
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  return find(node.children ?? [], predicate)
}

function findByText(node, text) {
  return find(node, (candidate) => (candidate.children ?? []).includes?.(text))
}

function findByType(node, type) {
  return find(node, (candidate) => candidate.type === type)
}

function assertThemedControl(control) {
  assert.ok(control)
  assert.equal(control.props.className, 'pup-login-control')
  assert.equal(control.props.style.color, 'var(--dsw-alias-label-primary)')
  assert.equal(control.props.style.background, 'var(--dsw-alias-bg-layer-1)')
  assert.equal(control.props.style.border, '.5px solid var(--dsw-alias-border-l3)')
  assert.equal(control.props.style.borderRadius, 'var(--dsw-radius-sm)')
}

for (const [route, providerName] of [['openai-codex', 'ChatGPT'], ['anthropic', 'Claude']]) {
  test(`${route} card runs OAuth inside Models and settles signed in`, async () => {
    const h = await boot(route)
    const label = `Sign in with ${providerName}`
    const button = findByText(h.rendered, label)
    assert.ok(button)
    assert.equal(button.props.type, 'button')
    assert.equal(button.props.variant, 'outline')
    assert.equal(button.props.size, 'sm')
    assert.deepEqual(h.statusCalls, [{ provider: route }])

    const pending = button.props.onClick()
    await h.settle()
    const select = findByType(h.rendered, 'select')
    assertThemedControl(select)
    const submit = findByText(h.rendered, 'Submit')
    assert.equal(submit.props.type, 'button')
    assert.equal(submit.props.variant, 'outline')
    assert.equal(submit.props.size, 'sm')
    submit.props.onClick()
    await pending
    await h.settle()

    assert.deepEqual(h.calls, [{ provider: route, method: 'oauth' }])
    assert.deepEqual(h.answers, [{ type: 'answer', id: 'prompt-1', answer: 'code' }])
    assert.ok(findByText(h.rendered, `Signed in with ${providerName}`))
    assert.equal(findByText(h.rendered, label), null)
    assert.equal(findByText(h.rendered, 'Authorized. You can now select this provider.'), null)

    const statusDescriptor = h.mountedContribution.descriptors.find((item) => item.method === 'status')
    assert.equal(statusDescriptor.invocation.kind, 'direct')
    assert.equal(statusDescriptor.parameters[0].wire, 'request')
    assert.equal(statusDescriptor.parameters[0].codec.mode, 'strict')
    assert.deepEqual(statusDescriptor.parameters[0].codec.create().parse({ provider: route }), { provider: route })
    const beginDescriptor = h.mountedContribution.descriptors.find((item) => item.method === 'begin')
    assert.equal(beginDescriptor.parameters[0].wire, 'request')
    assert.equal(beginDescriptor.parameters[0].codec.mode, 'strict')
    assert.equal(beginDescriptor.uplink.codec.mode, 'strict')
    assert.deepEqual(beginDescriptor.parameters[0].codec.create().parse({ provider: route }), { provider: route })
  })
}

for (const [route, providerName] of [['openai-codex', 'ChatGPT'], ['anthropic', 'Claude']]) {
  test(`${route} stored OAuth renders signed in after reload, independent of API-key state`, async () => {
    const h = await boot(route, { configured: true, keyConfigured: true })
    assert.deepEqual(h.statusCalls, [{ provider: route }])
    assert.ok(findByText(h.rendered, `Signed in with ${providerName}`))
    const reauthenticate = findByText(h.rendered, 'Re-authenticate')
    assert.ok(reauthenticate)
    assert.equal(reauthenticate.props.variant, 'outline')
    assert.equal(reauthenticate.props.size, 'sm')
    assert.equal(findByText(h.rendered, `Sign in with ${providerName}`), null)
    assert.equal(findByText(h.rendered, 'Checking sign-in…'), null)
  })
}

test('text prompt uses theme tokens and native secondary button styling', async () => {
  const h = await boot('anthropic', {
    prompt: { kind: 'text', message: 'Enter the code', placeholder: 'Paste code' },
  })
  const pending = findByText(h.rendered, 'Sign in with Claude').props.onClick()
  await h.settle()
  const input = findByType(h.rendered, 'input')
  assertThemedControl(input)
  assert.equal(input.props.type, 'text')
  assert.equal(input.props.placeholder, 'Paste code')
  assert.match(clientSource, /\.pup-login-control::placeholder\{color:var\(--dsw-alias-label-secondary\);opacity:1\}/)

  input.props.onChange({ target: { value: 'oauth-code' } })
  h.render()
  const submit = findByText(h.rendered, 'Submit')
  assert.equal(submit.props.type, 'button')
  assert.equal(submit.props.variant, 'outline')
  assert.equal(submit.props.size, 'sm')
  submit.props.onClick()
  await pending
  await h.settle()
  assert.deepEqual(h.answers, [{ type: 'answer', id: 'prompt-1', answer: 'oauth-code' }])
  assert.ok(findByText(h.rendered, 'Signed in with Claude'))
})
