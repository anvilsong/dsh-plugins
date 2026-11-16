import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

function findAll(node, predicate, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found)
    return found
  }
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (predicate(node)) found.push(node)
  for (const child of node.children ?? []) findAll(child, predicate, found)
  return found
}

function find(node, predicate) {
  return findAll(node, predicate)[0]
}

test('client registers one Advisor switch and an authorized-model selector', async () => {
  const registrations = []
  const slots = {
    inject(name, callback) { callback() },
    register(definition, component) { registrations.push({ definition, component }) },
  }
  let stateQueue = []
  let stateIndex = 0
  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => {
      const index = stateIndex++
      return [index in stateQueue ? stateQueue[index] : initial, () => {}]
    },
    useRef: (current) => ({ current }),
    useEffect: () => {},
  }
  const primitives = new Proxy({}, { get: (_target, key) => key })
  const context = {
    window: {
      __ModuleLoader__: {
        load({ id, factory }) {
          const result = factory((name) => name === 'react' ? React : primitives)
          assert.equal(id, 'dsh-plugin-advisor')
          assert.equal(result.inject[0], 'slots')
          result.apply({ get: () => undefined, slots, effect() {} })
        },
      },
    },
  }
  vm.runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), context)
  assert.equal(registrations.length, 3)
  assert.equal(registrations[0].definition.id, 'advisor-option')
  assert.equal(registrations[1].definition.id, 'advisor-model-option')
  assert.equal(registrations[2].definition.id, 'advisor-verifier-model-option')
  assert.deepEqual(registrations.map((entry) => entry.definition.order), [25, 26, 27])

  const advisorOption = registrations[0].component({ useProjection: () => ({ active: false, pending: true, pendingTarget: 'advisor' }), ctx: { get: () => undefined } })
  const advisor = advisorOption.type(advisorOption.props)
  const toggle = find(advisor, (node) => node.type === 'Switch')
  assert.equal(toggle.props.disabled, undefined, 'never disabled mid-flight; the blur would close the host menu')
  assert.equal(toggle.props.label, 'Advisor — Updating…')
  assert.equal(find(advisor, (node) => node.type === 'Button').props['aria-label'], 'About Advisor')

  assert.match(find(advisor, (node) => node.props.label?.includes?.('Advisor-owned')).props.label, /unaffected by Model router/)

  const selected = { provider: 'openrouter', model: '~deepseek/deepseek-flash-latest' }
  const allRoutes = [selected, { provider: 'anthropic', model: 'claude-haiku-5-5' }, { provider: 'openai-codex', model: '~deepseek/deepseek-flash-latest' }]
  const props = {
    useProjection: (key) => key === 'advisorModelRoutes' ? allRoutes : { active: true, verifierModel: selected, pending: false },
    ctx: { get: () => undefined },
  }
  const render = (overrides, stateOverrides) => {
    const element = registrations[2].component({ ...props, ...overrides })
    stateQueue = stateOverrides ?? []
    stateIndex = 0
    return element.type(element.props)
  }

  const offModel = render({ useProjection: (key) => key === 'advisorModelRoutes' ? allRoutes : { active: false, verifierModel: selected, pending: false } })
  assert.equal(find(offModel, (node) => node.props.role === 'menuitem').props['data-inactive'], '',
    'the verifier cell stays in place, marked inactive, while Advisor is off')

  const model = render()
  const cell = find(model, (node) => node.props.role === 'menuitem')
  assert.equal(cell.props['aria-haspopup'], 'menu')
  assert.equal(cell.props['aria-expanded'], false)
  assert.match(JSON.stringify(cell), /Verifier model/)
  assert.match(JSON.stringify(cell), /deepseek-flash-latest/)
  assert.equal(findAll(model, (node) => node.type === 'select').length, 0)
  assert.equal(findAll(model, (node) => node.props.role === 'note').length, 0, 'help copy moved into the tooltip')

  // State order: anchor ref (no state), open, desired, then useCommand busy/error.
  const open = render({}, [true])
  const flyout = find(open, (node) => typeof node.type === 'function' && node.props.cellRef)
  const rows = findAll(flyout.children[0]({ current: () => {} }), (node) => typeof node.props.onSelect === 'function')
  assert.deepEqual(rows.map((row) => [row.props.title ?? row.props.label, row.props.checked]).map((pair) => pair.join('=')), [
    'Inherit=false',
    'openrouter/~deepseek/deepseek-flash-latest=true',
    'anthropic/claude-haiku-5-5=false',
    'openai-codex/~deepseek/deepseek-flash-latest=false',
  ])
  assert.deepEqual(findAll(flyout.children[0]({ current: () => {} }), (node) => node.props.role === 'group').map((group) => group.props['aria-label']), ['openrouter', 'anthropic', 'openai-codex'])

  const nullModel = render({ useProjection: (key) => key === 'advisorModelRoutes' ? null : { active: true, verifierModel: null, pending: false } }, [true])
  const nullFlyout = find(nullModel, (node) => typeof node.type === 'function' && node.props.cellRef)
  const nullItems = nullFlyout.children[0]({ current: () => {} })
  assert.equal(findAll(nullItems, (node) => typeof node.props.onSelect === 'function').length, 1)
  assert.match(JSON.stringify(nullItems), /Inherit only/)

  const staleModel = render({ useProjection: (key) => key === 'advisorModelRoutes' ? null : { active: true, verifierModel: selected, pending: false } }, [true])
  assert.match(JSON.stringify(find(staleModel, (node) => node.props.role === 'menuitem')), /Saved route unavailable/)
  const staleItems = find(staleModel, (node) => typeof node.type === 'function' && node.props.cellRef).children[0]({ current: () => {} })
  assert.match(JSON.stringify(staleItems), /Select Inherit to reset/)
  assert.doesNotMatch(JSON.stringify(findAll(staleItems, (node) => typeof node.props.onSelect === 'function')), /deepseek/)

  const pendingModel = render({ useProjection: (key) => key === 'advisorModelRoutes' ? [selected] : { active: true, verifierModel: null, pending: true, pendingTarget: 'verifierModel' } }, [true])
  const pendingItems = find(pendingModel, (node) => typeof node.type === 'function' && node.props.cellRef).children[0]({ current: () => {} })
  assert.equal(findAll(pendingItems, (node) => typeof node.props.onSelect === 'function').every((row) => row.props.disabled === true), true)
  const otherPendingOption = registrations[0].component({
    useProjection: () => ({ active: false, pending: true, pendingTarget: 'verifierModel' }),
    ctx: { get: () => undefined },
  })
  const otherPending = otherPendingOption.type(otherPendingOption.props)
  assert.equal(findAll(otherPending, (node) => node.props.role === 'status').length, 0)

  const reports = []
  const chinese = advisorOption.type({
    ...advisorOption.props,
    useProjection: () => ({ active: false, pending: false, pendingTarget: null }),
    ctx: {
      get: (key) => key === 'commandUi'
        ? { execute: async () => ({ kind: 'error', text: 'English Host rejection' }) }
        : undefined,
    },
    reportFailure: (message) => reports.push(message),
    t: (key) => ({ 'chip.failed': '无法更新顾问。', 'chip.unavailable': '命令服务不可用。' })[key] ?? key,
  })
  await find(chinese, (node) => node.type === 'Switch').props.onChange(true)
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(reports, ['无法更新顾问。'])
})

