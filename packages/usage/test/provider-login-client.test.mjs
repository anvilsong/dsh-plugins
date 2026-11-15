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
  const source = options.usageState
    ? clientSource.replace('const PROVIDERS = [', 'const PROVIDERS = globalThis.__testProviders = [')
    : clientSource
  vm.runInThisContext(source)

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
  const usageRefreshes = []
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
      const usageNamespace = route === 'openai-codex' ? 'codexUsage' : 'anthropicUsage'
      if (options.usageState && name === 'remote.' + usageNamespace) {
        return {
          snapshot: async () => options.usageState,
          async refresh() {
            usageRefreshes.push(route)
            return options.usageState
          },
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
  if (options.usageState) globalThis.__testProviders.find((provider) => provider.gate.includes(route)).store.state = options.usageState
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
    usageRefreshes,
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

function findByClass(node, className) {
  return find(node, (candidate) => candidate.props?.className?.split(' ').includes(className))
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
    assert.equal(h.statusCalls.length, 2)
    assert.ok(h.statusCalls.every((call) => call.provider === route))

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
    assert.equal(h.statusCalls.length, 2)
    assert.ok(h.statusCalls.every((call) => call.provider === route))
    assert.ok(findByText(h.rendered, `Signed in with ${providerName}`))
    const reauthenticate = findByText(h.rendered, 'Re-authenticate')
    assert.ok(reauthenticate)
    assert.equal(reauthenticate.props.variant, 'outline')
    assert.equal(reauthenticate.props.size, 'sm')
    assert.equal(findByText(h.rendered, `Sign in with ${providerName}`), null)
    assert.equal(findByText(h.rendered, 'Checking sign-in…'), null)
  })
}

test('configured OAuth makes the usage card visible', async () => {
  const h = await boot('openai-codex', {
    configured: true,
    usageState: {
      status: 'ready',
      data: {
        kind: 'quota',
        windows: [{ key: 'sevenDay', label: '7-day window', usedRatio: 1, resetAt: '2026-11-16T06:00:00Z' }],
      },
    },
  })
  assert.ok(findByText(h.rendered, '7d 100.0%'))
  assert.ok(findByText(h.rendered, 'Signed in with ChatGPT'))
})

test('Claude scoped Fable limit appears in summary and panel', async () => {
  const h = await boot('anthropic', {
    configured: true,
    usageState: {
      status: 'ready',
      data: {
        kind: 'quota',
        windows: [{ key: 'sevenDay', label: '7-day window', usedRatio: 1, resetAt: '2026-11-16T06:00:00Z' }],
        limits: [{ kind: 'weekly_scoped', usedRatio: 0.04, scope: { model: { displayName: 'Fable' } }, resetAt: '2026-11-16T06:00:00Z', isActive: false }],
      },
    },
  })
  assert.ok(find(h.rendered, (node) => (node.children ?? []).some((child) => typeof child === 'string' && child.includes('Fable 4.0%'))))
  const summaryButton = find(h.rendered, (node) => node.props?.className === 'pup-btn')
  summaryButton.props.onClick()
  h.render()
  assert.ok(findByText(h.rendered, 'Fable limit'))
})

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

function expandUsage(h, title) {
  const toggle = find(h.rendered, (node) => node.type === 'button' && node.props?.title === `${title} usage`)
  assert.ok(toggle, `${title} usage summary is visible`)
  toggle.props.onClick()
  h.render()
}

test('Codex summary and quota panel present plan, credits, progress, and secondary details', async () => {
  const h = await boot('openai-codex', {
    configured: true,
    usageState: {
      status: 'ready',
      endpoint: 'https://chatgpt.com/backend-api',
      fetchedAt: '2026-11-15T12:00:00Z',
      data: {
        kind: 'quota',
        planType: 'free',
        windows: [{ key: 'primary', label: '30-day window', usedRatio: 0.425, resetAt: '2026-12-15T12:00:00Z' }],
        credits: { hasCredits: true, unlimited: false, balance: '12.50' },
        resetCreditsAvailable: 2,
        ordinaryUsageAllowed: false,
        spendControlReached: true,
      },
    },
  })

  assert.ok(findByText(h.rendered, 'free plan'))
  assert.ok(findByText(h.rendered, '30d 42.5% · credits 12.50'))
  expandUsage(h, 'OpenAI Codex')

  assert.ok(findByText(h.rendered, 'OpenAI Codex'))
  assert.ok(findByText(h.rendered, '30-day window'))
  assert.ok(findByText(h.rendered, 'Credits'))
  assert.ok(findByText(h.rendered, '12.50'))
  assert.ok(findByText(h.rendered, 'Rate-limit reset credits'))
  assert.ok(findByText(h.rendered, 2))
  assert.ok(findByText(h.rendered, 'Included usage is currently blocked.'))
  assert.ok(findByText(h.rendered, 'Spend control reached.'))
  assert.equal(findByText(h.rendered, '5-hour window'), null)
  assert.ok(findByClass(h.rendered, 'pup-grid'))
  const bar = findByClass(h.rendered, 'pup-bar')
  assert.equal(bar.children[0].props.style.width, '42.5%')
  assert.ok(find(h.rendered, (node) => node.props?.className === 'pup-code' && node.children?.some((child) => typeof child === 'string' && child.includes('chatgpt.com/backend-api'))))

  const refresh = findByText(h.rendered, 'Refresh')
  assert.equal(refresh.props.type, 'button')
  assert.equal(refresh.props.className, 'pup-btn')
  refresh.props.onClick()
  await h.settle()
  assert.deepEqual(h.usageRefreshes, ['openai-codex'])
})

test('Claude summary and quota panel present only returned windows and account details', async () => {
  const h = await boot('anthropic', {
    configured: true,
    usageState: {
      status: 'ready',
      endpoint: 'https://api.anthropic.com',
      fetchedAt: '2026-11-15T12:00:00Z',
      data: {
        kind: 'quota',
        windows: [{ key: 'sevenDay', label: '7-day window', usedRatio: 1, resetAt: '2026-11-16T06:00:00Z' }],
        extra: { enabled: true, balanceCents: 1250, monthlyLimitCents: 5000, currency: 'USD', disabledReason: null },
        spend: { usedMinor: 1250, limitMinor: 5000, currency: 'USD', exponent: 2, reached: false },
        breakdown: [{ displayName: 'Claude Code', percent: 100 }],
      },
    },
  })

  assert.ok(findByText(h.rendered, '7d 100.0% · extra used $12.50 · spent $12.50'))
  expandUsage(h, 'Claude')

  assert.ok(findByText(h.rendered, 'Claude'))
  assert.ok(findByText(h.rendered, 'subscription quota'))
  assert.ok(findByText(h.rendered, '7-day window'))
  assert.ok(findByText(h.rendered, 'Extra usage used'))
  assert.ok(findByText(h.rendered, 'monthly limit $50.00'))
  assert.ok(findByText(h.rendered, 'Usage credits spent'))
  assert.ok(findByText(h.rendered, 'limit $50.00'))
  assert.ok(findByText(h.rendered, 'Claude Code: 100%'))
  assert.equal(findByText(h.rendered, '5-hour window'), null)
  assert.ok(findByClass(h.rendered, 'pup-grid'))
  const bar = findByClass(h.rendered, 'pup-bar')
  assert.equal(bar.children[0].props.style.width, '100%')
})