const ticks = async (count = 6) => { for (let index = 0; index < count; index++) await Promise.resolve() }

// A tiny hook runtime: one persistent hook list per instance, effects run
// when their dependencies change, cleanups run on unmount.
function createRuntime() {
  let current = null
  const deps = (a, b) => a === undefined || b === undefined || a.length !== b.length || a.some((value, index) => !Object.is(value, b[index]))
  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const instance = current
      const index = instance.index++
      if (!(index in instance.hooks)) instance.hooks[index] = { value: initial }
      const hook = instance.hooks[index]
      return [hook.value, (next) => {
        hook.value = typeof next === 'function' ? next(hook.value) : next
        instance.dirty = true
      }]
    },
    useRef(initial) {
      const index = current.index++
      if (!(index in current.hooks)) current.hooks[index] = { current: initial }
      return current.hooks[index]
    },
    useEffect(effect, list) {
      const index = current.index++
      const hook = current.hooks[index]
      if (hook === undefined || deps(hook.deps, list)) {
        current.pending.push(() => {
          hook?.cleanup?.()
          const cleanup = effect()
          current.hooks[index] = { deps: list, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
        })
        if (hook === undefined) current.hooks[index] = { deps: undefined }
      }
    },
  }
  const mount = (component) => {
    const instance = { hooks: [], index: 0, pending: [], dirty: false, props: null }
    const render = (props) => {
      if (props !== undefined) instance.props = props
      current = instance
      instance.index = 0
      instance.pending = []
      instance.dirty = false
      const output = component(instance.props)
      const effects = instance.pending
      for (const effect of effects) { current = instance; effect() }
      return output
    }
    const unmount = () => {
      for (const hook of instance.hooks) hook?.cleanup?.()
    }
    return { instance, render, unmount }
  }
  return { React, mount }
}


test('verifier flyout commits one choice, shows saving, and snaps back on a recorded rejection', async () => {
  const runtime = createRuntime()
  const registrations = []
  const calls = []
  const reports = []
  const commandUi = { execute: async (_target, line) => { calls.push(line); return { kind: 'success' } } }
  vm.runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), {
    window: {
      __ModuleLoader__: {
        load({ factory }) {
          const result = factory((name) => name === 'react' ? runtime.React : new Proxy({}, { get: (_target, key) => key }))
          result.apply({
            get: (key) => key === 'commandUi' ? commandUi : undefined,
            slots: { inject(_name, callback) { callback() }, register(definition, component) { registrations.push(component) } },
            effect() {},
          })
        },
      },
    },
  })
  const routes = [{ provider: 'anthropic', model: 'claude-haiku-5-5' }]
  let view = { active: true, verifierModel: null, pending: false, pendingTarget: null, pendingSince: null, failure: null }
  const wrapper = registrations[2]({ useProjection: (key) => key === 'advisorModelRoutes' ? routes : view, reportFailure: (message) => reports.push(message) })
  const cell = runtime.mount(wrapper.type)
  let output = cell.render(wrapper.props)
  find(output, (node) => node.props.role === 'menuitem').props.onClick()
  output = cell.render()
  const flyout = find(output, (node) => typeof node.type === 'function' && node.props.cellRef)
  const closeRef = { current: () => {} }
  const rows = findAll(flyout.children[0](closeRef), (node) => typeof node.props.onSelect === 'function')
  rows.find((row) => row.props.title === 'anthropic/claude-haiku-5-5').props.onSelect()
  await ticks()
  assert.deepEqual(calls, ['/advisor verifier-model anthropic/claude-haiku-5-5'])
  output = cell.render()
  assert.equal(find(output, (node) => node.props.role === 'menuitem').props['aria-busy'], true)
  view = { ...view, failure: { count: 1, text: 'Advisor is already updating. Try again after it finishes.', target: 'verifierModel' } }
  output = cell.render()
  output = cell.render()
  assert.deepEqual(reports, ['Could not update Verifier model.'])
  assert.equal(find(output, (node) => node.props.role === 'menuitem').props['aria-busy'], false)
  assert.match(JSON.stringify(find(output, (node) => node.props.role === 'menuitem')), /"Inherit"/)
})

function loadWithRuntime(runtime, commandUi) {
  const registrations = []
  vm.runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), {
    window: {
      __ModuleLoader__: {
        load({ factory }) {
          const result = factory((name) => name === 'react' ? runtime.React : new Proxy({}, { get: (_target, key) => key }))
          result.apply({
            get: (key) => key === 'commandUi' ? commandUi : undefined,
            slots: { inject(_name, callback) { callback() }, register(definition, component) { registrations.push(component) } },
            effect() {},
          })
        },
      },
    },
  })
  return registrations
}

function advisorModelHarness(initialView, routes = [{ provider: 'anthropic', model: 'claude-fable-5-2' }, { provider: 'openrouter', model: '~deepseek/deepseek-flash-latest' }]) {
  const runtime = createRuntime()
  const calls = []
  const reports = []
  const commandUi = { execute: async (_target, line) => { calls.push(line); return { kind: 'success' } } }
  const registrations = loadWithRuntime(runtime, commandUi)
  const state = { view: { active: true, advisorModel: null, verifierModel: null, pending: false, pendingTarget: null, pendingSince: null, failure: null, ...initialView } }
  const wrapper = registrations[1]({ useProjection: (key) => key === 'advisorModelRoutes' ? routes : state.view, reportFailure: (message) => reports.push(message) })
  const cell = runtime.mount(wrapper.type)
  let output = cell.render(wrapper.props)
  const cellNode = () => find(output, (node) => node.props.role === 'menuitem')
  const cellValue = () => find(cellNode(), (node) => node.props.className === 'adv-cell-value')
  const rows = () => {
    const flyout = find(output, (node) => typeof node.type === 'function' && node.props.cellRef)
    return flyout ? flyout.children[0]({ current: () => {} }) : null
  }
  const openFlyout = () => {
    if (cellNode().props['aria-expanded'] !== true) cellNode().props.onClick()
    output = cell.render()
  }
  const selectRow = (labelOrTitle) => {
    openFlyout()
    const row = findAll(rows(), (node) => typeof node.props.onSelect === 'function')
      .find((candidate) => (candidate.props.title ?? candidate.props.label) === labelOrTitle)
    assert.ok(row, `row ${labelOrTitle}`)
    row.props.onSelect()
  }
  return {
    state, calls, reports,
    rerender: () => { output = cell.render(); return output },
    cellNode, cellValue, rows, openFlyout, selectRow,
  }
}

test('advisor model cell defaults to Inherit and lists Inherit, then authorized routes by provider', () => {
  const harness = advisorModelHarness({})
  const cell = harness.cellNode()
  assert.equal(cell.props['aria-haspopup'], 'menu')
  assert.match(JSON.stringify(cell), /"Advisor model"/)
  assert.equal(harness.cellValue().children[0], 'Inherit')
  harness.openFlyout()
  const items = harness.rows()
  assert.deepEqual(findAll(items, (node) => typeof node.props.onSelect === 'function').map((row) => `${row.props.title ?? row.props.label}=${row.props.checked}`), [
    'Inherit=true',
    'anthropic/claude-fable-5-2=false',
    'openrouter/~deepseek/deepseek-flash-latest=false',
  ])
  assert.equal(findAll(items, (node) => node.props.role === 'separator').length, 1)
  assert.deepEqual(findAll(items, (node) => node.props.role === 'group').map((group) => group.props['aria-label']), ['anthropic', 'openrouter'])

  const missingField = advisorModelHarness({ advisorModel: undefined })
  assert.equal(missingField.cellValue().children[0], 'Inherit')
  const inactive = advisorModelHarness({ active: false })
  assert.equal(inactive.cellNode().props['data-inactive'], '')
  const routed = advisorModelHarness({ advisorModel: { provider: 'openrouter', model: '~deepseek/deepseek-flash-latest' }, verifierModel: { provider: 'anthropic', model: 'claude-fable-5-2' } })
  assert.equal(routed.cellValue().children[0], 'deepseek-flash-latest', 'reads advisorModel, not verifierModel')
})

test('advisor model selections send the matching command; the current value sends nothing', async () => {
  const route = advisorModelHarness({})
  route.selectRow('anthropic/claude-fable-5-2')
  await ticks()
  assert.deepEqual(route.calls, ['/advisor model anthropic/claude-fable-5-2'])
  route.rerender()
  assert.equal(route.cellNode().props['aria-busy'], true)

  const inherit = advisorModelHarness({ advisorModel: { provider: 'anthropic', model: 'claude-fable-5-2' } })
  inherit.selectRow('Inherit')
  await ticks()
  assert.deepEqual(inherit.calls, ['/advisor model inherit'])

  const same = advisorModelHarness({})
  same.selectRow('Inherit')
  await ticks()
  assert.deepEqual(same.calls, [])
  const sameRoute = advisorModelHarness({ advisorModel: { provider: 'anthropic', model: 'claude-fable-5-2' } })
  sameRoute.selectRow('anthropic/claude-fable-5-2')
  await ticks()
  assert.deepEqual(sameRoute.calls, [])

  const locked = advisorModelHarness({ pending: true, pendingTarget: 'advisorModel', pendingSince: Date.now() })
  locked.openFlyout()
  assert.equal(findAll(locked.rows(), (node) => typeof node.props.onSelect === 'function').every((row) => row.props.disabled === true), true)
  locked.selectRow('anthropic/claude-fable-5-2')
  await ticks()
  assert.deepEqual(locked.calls, [])
})

test('advisor model shows the stale label for an unauthorized saved route', () => {
  const stale = advisorModelHarness({ advisorModel: { provider: 'gone', model: 'retired-model' } })
  assert.equal(stale.cellValue().children[0], 'Saved route unavailable')
  assert.equal(stale.cellValue().props['data-warning'], '')
  stale.openFlyout()
  const items = stale.rows()
  assert.match(JSON.stringify(items), /The saved advisor route is unavailable. Select Inherit to reset it./)
  assert.doesNotMatch(JSON.stringify(findAll(items, (node) => typeof node.props.onSelect === 'function')), /retired-model/)

  const noRoutes = advisorModelHarness({}, null)
  noRoutes.openFlyout()
  assert.equal(findAll(noRoutes.rows(), (node) => typeof node.props.onSelect === 'function').length, 1)
  assert.match(JSON.stringify(noRoutes.rows()), /Inherit only/)
})

test('advisor model reports only advisorModel-target failures after its own selection', async () => {
  const harness = advisorModelHarness({})
  harness.selectRow('anthropic/claude-fable-5-2')
  await ticks()
  assert.deepEqual(harness.calls, ['/advisor model anthropic/claude-fable-5-2'])
  harness.state.view = { ...harness.state.view, failure: { count: 1, text: 'nope', target: 'verifierModel' } }
  harness.rerender()
  harness.rerender()
  assert.deepEqual(harness.reports, [], 'a verifier failure is not reported by the Advisor model cell')
  assert.equal(harness.cellNode().props['aria-busy'], true)
  harness.state.view = { ...harness.state.view, failure: { count: 2, text: 'nope', target: 'advisorModel' } }
  harness.rerender()
  harness.rerender()
  assert.deepEqual(harness.reports, ['Could not update Advisor model.'])
  assert.equal(harness.cellNode().props['aria-busy'], false)
  assert.equal(harness.cellValue().children[0], 'Inherit')
})
