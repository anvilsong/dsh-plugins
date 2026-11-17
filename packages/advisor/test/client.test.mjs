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
          // Exactly slots: an inject entry for a service the page lacks (such
          // as modelDirectories) leaves the whole client entry pending and
          // breaks web boot, so that service is read lazily instead.
          assert.deepEqual(Array.from(result.inject), ['slots'])
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

  // State order: anchor ref (no state), open, desired (a { key, effort } setting
  // or null), then useCommand busy/error, then the model-directory version.
  const sending = render({}, [false, { key: 'anthropic/claude-haiku-5-5', effort: 'high' }])
  const sendingCell = find(sending, (node) => node.props.role === 'menuitem')
  assert.equal(sendingCell.props['aria-busy'], true, 'index 1 is the desired setting')
  assert.equal(sendingCell.props.title, 'anthropic/claude-haiku-5-5 effort=high')
  assert.match(JSON.stringify(sendingCell), /claude-haiku-5-5/)
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
  assert.deepEqual(reports, ['English Host rejection'], 'the Host text is reported verbatim')
  for (const text of ['', undefined]) {
    const fallback = []
    const empty = advisorOption.type({
      ...advisorOption.props,
      useProjection: () => ({ active: false, pending: false, pendingTarget: null }),
      ctx: { get: (key) => key === 'commandUi' ? { execute: async () => ({ kind: 'error', text }) } : undefined },
      reportFailure: (message) => fallback.push(message),
      t: (key) => ({ 'chip.failed': '无法更新顾问。' })[key] ?? key,
    })
    await find(empty, (node) => node.type === 'Switch').props.onChange(true)
    await Promise.resolve()
    await Promise.resolve()
    assert.deepEqual(fallback, ['无法更新顾问。'], `empty Host text (${String(text)}) falls back to the localized generic`)
  }
})

const ticks = async (count = 6) => { for (let index = 0; index < count; index++) await Promise.resolve() }

// A tiny hook runtime: one persistent hook list per instance, effects run
// when their dependencies change, cleanups run on unmount. `trace` lists the
// hook kinds of the latest render, to compare hook order across renders.
function createRuntime() {
  let current = null
  const deps = (a, b) => a === undefined || b === undefined || a.length !== b.length || a.some((value, index) => !Object.is(value, b[index]))
  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const instance = current
      instance.trace.push('state')
      const index = instance.index++
      if (!(index in instance.hooks)) instance.hooks[index] = { value: initial }
      const hook = instance.hooks[index]
      return [hook.value, (next) => {
        hook.value = typeof next === 'function' ? next(hook.value) : next
        instance.dirty = true
      }]
    },
    useRef(initial) {
      current.trace.push('ref')
      const index = current.index++
      if (!(index in current.hooks)) current.hooks[index] = { current: initial }
      return current.hooks[index]
    },
    useEffect(effect, list) {
      current.trace.push('effect')
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
    const instance = { hooks: [], index: 0, pending: [], dirty: false, props: null, trace: [] }
    const render = (props) => {
      if (props !== undefined) instance.props = props
      current = instance
      instance.index = 0
      instance.pending = []
      instance.dirty = false
      instance.trace = []
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
  assert.deepEqual(reports, ['Advisor is already updating. Try again after it finishes.'])
  assert.equal(find(output, (node) => node.props.role === 'menuitem').props['aria-busy'], false)
  assert.match(JSON.stringify(find(output, (node) => node.props.role === 'menuitem')), /"Inherit"/)
})

// `getService` answers every other ctx.get (locale, modelDirectories); it may
// throw, as a lazily read service may.
function loadWithRuntime(runtime, commandUi, getService = () => undefined) {
  const registrations = []
  vm.runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), {
    window: {
      __ModuleLoader__: {
        load({ factory }) {
          const result = factory((name) => name === 'react' ? runtime.React : new Proxy({}, { get: (_target, key) => key }))
          result.apply({
            get: (key) => key === 'commandUi' ? commandUi : getService(key),
            slots: { inject(_name, callback) { callback() }, register(definition, component) { registrations.push(component) } },
            effect(callback) { callback() },
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

// No model directory here: the efforts are unknown, so a pick sends today's
// line without an effort token (the directory cases are pinned further down).
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
  assert.deepEqual(harness.reports, ['nope'])
  assert.equal(harness.cellNode().props['aria-busy'], false)
  assert.equal(harness.cellValue().children[0], 'Inherit')
})

test('advisor model failure with empty or missing Host text falls back to the localized generic', async () => {
  for (const text of ['', undefined]) {
    const harness = advisorModelHarness({})
    harness.selectRow('anthropic/claude-fable-5-2')
    await ticks()
    harness.state.view = { ...harness.state.view, failure: { count: 1, text, target: 'advisorModel' } }
    harness.rerender()
    harness.rerender()
    assert.deepEqual(harness.reports, ['Could not update Advisor model.'])
  }
})

test('verifier flyout failure with empty Host text falls back to the localized generic', async () => {
  const runtime = createRuntime()
  const reports = []
  const registrations = loadWithRuntime(runtime, { execute: async () => ({ kind: 'success' }) })
  let view = { active: true, verifierModel: null, pending: false, pendingTarget: null, pendingSince: null, failure: null }
  const wrapper = registrations[2]({ useProjection: (key) => key === 'advisorModelRoutes' ? [{ provider: 'anthropic', model: 'claude-haiku-5-5' }] : view, reportFailure: (message) => reports.push(message) })
  const cell = runtime.mount(wrapper.type)
  let output = cell.render(wrapper.props)
  find(output, (node) => node.props.role === 'menuitem').props.onClick()
  output = cell.render()
  const flyout = find(output, (node) => typeof node.type === 'function' && node.props.cellRef)
  findAll(flyout.children[0]({ current: () => {} }), (node) => typeof node.props.onSelect === 'function')
    .find((row) => row.props.title === 'anthropic/claude-haiku-5-5').props.onSelect()
  await ticks()
  view = { ...view, failure: { count: 1, text: '', target: 'verifierModel' } }
  cell.render()
  cell.render()
  assert.deepEqual(reports, ['Could not update Verifier model.'])
})

test('advisor switch reports the Host failure text, falling back to the generic when empty', async () => {
  for (const [text, expected] of [['Host says no', 'Host says no'], ['', 'Could not update Advisor.'], [undefined, 'Could not update Advisor.']]) {
    const runtime = createRuntime()
    const reports = []
    const registrations = loadWithRuntime(runtime, { execute: async () => ({ kind: 'success' }) })
    let view = { active: false, verifierModel: null, advisorModel: null, pending: false, pendingTarget: null, pendingSince: null, failure: null }
    const wrapper = registrations[0]({ useProjection: () => view, reportFailure: (message) => reports.push(message) })
    const cell = runtime.mount(wrapper.type)
    let output = cell.render(wrapper.props)
    await find(output, (node) => node.type === 'Switch').props.onChange(true)
    await ticks()
    view = { ...view, failure: { count: 1, text, target: 'advisor' } }
    cell.render()
    cell.render()
    assert.deepEqual(reports, [expected])
  }
})

// ---- Effort group: efforts from the session's model directory ----

const FABLE = { provider: 'anthropic', model: 'claude-fable-5-2' }
const OPUS = { provider: 'anthropic', model: 'claude-opus-5-5' }
const MAX_ONLY = { provider: 'anthropic', model: 'claude-max-only' }
const PLAIN = { provider: 'anthropic', model: 'claude-plain' }
const UNLISTED = { provider: 'anthropic', model: 'claude-unlisted' }
const FLASH = { provider: 'openrouter', model: '~deepseek/deepseek-flash-latest' }
const ALL_ROUTES = [FABLE, OPUS, MAX_ONLY, PLAIN, UNLISTED, FLASH]
const keyOf = (route) => `${route.provider}/${route.model}`
const withEffort = (route, effort) => ({ ...route, effort })

const EFFORT_NAMES = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }
const efforts = (...ids) => ids.map((id) => ({ id, name: EFFORT_NAMES[id] ?? id }))
// Provider groups as the directory snapshot holds them, efforts least to
// greatest. PLAIN advertises none; UNLISTED is authorized but not listed.
const CATALOG = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    models: [
      { id: 'claude-fable-5-2', name: 'Fable 5.2', reasoning: { efforts: efforts('xhigh', 'max'), defaultEffort: 'xhigh' } },
      { id: 'claude-opus-5-5', name: 'Opus 5.5', reasoning: { efforts: efforts('low', 'medium', 'high', 'xhigh', 'max'), defaultEffort: 'high' } },
      { id: 'claude-max-only', name: 'Max only', reasoning: { efforts: efforts('max') } },
      { id: 'claude-plain', name: 'Plain' },
    ],
  },
  { id: 'openrouter', name: 'OpenRouter', models: [{ id: '~deepseek/deepseek-flash-latest', name: 'Flash', reasoning: { efforts: efforts('low', 'high') } }] },
]

// ctx.modelDirectories: directoryFor(sessionId).store with getSnapshot/subscribe.
function fakeDirectory(groups = CATALOG) {
  const listeners = new Set()
  let snapshot = { current: null, routable: null, groups, failures: [], status: 'ready', pending: null, error: null }
  const store = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  const sessions = []
  return {
    listeners,
    sessions,
    service: { directoryFor(sessionId) { sessions.push(sessionId); return { store } } },
    publish(next) {
      snapshot = { ...snapshot, groups: next }
      for (const listener of [...listeners]) listener()
    },
  }
}
const directoryService = (directory) => (name) => name === 'modelDirectories' ? directory.service : undefined

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node === null || node === undefined || typeof node !== 'object') return ''
  return textOf(node.children)
}

// One Advisor (registration 1) or Verifier (registration 2) model cell. The
// close handle given to the flyout rows closes the flyout, as ModelFlyout's does.
function cellHarness({ cell = 'advisor', view = {}, routes = ALL_ROUTES, getService, sessionId = 'session-1', execute } = {}) {
  const runtime = createRuntime()
  const calls = []
  const reports = []
  const commandUi = {
    execute: async (_target, line) => {
      calls.push(line)
      return execute === undefined ? { kind: 'success' } : execute(line)
    },
  }
  const registrations = loadWithRuntime(runtime, commandUi, getService)
  const field = cell === 'verifier' ? 'verifierModel' : 'advisorModel'
  // `routes` is the advisorModelRoutes projection; tests may change it.
  const state = { view: { active: true, advisorModel: null, verifierModel: null, pending: false, pendingTarget: null, pendingSince: null, failure: null, ...view }, routes }
  const wrapper = registrations[cell === 'verifier' ? 2 : 1]({
    sessionId,
    useProjection: (name) => name === 'advisorModelRoutes' ? state.routes : state.view,
    reportFailure: (message) => reports.push(message),
  })
  const mounted = runtime.mount(wrapper.type)
  let output = mounted.render(wrapper.props)
  const closes = []
  const rerender = () => { output = mounted.render(); return output }
  // A Host re-render with changed slot props (for example a session id).
  const setProps = (changes) => { output = mounted.render({ ...mounted.instance.props, ...changes }); return output }
  // The cell's `desired` setting read from its hook state: index 3, after the
  // anchor ref, the cell ref and `open` (the order the hook-order tests pin).
  const desired = () => {
    assert.deepEqual(mounted.instance.trace.slice(0, 4), ['ref', 'ref', 'state', 'state'], 'hook order of the desired slot')
    const value = mounted.instance.hooks[3].value
    return value === null ? null : { ...value }
  }
  const cellNode = () => find(output, (node) => node.props.role === 'menuitem')
  const cellValue = () => find(cellNode(), (node) => node.props.className === 'adv-cell-value')
  const items = () => {
    const flyout = find(output, (node) => typeof node.type === 'function' && node.props.cellRef)
    if (flyout === undefined) return undefined
    return flyout.children[0]({ current: (target) => { closes.push(target); flyout.props.onClose() } })
  }
  const rows = () => findAll(items(), (node) => typeof node.props.onSelect === 'function')
  const openFlyout = () => {
    if (cellNode().props['aria-expanded'] !== true) cellNode().props.onClick()
    return rerender()
  }
  const closeFlyout = () => {
    if (cellNode().props['aria-expanded'] === true) cellNode().props.onClick()
    return rerender()
  }
  // The Effort group by its element key: its label names its model.
  const effortGroup = () => find(items(), (node) => node.props.role === 'group' && node.props.key === 'effort')
  const effortHeading = () => textOf(find(effortGroup(), (node) => node.props.className === 'adv-heading'))
  const effortRows = () => {
    const group = effortGroup()
    return group === undefined ? undefined : findAll(group, (node) => typeof node.props.onSelect === 'function')
  }
  // `<label>[ (<note>)][ [warning]]=<checked>` per Effort row; undefined without the group.
  const effortSummary = () => effortRows()?.map((row) => `${row.props.label}${row.props.note ? ` (${row.props.note})` : ''}${row.props.warning ? ' [warning]' : ''}=${row.props.checked}`)
  const settle = async () => {
    await ticks()
    rerender()
  }
  const pickModel = async (route) => {
    openFlyout()
    const row = rows().find((candidate) => candidate.props.title === keyOf(route))
    assert.ok(row, `model row ${keyOf(route)}`)
    row.props.onSelect()
    await settle()
  }
  const pickInherit = async () => {
    openFlyout()
    rows().find((candidate) => candidate.props.label === 'Inherit').props.onSelect()
    await settle()
  }
  const pickEffort = async (label) => {
    openFlyout()
    const row = effortRows()?.find((candidate) => candidate.props.label === label)
    assert.ok(row, `effort row ${label}`)
    row.props.onSelect()
    await settle()
  }
  // The Host records a rejection of this cell's command.
  const fail = (text) => {
    state.view = { ...state.view, failure: { count: (state.view.failure?.count ?? 0) + 1, text, target: field } }
    rerender()
    rerender()
  }
  // The session saves a setting for this cell.
  const save = (route) => {
    state.view = { ...state.view, [field]: route }
    rerender()
    rerender()
  }
  return {
    state, calls, reports, closes, mounted,
    rerender, setProps, desired, cellNode, cellValue, items, rows, openFlyout, closeFlyout,
    effortGroup, effortHeading, effortRows, effortSummary,
    pickModel, pickInherit, pickEffort, fail, save,
    trace: () => mounted.instance.trace.join(','),
  }
}

test('effort source: without a usable model directory the efforts are unknown: no Effort group, no automatic effort', async () => {
  const torn = { getSnapshot() { throw new Error('torn down') }, subscribe() { throw new Error('torn down') } }
  const variants = [
    ['service absent', () => undefined],
    ['ctx.get throws', (name) => { if (name === 'modelDirectories') throw new Error('no such service') }],
    ['directoryFor throws', (name) => name === 'modelDirectories'
      ? { directoryFor() { throw new Error('ui-model-selection: session "session-1" resolved no scope') } }
      : undefined],
    ['no directoryFor', (name) => name === 'modelDirectories' ? {} : undefined],
    ['no store', (name) => name === 'modelDirectories' ? { directoryFor: () => ({}) } : undefined],
    ['store throws', (name) => name === 'modelDirectories' ? { directoryFor: () => ({ store: torn }) } : undefined],
    ['groups not loaded', directoryService(fakeDirectory([]))],
    ['groups malformed', directoryService(fakeDirectory(null))],
    ['provider not listed', directoryService(fakeDirectory([{ id: 'openai', models: [{ id: 'claude-fable-5-2', reasoning: { efforts: efforts('xhigh') } }, { id: 'claude-opus-5-5', reasoning: { efforts: efforts('xhigh') } }] }]))],
    ['models malformed', directoryService(fakeDirectory([{ id: 'anthropic', models: null }]))],
    ['model not listed', directoryService(fakeDirectory([{ id: 'anthropic', models: [{ id: 'claude-other', reasoning: { efforts: efforts('xhigh') } }] }]))],
    ['reasoning malformed', directoryService(fakeDirectory([{
      id: 'anthropic',
      models: [{ id: 'claude-opus-5-5', reasoning: { efforts: 'xhigh' } }, { id: 'claude-fable-5-2', reasoning: null }],
    }]))],
  ]
  for (const [name, getService] of variants) {
    const plain = cellHarness({ view: { advisorModel: FABLE }, getService })
    plain.openFlyout()
    assert.equal(plain.effortGroup(), undefined, `${name}: no Effort group without a saved effort`)
    assert.equal(findAll(plain.items(), (node) => node.props.role === 'separator').length, 1, `${name}: no second separator`)
    await plain.pickModel(OPUS)
    assert.deepEqual(plain.calls, ['/advisor model anthropic/claude-opus-5-5'], `${name}: no automatic effort`)

    const saved = cellHarness({ view: { advisorModel: withEffort(FABLE, 'xhigh') }, getService })
    saved.openFlyout()
    assert.deepEqual(saved.effortSummary(), ['Default (recommended)=false', 'xhigh=true'], `${name}: Default plus the saved id, no warning`)
  }

  const directory = fakeDirectory()
  const noSession = cellHarness({ view: { advisorModel: withEffort(FABLE, 'xhigh') }, getService: directoryService(directory), sessionId: null })
  noSession.openFlyout()
  assert.deepEqual(noSession.effortSummary(), ['Default (recommended)=false', 'xhigh=true'], 'no session id: unknown')
  assert.equal(directory.sessions.length, 0, 'never asks for a directory without a session id')
})

test('effort source: a model listed without efforts gets no group unless an effort is saved, and that saved id warns', () => {
  const getService = directoryService(fakeDirectory())
  const plain = cellHarness({ view: { advisorModel: PLAIN }, getService })
  plain.openFlyout()
  assert.equal(plain.effortGroup(), undefined)

  const saved = cellHarness({ view: { advisorModel: withEffort(PLAIN, 'high') }, getService })
  saved.openFlyout()
  assert.deepEqual(saved.effortSummary(), ['Default (recommended)=false', 'high [warning]=true'])

  const empty = cellHarness({
    view: { advisorModel: withEffort(FABLE, 'xhigh') },
    getService: directoryService(fakeDirectory([{ id: 'anthropic', models: [{ id: 'claude-fable-5-2', reasoning: { efforts: [] } }] }])),
  })
  empty.openFlyout()
  assert.deepEqual(empty.effortSummary(), ['Default (recommended)=false', 'xhigh [warning]=true'], 'an empty list is none')
})

test('effort group: after a separator, Default, then the saved model\'s advertised efforts by name, in order', () => {
  const getService = directoryService(fakeDirectory())
  const opus = cellHarness({ view: { advisorModel: OPUS }, getService })
  opus.openFlyout()
  assert.deepEqual(opus.effortSummary(), ['Default (High)=true', 'Low=false', 'Medium=false', 'High=false', 'Extra high (recommended)=false', 'Max=false'])
  assert.deepEqual(opus.effortRows().map((row) => row.props.title ?? '-'), ['-', 'low', 'medium', 'high', 'xhigh', 'max'])
  const items = Array.from(opus.items()).filter(Boolean)
  assert.deepEqual(items.map((node) => node.props.role ?? node.props.label), ['Inherit', 'separator', 'group', 'group', 'separator', 'group'])
  // The group's label and heading name its model, so it reads as that model's efforts.
  assert.deepEqual(items.filter((node) => node.props.role === 'group').map((node) => node.props['aria-label']), ['anthropic', 'openrouter', 'Effort for claude-opus-5-5'])
  assert.equal(opus.effortHeading(), 'Effort for claude-opus-5-5')
  assert.equal(find(opus.effortGroup(), (node) => node.props.className === 'adv-heading').props['aria-hidden'], 'true', 'the label speaks for the heading')

  // The Effort rows are the flyout's menuitemradio rows, so its key handler
  // (arrows, Home/End, Tab, Enter/Space on the button) covers them.
  const modelRow = opus.rows().find((row) => row.props.title === keyOf(OPUS))
  assert.equal(opus.effortRows().every((row) => row.type === modelRow.type), true)
  const recommended = opus.effortRows()[4]
  const rendered = recommended.type(recommended.props)
  assert.equal(rendered.props.role, 'menuitemradio')
  assert.equal(rendered.props['aria-checked'], false)
  assert.equal(rendered.props['data-warning'], undefined)
  assert.equal(textOf(find(rendered, (node) => node.props.className === 'adv-option-label')), 'Extra high')
  assert.equal(textOf(find(rendered, (node) => node.props.className === 'adv-option-note')), 'recommended')
  const plainRow = modelRow.type(modelRow.props)
  assert.equal(find(plainRow, (node) => node.props.className === 'adv-option-note'), undefined, 'model rows carry no note')

  const flash = cellHarness({ view: { advisorModel: FLASH }, getService })
  flash.openFlyout()
  assert.deepEqual(flash.effortSummary(), ['Default=true', 'Low=false', 'High (recommended)=false'], 'only the saved model\'s efforts')
  assert.equal(flash.effortHeading(), 'Effort for ~deepseek/deepseek-flash-latest', 'the model id as its row shows it')

  const savedMax = cellHarness({ view: { advisorModel: withEffort(FABLE, 'max') }, getService })
  savedMax.openFlyout()
  assert.deepEqual(savedMax.effortSummary(), ['Default (Extra high)=false', 'Extra high (recommended)=false', 'Max=true'], 'the mark stays when the saved effort differs')
  const savedXhigh = cellHarness({ view: { advisorModel: withEffort(FABLE, 'xhigh') }, getService })
  savedXhigh.openFlyout()
  assert.deepEqual(savedXhigh.effortSummary(), ['Default (Extra high)=false', 'Extra high (recommended)=true', 'Max=false'])

  const messy = cellHarness({
    view: { advisorModel: OPUS },
    getService: directoryService(fakeDirectory([{
      id: 'anthropic',
      models: [{
        id: 'claude-opus-5-5',
        reasoning: {
          efforts: [{ id: 'low', name: '' }, { id: '' }, { id: 'two words', name: 'Spaced' }, { id: 7, name: 'Seven' }, null,
            { id: 'high', name: 'High' }, { id: 'high', name: 'High again' }, { id: 'max' }],
        },
      }],
    }])),
  })
  messy.openFlyout()
  assert.deepEqual(messy.effortSummary(), ['Default=true', 'low=false', 'High (recommended)=false', 'max=false'],
    'ids a command token cannot carry and repeats are skipped; a missing name shows the id')

  const verifier = cellHarness({ cell: 'verifier', view: { verifierModel: OPUS }, getService })
  verifier.openFlyout()
  assert.deepEqual(verifier.effortSummary(), ['Default (High) (recommended)=true', 'Low=false', 'Medium=false', 'High=false', 'Extra high=false', 'Max=false'],
    'the Verifier model recommends Default')
})

test('a saved effort the model does not advertise is appended last in the warning colour, and the menu never clears it', async () => {
  const directory = fakeDirectory([])
  const harness = cellHarness({ view: { advisorModel: withEffort(FABLE, 'turbo') }, getService: directoryService(directory) })
  directory.publish(CATALOG)
  harness.rerender()
  harness.openFlyout()
  assert.deepEqual(harness.effortSummary(), ['Default (Extra high)=false', 'Extra high (recommended)=false', 'Max=false', 'turbo [warning]=true'])
  const unlisted = harness.effortRows().at(-1)
  assert.equal(unlisted.props.title, 'turbo')
  assert.equal(unlisted.type(unlisted.props).props['data-warning'], '')
  const css = textOf(find(harness.rerender(), (node) => node.type === 'style'))
  assert.match(css, /\.adv-cell-value\[data-warning\]\{color:var\(--dsw-alias-state-warn-label\)\}/)
  assert.match(css, /\.adv-option\[data-warning\] \.adv-option-label\{color:var\(--dsw-alias-state-warn-label\)\}/, 'the cell\'s own warning token')
  assert.equal(textOf(harness.cellValue()), 'claude-fable-5-2 · turbo')
  harness.closeFlyout()
  await ticks()
  assert.deepEqual(harness.calls, [], 'nothing is sent on its own')
  await harness.pickEffort('turbo')
  assert.deepEqual(harness.calls, [], 'the saved effort\'s row sends nothing')
  await harness.pickEffort('Default (Extra high)')
  assert.deepEqual(harness.calls, ['/advisor model anthropic/claude-fable-5-2'], 'only a pick changes it')
})

test('recommended default: another model\'s row sends its highest advertised effort below max for the Advisor model', async () => {
  const getService = directoryService(fakeDirectory())
  for (const [route, line] of [
    [OPUS, '/advisor model anthropic/claude-opus-5-5 effort=xhigh'],
    [FABLE, '/advisor model anthropic/claude-fable-5-2 effort=xhigh'],
    [FLASH, '/advisor model openrouter/~deepseek/deepseek-flash-latest effort=high'],
    [MAX_ONLY, '/advisor model anthropic/claude-max-only'],
    [PLAIN, '/advisor model anthropic/claude-plain'],
    [UNLISTED, '/advisor model anthropic/claude-unlisted'],
  ]) {
    const harness = cellHarness({ getService })
    await harness.pickModel(route)
    assert.deepEqual(harness.calls, [line], keyOf(route))
    assert.equal(harness.closes.length, 1, 'the pick closes the flyout')
    assert.equal(harness.cellNode().props['aria-expanded'], false)
    assert.equal(harness.cellNode().props['aria-busy'], true)
  }

  const fromSaved = cellHarness({ view: { advisorModel: withEffort(FABLE, 'max') }, getService })
  await fromSaved.pickModel(OPUS)
  assert.deepEqual(fromSaved.calls, ['/advisor model anthropic/claude-opus-5-5 effort=xhigh'])
  assert.equal(textOf(fromSaved.cellValue()), 'claude-opus-5-5 · xhigh', 'the cell shows the setting being saved')
  assert.equal(fromSaved.cellNode().props.title, 'anthropic/claude-opus-5-5 effort=xhigh')
  fromSaved.save(withEffort(OPUS, 'xhigh'))
  assert.equal(fromSaved.cellNode().props['aria-busy'], false, 'saved: the desired setting is settled')
  assert.equal(textOf(fromSaved.cellValue()), 'claude-opus-5-5 · xhigh')
})

test('the Verifier model recommends Default: a model pick sends exactly the line it sends without a directory', async () => {
  const getService = directoryService(fakeDirectory())
  for (const route of [OPUS, FABLE, FLASH, MAX_ONLY, PLAIN, UNLISTED]) {
    const harness = cellHarness({ cell: 'verifier', getService })
    await harness.pickModel(route)
    assert.deepEqual(harness.calls, [`/advisor verifier-model ${keyOf(route)}`], keyOf(route))
  }
})

test('effort rows send the full line for the saved model, Default the bare route, the current effort nothing', async () => {
  const getService = directoryService(fakeDirectory())
  const xhigh = cellHarness({ view: { advisorModel: withEffort(FABLE, 'max') }, getService })
  await xhigh.pickEffort('Extra high')
  assert.deepEqual(xhigh.calls, ['/advisor model anthropic/claude-fable-5-2 effort=xhigh'])
  assert.equal(xhigh.closes.length, 1, 'an effort pick closes the flyout')
  assert.equal(textOf(xhigh.cellValue()), 'claude-fable-5-2 · xhigh')

  const reset = cellHarness({ view: { advisorModel: withEffort(FABLE, 'max') }, getService })
  await reset.pickEffort('Default (Extra high)')
  assert.deepEqual(reset.calls, ['/advisor model anthropic/claude-fable-5-2'])
  assert.equal(textOf(reset.cellValue()), 'claude-fable-5-2')

  const same = cellHarness({ view: { advisorModel: withEffort(FABLE, 'max') }, getService })
  await same.pickEffort('Max')
  assert.deepEqual(same.calls, [])
  assert.equal(same.closes.length, 1, 'still closes')
  const sameDefault = cellHarness({ view: { advisorModel: FABLE }, getService })
  await sameDefault.pickEffort('Default (Extra high)')
  assert.deepEqual(sameDefault.calls, [])

  const max = cellHarness({ view: { advisorModel: OPUS }, getService })
  await max.pickEffort('Max')
  assert.deepEqual(max.calls, ['/advisor model anthropic/claude-opus-5-5 effort=max'], 'a hand-picked max is sent')

  const verifier = cellHarness({ cell: 'verifier', view: { verifierModel: OPUS }, getService })
  await verifier.pickEffort('Low')
  assert.deepEqual(verifier.calls, ['/advisor verifier-model anthropic/claude-opus-5-5 effort=low'])

  const locked = cellHarness({ view: { advisorModel: OPUS, pending: true, pendingTarget: 'verifierModel', pendingSince: Date.now() }, getService })
  locked.openFlyout()
  assert.equal(locked.effortRows().every((row) => row.props.disabled === true), true)
  await locked.pickEffort('Low')
  assert.deepEqual(locked.calls, [])
})

test('the saved model\'s row sends nothing, so a command-set effort survives; Inherit never carries an effort; no retroactive default', async () => {
  const directory = fakeDirectory([])
  const harness = cellHarness({ view: { advisorModel: withEffort(FABLE, 'max') }, getService: directoryService(directory) })
  directory.publish(CATALOG)
  harness.rerender()
  await harness.pickModel(FABLE)
  assert.deepEqual(harness.calls, [])
  assert.equal(harness.closes.length, 1)
  assert.equal(textOf(harness.cellValue()), 'claude-fable-5-2 · max')
  assert.equal(harness.cellNode().props.title, 'anthropic/claude-fable-5-2 effort=max')
  await harness.pickInherit()
  assert.deepEqual(harness.calls, ['/advisor model inherit'])

  const plainDirectory = fakeDirectory([])
  const plain = cellHarness({ view: { advisorModel: FABLE }, getService: directoryService(plainDirectory) })
  plainDirectory.publish(CATALOG)
  plain.rerender()
  plain.openFlyout()
  plain.closeFlyout()
  await ticks()
  assert.deepEqual(plain.calls, [], 'a saved route is never given the default')
  assert.equal(textOf(plain.cellValue()), 'claude-fable-5-2')
  await plain.pickModel(FABLE)
  assert.deepEqual(plain.calls, [])

  const verifier = cellHarness({ cell: 'verifier', view: { verifierModel: withEffort(OPUS, 'low') }, getService: directoryService(fakeDirectory()) })
  await verifier.pickModel(OPUS)
  await verifier.pickInherit()
  assert.deepEqual(verifier.calls, ['/advisor verifier-model inherit'])

  // While another pick is unconfirmed, the saved model's row restores the
  // saved setting as it is, never with the default.
  const back = cellHarness({ view: { advisorModel: withEffort(FABLE, 'max') }, getService: directoryService(fakeDirectory()) })
  await back.pickModel(OPUS)
  assert.equal(back.cellNode().props['aria-busy'], true)
  await back.pickModel(FABLE)
  assert.deepEqual(back.calls, ['/advisor model anthropic/claude-opus-5-5 effort=xhigh', '/advisor model anthropic/claude-fable-5-2 effort=max'])
  assert.equal(back.cellNode().props['aria-busy'], false, 'the saved setting is what the session shows')

  // The row of the model being saved sends nothing either, whatever its effort.
  const unconfirmed = cellHarness({ getService: directoryService(fakeDirectory()) })
  await unconfirmed.pickModel(OPUS)
  await unconfirmed.pickEffort('Max')
  await unconfirmed.pickModel(OPUS)
  assert.deepEqual(unconfirmed.calls, ['/advisor model anthropic/claude-opus-5-5 effort=xhigh', '/advisor model anthropic/claude-opus-5-5 effort=max'])
  assert.equal(textOf(unconfirmed.cellValue()), 'claude-opus-5-5 · max')
})

test('Inherit and a stale or unauthorized route show no Effort group', () => {
  const getService = directoryService(fakeDirectory())
  const inherit = cellHarness({ getService })
  inherit.openFlyout()
  assert.equal(inherit.effortGroup(), undefined)
  assert.equal(findAll(inherit.items(), (node) => node.props.role === 'separator').length, 1)

  const stale = cellHarness({ view: { advisorModel: withEffort({ provider: 'gone', model: 'retired-model' }, 'high') }, getService })
  assert.equal(textOf(stale.cellValue()), 'Saved route unavailable')
  assert.equal(stale.cellValue().props['data-warning'], '')
  assert.equal(stale.cellValue().props['data-effort'], undefined)
  stale.openFlyout()
  assert.equal(stale.effortGroup(), undefined)

  const unauthorized = cellHarness({ view: { advisorModel: withEffort(OPUS, 'high') }, routes: [FABLE], getService })
  unauthorized.openFlyout()
  assert.equal(unauthorized.effortGroup(), undefined, 'listed in the directory but not authorized')
  assert.equal(textOf(unauthorized.cellValue()), 'Saved route unavailable')

  const noRoutes = cellHarness({ routes: null, getService })
  noRoutes.openFlyout()
  assert.equal(noRoutes.effortGroup(), undefined)

  const verifier = cellHarness({ cell: 'verifier', getService })
  verifier.openFlyout()
  assert.equal(verifier.effortGroup(), undefined)
})

test('a refused automatic effort sends the next pick of that model without it; a refused hand-picked effort only reports', async () => {
  const getService = directoryService(fakeDirectory())
  const refusal = 'Advisor model effort xhigh is not offered by anthropic/claude-opus-5-5; nothing was changed. Advertised efforts: high (High).'
  const harness = cellHarness({ getService })
  await harness.pickModel(OPUS)
  assert.deepEqual(harness.calls, ['/advisor model anthropic/claude-opus-5-5 effort=xhigh'])
  harness.fail(refusal)
  assert.deepEqual(harness.reports, [refusal], 'the Host text, verbatim')
  assert.equal(harness.cellNode().props['aria-busy'], false)
  assert.equal(textOf(harness.cellValue()), 'Inherit')
  await ticks()
  assert.equal(harness.calls.length, 1, 'no automatic retry')
  await harness.pickModel(OPUS)
  assert.deepEqual(harness.calls.slice(1), ['/advisor model anthropic/claude-opus-5-5'])
  harness.save(OPUS)
  await harness.pickModel(FABLE)
  assert.deepEqual(harness.calls.slice(2), ['/advisor model anthropic/claude-fable-5-2 effort=xhigh'], 'other models keep their default')
  harness.save(withEffort(FABLE, 'xhigh'))
  await harness.pickModel(OPUS)
  assert.deepEqual(harness.calls.slice(3), ['/advisor model anthropic/claude-opus-5-5'], 'the refused model stays without the automatic effort')

  const outcomes = [{ kind: 'error', text: 'Advisor is already updating. Try again after it finishes.' }]
  const refusedLine = cellHarness({ getService, execute: () => outcomes.shift() ?? { kind: 'success' } })
  await refusedLine.pickModel(OPUS)
  assert.deepEqual(refusedLine.reports, ['Advisor is already updating. Try again after it finishes.'])
  assert.equal(refusedLine.cellNode().props['aria-busy'], false)
  await refusedLine.pickModel(OPUS)
  assert.deepEqual(refusedLine.calls, ['/advisor model anthropic/claude-opus-5-5 effort=xhigh', '/advisor model anthropic/claude-opus-5-5'],
    'a refused command line takes the same escape')

  const handRefusal = 'Advisor model effort max for anthropic/claude-opus-5-5 could not be checked: the check timed out after 10 s; nothing was changed.'
  const hand = cellHarness({ view: { advisorModel: OPUS }, getService })
  await hand.pickEffort('Max')
  hand.fail(handRefusal)
  assert.deepEqual(hand.reports, [handRefusal])
  assert.equal(textOf(hand.cellValue()), 'claude-opus-5-5')
  await hand.pickEffort('Max')
  hand.fail(handRefusal)
  hand.save(FABLE)
  await hand.pickModel(OPUS)
  assert.deepEqual(hand.calls, [
    '/advisor model anthropic/claude-opus-5-5 effort=max',
    '/advisor model anthropic/claude-opus-5-5 effort=max',
    '/advisor model anthropic/claude-opus-5-5 effort=xhigh',
  ], 'a hand-picked refusal leaves both the effort row and the automatic default alone')
})

test('the flyout rows never change while it is open; the next open shows the directory update', async () => {
  const directory = fakeDirectory([])
  const harness = cellHarness({ view: { advisorModel: FABLE }, getService: directoryService(directory) })
  harness.openFlyout()
  const before = harness.rows().length
  assert.equal(harness.effortGroup(), undefined)
  directory.publish(CATALOG)
  assert.equal(harness.mounted.instance.dirty, true, 'a directory update re-renders the cell')
  harness.rerender()
  assert.equal(harness.effortGroup(), undefined, 'no row appears while open')
  assert.equal(harness.rows().length, before)
  harness.closeFlyout()
  harness.openFlyout()
  assert.deepEqual(harness.effortSummary(), ['Default (Extra high)=true', 'Extra high (recommended)=false', 'Max=false'])
  const open = harness.rows().length
  directory.publish([{ id: 'anthropic', models: [{ id: 'claude-fable-5-2', reasoning: { efforts: efforts('max') } }] }])
  harness.rerender()
  assert.deepEqual(harness.effortSummary(), ['Default (Extra high)=true', 'Extra high (recommended)=false', 'Max=false'], 'no row disappears while open')
  directory.publish([])
  harness.rerender()
  assert.equal(harness.rows().length, open)
  harness.closeFlyout()
  directory.publish([{ id: 'anthropic', models: [{ id: 'claude-fable-5-2', reasoning: { efforts: efforts('max') } }] }])
  harness.rerender()
  harness.openFlyout()
  assert.deepEqual(harness.effortSummary(), ['Default (recommended)=true', 'Max=false'])
  harness.closeFlyout()

  // A model pick reads the directory when it is made.
  const late = fakeDirectory([])
  const pick = cellHarness({ getService: directoryService(late) })
  pick.openFlyout()
  late.publish(CATALOG)
  pick.rerender()
  pick.rows().find((row) => row.props.title === keyOf(OPUS)).props.onSelect()
  await ticks()
  assert.deepEqual(pick.calls, ['/advisor model anthropic/claude-opus-5-5 effort=xhigh'])
})

test('the cell calls the same hooks in the same order on every render path and subscribes once', () => {
  const directory = fakeDirectory([])
  const harness = cellHarness({ view: { advisorModel: withEffort(FABLE, 'xhigh') }, getService: directoryService(directory) })
  const loading = harness.trace()
  // anchor ref, cell ref, open, desired, useCommand (busy, error, mounted, effect), then the directory version and its subscription.
  assert.ok(loading.startsWith('ref,ref,state,state,state,state,ref,effect,state,effect,'), loading)
  assert.equal(directory.listeners.size, 1, 'subscribed while the directory is still loading')
  directory.publish(CATALOG)
  harness.rerender()
  assert.equal(harness.trace(), loading, 'loading -> loaded')
  harness.openFlyout()
  assert.equal(harness.trace(), loading, 'flyout open')
  assert.deepEqual(harness.effortSummary(), ['Default (Extra high)=false', 'Extra high (recommended)=true', 'Max=false'])
  const view = harness.state.view
  harness.state.view = undefined
  assert.equal(harness.rerender(), null)
  assert.equal(harness.trace(), loading, 'a missing view returns only after every hook')
  harness.state.view = view
  harness.rerender()
  assert.equal(harness.cellNode().props['aria-expanded'], false, 'a reset closes the flyout')
  assert.equal(harness.trace(), loading)
  directory.publish([])
  harness.rerender()
  assert.equal(harness.trace(), loading, 'loaded -> unknown')
  assert.equal(directory.listeners.size, 1, 'one subscription across renders')
  assert.equal(directory.sessions.every((id) => id === 'session-1'), true)
  harness.mounted.unmount()
  assert.equal(directory.listeners.size, 0, 'unsubscribed on unmount')
})

test('locale: the effort strings exist in both the en and zh tables and render localized', () => {
  let tables
  const locale = {
    register(namespace, dictionaries) {
      assert.equal(namespace, 'advisor')
      tables = dictionaries
    },
    bind: () => (key) => tables.zh[key] ?? key,
  }
  const directory = fakeDirectory()
  const harness = cellHarness({
    view: { advisorModel: OPUS },
    getService: (name) => name === 'locale' ? locale : name === 'modelDirectories' ? directory.service : undefined,
  })
  // Literal expected wording, never the table compared with itself.
  const expected = {
    en: { 'effort.label': 'Effort', 'effort.labelFor': 'Effort for {model}', 'effort.default': 'Default', 'effort.defaultNamed': 'Default ({effort})', 'effort.recommended': 'recommended' },
    zh: { 'effort.label': '推理等级', 'effort.labelFor': '{model} 的推理等级', 'effort.default': 'Default', 'effort.defaultNamed': 'Default（{effort}）', 'effort.recommended': '推荐' },
  }
  for (const lang of ['en', 'zh']) {
    for (const [key, text] of Object.entries(expected[lang])) assert.equal(tables[lang][key], text, `${lang} ${key}`)
  }
  assert.deepEqual(Object.keys(tables.zh).sort(), Object.keys(tables.en).sort(), 'both tables carry the same keys')
  harness.openFlyout()
  const group = harness.effortGroup()
  assert.equal(group.props['aria-label'], 'claude-opus-5-5 的推理等级', 'the zh label names the model')
  assert.equal(harness.effortHeading(), 'claude-opus-5-5 的推理等级', 'the zh heading names the model')
  const rows = findAll(group, (node) => typeof node.props.onSelect === 'function')
  assert.equal(rows[0].props.label, 'Default（High）', 'the zh pattern names the default')
  assert.equal(rows.find((row) => row.props.title === 'xhigh').props.note, '推荐')
})

test('locale: the en Effort heading and label name the model; a table without the pattern still names it', () => {
  const english = cellHarness({ view: { advisorModel: OPUS }, getService: directoryService(fakeDirectory()) })
  english.openFlyout()
  assert.equal(english.effortGroup().props['aria-label'], 'Effort for claude-opus-5-5')
  assert.equal(english.effortHeading(), 'Effort for claude-opus-5-5')
  // A locale binding that answers an unknown key with the key itself.
  const tables = {}
  const locale = {
    register(_namespace, dictionaries) { Object.assign(tables, { en: { ...dictionaries.en, 'effort.labelFor': undefined } }) },
    bind: () => (key) => tables.en[key] ?? key,
  }
  const directory = fakeDirectory()
  const fallback = cellHarness({
    view: { advisorModel: OPUS },
    getService: (name) => name === 'locale' ? locale : name === 'modelDirectories' ? directory.service : undefined,
  })
  fallback.openFlyout()
  assert.equal(fallback.effortHeading(), 'Effort · claude-opus-5-5')
  assert.equal(fallback.effortGroup().props['aria-label'], 'Effort · claude-opus-5-5')
})

test('the cell shows model · effort with the effort in its own non-shrinking span; nothing is added for Default', () => {
  const harness = cellHarness({ view: { advisorModel: withEffort(FLASH, 'high') } })
  const value = harness.cellValue()
  assert.equal(value.props['data-effort'], '')
  assert.equal(textOf(value), 'deepseek-flash-latest · high')
  assert.deepEqual(Array.from(value.children).map((child) => child.props.className), ['adv-cell-model', 'adv-cell-effort'])
  assert.equal(textOf(value.children[1]), ' · high')
  assert.equal(harness.cellNode().props.title, 'openrouter/~deepseek/deepseek-flash-latest effort=high')
  const css = textOf(find(harness.rerender(), (node) => node.type === 'style'))
  assert.match(css, /\.adv-cell-value\[data-effort\]\{display:flex;justify-content:flex-end/)
  assert.match(css, /\.adv-cell-model\{[^}]*min-width:0[^}]*text-overflow:ellipsis/, 'the model part truncates')
  assert.match(css, /\.adv-cell-effort\{flex:none/, 'the effort never shrinks')
  assert.match(css, /max-height:min\(360px,[^;]*;overflow-x:hidden;overflow-y:auto/, 'the flyout keeps its 360 px cap and scrolls')

  const plain = cellHarness({ view: { advisorModel: FLASH } })
  assert.equal(plain.cellValue().props['data-effort'], undefined)
  assert.deepEqual(Array.from(plain.cellValue().children), ['deepseek-flash-latest'])
  assert.equal(plain.cellNode().props.title, 'openrouter/~deepseek/deepseek-flash-latest')

  const verifier = cellHarness({ cell: 'verifier', view: { verifierModel: withEffort(OPUS, 'low') } })
  assert.equal(textOf(verifier.cellValue()), 'claude-opus-5-5 · low')
})

// One model of the anthropic group, for the Default label cases.
const catalogOf = (reasoning) => [{ id: 'anthropic', models: [{ id: 'claude-fable-5-2', reasoning }] }]

test('Default row: names the model\'s real default effort when the directory advertises it, else plain Default', async () => {
  const named = cellHarness({ view: { advisorModel: FABLE }, getService: directoryService(fakeDirectory()) })
  named.openFlyout()
  assert.deepEqual(named.effortRows().map((row) => row.props.label), ['Default (Extra high)', 'Extra high', 'Max'])
  assert.equal(named.effortRows()[0].props.title, undefined, 'the Default row carries no effort id')

  const opus = cellHarness({ view: { advisorModel: OPUS }, getService: directoryService(fakeDirectory()) })
  opus.openFlyout()
  assert.equal(opus.effortRows()[0].props.label, 'Default (High)', 'the effort\'s name, not its id')

  const plainCases = [
    ['defaultEffort missing', catalogOf({ efforts: efforts('xhigh', 'max') })],
    ['default not advertised', catalogOf({ efforts: efforts('xhigh', 'max'), defaultEffort: 'low' })],
    ['default empty', catalogOf({ efforts: efforts('xhigh', 'max'), defaultEffort: '' })],
    ['default not a string', catalogOf({ efforts: efforts('xhigh', 'max'), defaultEffort: 3 })],
    ['default skipped as unusable id', catalogOf({ efforts: [{ id: 'two words' }, { id: 'xhigh' }], defaultEffort: 'two words' })],
  ]
  for (const [name, groups] of plainCases) {
    const harness = cellHarness({ view: { advisorModel: FABLE }, getService: directoryService(fakeDirectory(groups)) })
    harness.openFlyout()
    assert.equal(harness.effortRows()[0].props.label, 'Default', name)
  }

  // Unknown and none: the group only exists for a saved effort, and its Default stays plain.
  const none = cellHarness({
    view: { advisorModel: withEffort(FABLE, 'xhigh') },
    getService: directoryService(fakeDirectory(catalogOf({ efforts: [], defaultEffort: 'xhigh' }))),
  })
  none.openFlyout()
  assert.equal(none.effortRows()[0].props.label, 'Default', 'none')
  const unknown = cellHarness({ view: { advisorModel: withEffort(FABLE, 'xhigh') }, getService: () => undefined })
  unknown.openFlyout()
  assert.equal(unknown.effortRows()[0].props.label, 'Default', 'unknown')

  // The cell value and title add nothing for Default, named or not.
  assert.equal(textOf(named.cellValue()), 'claude-fable-5-2')
  assert.equal(named.cellNode().props.title, 'anthropic/claude-fable-5-2')

  // The named Default row still sends the bare route, and nothing when it is already current.
  const reset = cellHarness({ view: { advisorModel: withEffort(OPUS, 'max') }, getService: directoryService(fakeDirectory()) })
  await reset.pickEffort('Default (High)')
  assert.deepEqual(reset.calls, ['/advisor model anthropic/claude-opus-5-5'], 'no effort token')
  const verifier = cellHarness({ cell: 'verifier', view: { verifierModel: withEffort(OPUS, 'max') }, getService: directoryService(fakeDirectory()) })
  await verifier.pickEffort('Default (High)')
  assert.deepEqual(verifier.calls, ['/advisor verifier-model anthropic/claude-opus-5-5'])
  const current = cellHarness({ cell: 'verifier', view: { verifierModel: OPUS }, getService: directoryService(fakeDirectory()) })
  await current.pickEffort('Default (High)')
  assert.deepEqual(current.calls, [])
})

test('Default row: the localized patterns, en and zh', () => {
  const tables = {}
  const locale = (lang) => ({
    register(_namespace, dictionaries) { Object.assign(tables, dictionaries) },
    bind: () => (key) => tables[lang][key] ?? key,
  })
  const labels = (lang, route) => {
    const directory = fakeDirectory()
    const harness = cellHarness({
      view: { advisorModel: route },
      getService: (name) => name === 'locale' ? locale(lang) : name === 'modelDirectories' ? directory.service : undefined,
    })
    harness.openFlyout()
    return [harness.effortGroup().props['aria-label'], harness.effortRows()[0].props.label]
  }
  assert.deepEqual(labels('en', OPUS), ['Effort for claude-opus-5-5', 'Default (High)'])
  assert.deepEqual(labels('zh', OPUS), ['claude-opus-5-5 的推理等级', 'Default（High）'])
  assert.deepEqual(labels('en', FLASH), ['Effort for ~deepseek/deepseek-flash-latest', 'Default'], 'en: no default advertised')
  assert.deepEqual(labels('zh', FLASH), ['~deepseek/deepseek-flash-latest 的推理等级', 'Default'], 'zh: no default advertised')
})

test('recommended mark: Advisor keeps highest-below-max, Verifier marks Default, and an equal default is named without a second mark', () => {
  const getService = directoryService(fakeDirectory())
  const summary = (cell, route, effort) => {
    const harness = cellHarness({ cell, view: { [cell === 'verifier' ? 'verifierModel' : 'advisorModel']: effort === undefined ? route : withEffort(route, effort) }, getService })
    harness.openFlyout()
    return harness.effortSummary()
  }
  // Advisor, default differs from the recommendation: the mark sits on the effort row only.
  assert.deepEqual(summary('advisor', OPUS), ['Default (High)=true', 'Low=false', 'Medium=false', 'High=false', 'Extra high (recommended)=false', 'Max=false'])
  // Advisor, default equals the recommendation: one mark, on the effort row; Default only names it.
  assert.deepEqual(summary('advisor', FABLE), ['Default (Extra high)=true', 'Extra high (recommended)=false', 'Max=false'])
  assert.deepEqual(summary('advisor', FABLE, 'xhigh'), ['Default (Extra high)=false', 'Extra high (recommended)=true', 'Max=false'])
  // Advisor without a recommendation (only max) falls back to Default, named when known.
  const maxOnly = cellHarness({
    view: { advisorModel: MAX_ONLY },
    getService: directoryService(fakeDirectory(catalogOf({ efforts: efforts('max'), defaultEffort: 'max' }).map((group) => ({ ...group, models: [{ ...group.models[0], id: 'claude-max-only' }] })))),
  })
  maxOnly.openFlyout()
  assert.deepEqual(maxOnly.effortSummary(), ['Default (Max) (recommended)=true', 'Max=false'])
  // Verifier: Default is the recommendation, checked when nothing is saved, whatever the default is.
  assert.deepEqual(summary('verifier', OPUS), ['Default (High) (recommended)=true', 'Low=false', 'Medium=false', 'High=false', 'Extra high=false', 'Max=false'])
  assert.deepEqual(summary('verifier', FABLE), ['Default (Extra high) (recommended)=true', 'Extra high=false', 'Max=false'], 'no mark moves to Extra high')
  assert.deepEqual(summary('verifier', OPUS, 'low'), ['Default (High) (recommended)=false', 'Low=true', 'Medium=false', 'High=false', 'Extra high=false', 'Max=false'])
  assert.deepEqual(summary('verifier', FLASH), ['Default (recommended)=true', 'Low=false', 'High=false'], 'unknown default: plain Default keeps the mark')
  // Exactly one mark per group.
  for (const lines of [summary('advisor', OPUS), summary('advisor', FABLE), summary('verifier', FABLE)]) {
    assert.equal(lines.filter((line) => line.includes('(recommended)')).length, 1)
  }
})

test('Default row: the label is frozen while the flyout is open and refreshed at the next open', () => {
  const directory = fakeDirectory(catalogOf({ efforts: efforts('xhigh', 'max') }))
  const harness = cellHarness({ view: { advisorModel: FABLE }, getService: directoryService(directory) })
  harness.openFlyout()
  assert.deepEqual(harness.effortSummary(), ['Default=true', 'Extra high (recommended)=false', 'Max=false'])
  directory.publish(catalogOf({ efforts: efforts('xhigh', 'max'), defaultEffort: 'max' }))
  harness.rerender()
  assert.deepEqual(harness.effortSummary(), ['Default=true', 'Extra high (recommended)=false', 'Max=false'], 'the name does not appear while open')
  harness.closeFlyout()
  harness.openFlyout()
  assert.deepEqual(harness.effortSummary(), ['Default (Max)=true', 'Extra high (recommended)=false', 'Max=false'])
  directory.publish(catalogOf({ efforts: efforts('xhigh', 'max'), defaultEffort: 'xhigh' }))
  harness.rerender()
  assert.deepEqual(harness.effortSummary(), ['Default (Max)=true', 'Extra high (recommended)=false', 'Max=false'], 'the name does not change or gain a second mark while open')
  directory.publish([])
  harness.rerender()
  assert.equal(harness.effortRows()[0].props.label, 'Default (Max)', 'nor disappear')
  harness.closeFlyout()
  harness.openFlyout()
  assert.equal(harness.effortGroup(), undefined, 'the next open reflects the empty directory: no group without a saved effort')
})

// ---- Review fixes: the group's model, the refusal escape, unusable lists ----

const OPUS_ROWS = ['Default (High)', 'Low', 'Medium', 'High', 'Extra high', 'Max']
const AUTO_REFUSAL = 'Advisor model effort xhigh is not offered by anthropic/claude-opus-5-5; nothing was changed. Advertised efforts: high (High).'
const HAND_REFUSAL = 'Advisor model effort max for anthropic/claude-opus-5-5 could not be checked: the check timed out after 10 s; nothing was changed.'
const BUSY = 'Advisor is already updating. Try again after it finishes.'
const effortLabels = (harness) => harness.effortRows().map((row) => row.props.label)
const effortLive = (harness) => harness.effortRows().map((row) => row.props.disabled !== true)
const every = (value) => OPUS_ROWS.map(() => value)

// Press every Effort row the way a user can (a click on the rendered row),
// then through its handler directly, and let the outcomes settle.
async function pressEffortRows(harness) {
  const rows = harness.effortRows()
  for (const row of rows) row.type(row.props).props.onClick()
  for (const row of rows) row.props.onSelect()
  await ticks()
  harness.rerender()
}

test('effort group: if the cell\'s model changes while the flyout is open, the group stays for its model, disabled, and sends nothing', async () => {
  const getService = directoryService(fakeDirectory())

  // Another tab saves another model, then the first one again.
  const other = cellHarness({ view: { advisorModel: OPUS }, getService })
  other.openFlyout()
  assert.deepEqual(effortLabels(other), OPUS_ROWS)
  assert.deepEqual(effortLive(other), every(true))
  other.save(FLASH)
  assert.deepEqual(effortLabels(other), OPUS_ROWS, 'the rows stay mounted: still the efforts of their model')
  assert.equal(other.effortHeading(), 'Effort for claude-opus-5-5', 'the heading names the group\'s model')
  assert.equal(other.effortGroup().props['aria-label'], 'Effort for claude-opus-5-5')
  assert.deepEqual(effortLive(other), every(false))
  assert.equal(other.effortRows().some((row) => row.props.checked), false, 'no effort row is checked for another model')
  assert.equal(other.effortRows().every((row) => row.type(row.props).props['aria-disabled'] === 'true'), true, 'aria-disabled, so a focused row keeps focus')
  assert.equal(other.rows().find((row) => row.props.title === keyOf(FLASH)).props.checked, true, 'the model rows follow the session')
  other.save(OPUS)
  assert.deepEqual(effortLive(other), every(true), 'live again once the cell shows that model')
  assert.equal(other.effortRows()[0].props.checked, true)
  other.save(FLASH)
  await pressEffortRows(other)
  assert.deepEqual(other.calls, [], 'no line for a model the cell no longer shows')
  other.closeFlyout()
  other.openFlyout()
  assert.deepEqual(other.effortSummary(), ['Default=true', 'Low=false', 'High (recommended)=false'], 'the next open shows the new model\'s group')
  assert.equal(other.effortHeading(), 'Effort for ~deepseek/deepseek-flash-latest')
  assert.deepEqual(effortLive(other), [true, true, true])

  // A pending automatic pick is refused while the flyout shows its group.
  const refused = cellHarness({ view: { advisorModel: FABLE }, getService })
  await refused.pickModel(OPUS)
  refused.openFlyout()
  assert.deepEqual(effortLabels(refused), OPUS_ROWS, 'the group of the model being saved')
  assert.equal(refused.effortRows()[4].props.checked, true, 'its automatic effort is checked')
  assert.deepEqual(effortLive(refused), every(true))
  refused.fail(AUTO_REFUSAL)
  assert.equal(textOf(refused.cellValue()), 'claude-fable-5-2', 'back to the saved model')
  assert.deepEqual(effortLabels(refused), OPUS_ROWS)
  assert.deepEqual(effortLive(refused), every(false))
  await pressEffortRows(refused)
  assert.deepEqual(refused.calls, ['/advisor model anthropic/claude-opus-5-5 effort=xhigh'], 'nothing switches the model back')

  // The pending pick lands: the same model, so the group stays live.
  const lands = cellHarness({ view: { advisorModel: FABLE }, getService })
  await lands.pickModel(OPUS)
  lands.openFlyout()
  lands.save(withEffort(OPUS, 'xhigh'))
  assert.deepEqual(effortLabels(lands), OPUS_ROWS)
  assert.deepEqual(effortLive(lands), every(true))
  assert.equal(lands.effortRows()[4].props.checked, true)

  // A pick whose command line is not admitted while the flyout is open.
  let admit
  const lineOut = cellHarness({ view: { advisorModel: FABLE }, getService, execute: () => new Promise((resolve) => { admit = resolve }) })
  await lineOut.pickModel(OPUS)
  lineOut.openFlyout()
  assert.deepEqual(effortLabels(lineOut), OPUS_ROWS)
  assert.deepEqual(effortLive(lineOut), every(false), 'locked while the line is unanswered')
  admit({ kind: 'error', text: BUSY })
  await ticks()
  lineOut.rerender()
  assert.equal(textOf(lineOut.cellValue()), 'claude-fable-5-2')
  assert.deepEqual(effortLabels(lineOut), OPUS_ROWS)
  assert.deepEqual(effortLive(lineOut), every(false), 'unlocked, but no longer the cell\'s model')
  await pressEffortRows(lineOut)
  assert.deepEqual(lineOut.calls, ['/advisor model anthropic/claude-opus-5-5 effort=xhigh'])

  // The saved model leaves the authorized list, or the list goes away.
  for (const [name, routes] of [['unauthorized', ALL_ROUTES.filter((route) => route !== OPUS)], ['no list', null]]) {
    const leaves = cellHarness({ view: { advisorModel: OPUS }, getService })
    leaves.openFlyout()
    leaves.state.routes = routes
    leaves.rerender()
    assert.deepEqual(effortLabels(leaves), OPUS_ROWS, `${name}: the effort rows stay`)
    assert.equal(leaves.effortHeading(), 'Effort for claude-opus-5-5', name)
    assert.deepEqual(effortLive(leaves), every(false), name)
    assert.equal(leaves.rows().some((row) => row.props.title === keyOf(OPUS)), false, `${name}: the model rows follow the list, as before`)
    await pressEffortRows(leaves)
    assert.deepEqual(leaves.calls, [], name)
  }

  // The Verifier model cell follows the same rule.
  const verifier = cellHarness({ cell: 'verifier', view: { verifierModel: OPUS }, getService })
  verifier.openFlyout()
  verifier.save(withEffort(FABLE, 'max'))
  assert.deepEqual(effortLabels(verifier), OPUS_ROWS)
  assert.deepEqual(effortLive(verifier), every(false))
  await pressEffortRows(verifier)
  assert.deepEqual(verifier.calls, [])
})

test('refusal escape: any refusal while an automatic pick is unconfirmed drops that model\'s automatic effort until the session shows a saved effort for it', async () => {
  const getService = directoryService(fakeDirectory())
  const harness = cellHarness({ getService })
  await harness.pickModel(OPUS)
  harness.fail(BUSY)
  assert.deepEqual(harness.reports, [BUSY], 'whatever the cause of the refusal')
  await harness.pickModel(OPUS)
  harness.save(OPUS)
  // Nothing else lifts it: a reopened flyout, a saved route without an
  // effort, another model's saved effort, Inherit.
  harness.openFlyout()
  harness.closeFlyout()
  harness.save(withEffort(FABLE, 'xhigh'))
  await harness.pickModel(OPUS)
  harness.save(OPUS)
  harness.save(null)
  await harness.pickModel(OPUS)
  harness.save(OPUS)
  assert.deepEqual(harness.calls, [
    '/advisor model anthropic/claude-opus-5-5 effort=xhigh',
    '/advisor model anthropic/claude-opus-5-5',
    '/advisor model anthropic/claude-opus-5-5',
    '/advisor model anthropic/claude-opus-5-5',
  ])
  // A saved setting with an effort for that model (here one set by command) lifts it.
  harness.save(withEffort(OPUS, 'high'))
  harness.save(FABLE)
  await harness.pickModel(OPUS)
  assert.deepEqual(harness.calls.slice(4), ['/advisor model anthropic/claude-opus-5-5 effort=xhigh'], 'the automatic effort is back')
  // A new refusal starts it again.
  harness.fail(AUTO_REFUSAL)
  await harness.pickModel(OPUS)
  assert.deepEqual(harness.calls.slice(5), ['/advisor model anthropic/claude-opus-5-5'])
})

test('refusal escape: an effort you pick is never dropped, and its refusal leaves the automatic effort of that model alone', async () => {
  const getService = directoryService(fakeDirectory())
  // While a model's automatic effort is dropped, its effort rows still send their effort.
  const escaped = cellHarness({ getService })
  await escaped.pickModel(OPUS)
  escaped.fail(AUTO_REFUSAL)
  await escaped.pickModel(OPUS)
  escaped.save(OPUS)
  await escaped.pickEffort('Extra high')
  escaped.fail(AUTO_REFUSAL)
  await escaped.pickEffort('Extra high')
  assert.deepEqual(escaped.calls, [
    '/advisor model anthropic/claude-opus-5-5 effort=xhigh',
    '/advisor model anthropic/claude-opus-5-5',
    '/advisor model anthropic/claude-opus-5-5 effort=xhigh',
    '/advisor model anthropic/claude-opus-5-5 effort=xhigh',
  ])

  // An effort you picked that is refused, as a recorded failure or as a
  // command line the Host does not admit, keeps that model's automatic effort.
  for (const how of ['recorded', 'not admitted']) {
    const outcomes = how === 'not admitted' ? [{ kind: 'error', text: HAND_REFUSAL }, { kind: 'error', text: HAND_REFUSAL }] : []
    const hand = cellHarness({ view: { advisorModel: OPUS }, getService, execute: () => outcomes.shift() ?? { kind: 'success' } })
    const refuse = () => { if (how === 'recorded') hand.fail(HAND_REFUSAL) }
    await hand.pickEffort('Max')
    refuse()
    assert.deepEqual(hand.reports, [HAND_REFUSAL], how)
    assert.equal(textOf(hand.cellValue()), 'claude-opus-5-5', `${how}: back to the saved setting`)
    await hand.pickEffort('Max')
    refuse()
    assert.deepEqual(hand.reports, [HAND_REFUSAL, HAND_REFUSAL], `${how}: the same effort is sent again`)
    hand.save(FABLE)
    await hand.pickModel(OPUS)
    assert.deepEqual(hand.calls, [
      '/advisor model anthropic/claude-opus-5-5 effort=max',
      '/advisor model anthropic/claude-opus-5-5 effort=max',
      '/advisor model anthropic/claude-opus-5-5 effort=xhigh',
    ], how)
  }
})

test('effort source: a list none of whose entries is usable is unknown; a genuinely empty list stays none', async () => {
  const unusable = catalogOf({ efforts: [{ id: '' }, { id: 'two words', name: 'Spaced' }, { id: 7, name: 'Seven' }, null, { name: 'No id' }], defaultEffort: 'two words' })
  const getService = directoryService(fakeDirectory(unusable))
  const plain = cellHarness({ view: { advisorModel: FABLE }, getService })
  plain.openFlyout()
  assert.equal(plain.effortGroup(), undefined, 'no group without a saved effort')
  const saved = cellHarness({ view: { advisorModel: withEffort(FABLE, 'xhigh') }, getService })
  saved.openFlyout()
  assert.deepEqual(saved.effortSummary(), ['Default (recommended)=false', 'xhigh=true'], 'unknown: plain Default, the saved id without a warning')
  const verifier = cellHarness({ cell: 'verifier', view: { verifierModel: withEffort(FABLE, 'xhigh') }, getService })
  verifier.openFlyout()
  assert.deepEqual(verifier.effortSummary(), ['Default (recommended)=false', 'xhigh=true'])
  const pick = cellHarness({ getService })
  await pick.pickModel(FABLE)
  assert.deepEqual(pick.calls, ['/advisor model anthropic/claude-fable-5-2'], 'no automatic effort')

  // {efforts: []} is none: no group without a saved effort, and a saved id warns.
  const emptyService = directoryService(fakeDirectory(catalogOf({ efforts: [], defaultEffort: 'xhigh' })))
  for (const cell of ['advisor', 'verifier']) {
    const field = cell === 'verifier' ? 'verifierModel' : 'advisorModel'
    const empty = cellHarness({ cell, view: { [field]: FABLE }, getService: emptyService })
    empty.openFlyout()
    assert.equal(empty.effortGroup(), undefined, `${cell}: no Effort group for an empty list`)
    assert.equal(findAll(empty.items(), (node) => node.props.role === 'separator').length, 1, `${cell}: no second separator`)
    const emptySaved = cellHarness({ cell, view: { [field]: withEffort(FABLE, 'xhigh') }, getService: emptyService })
    emptySaved.openFlyout()
    assert.deepEqual(emptySaved.effortSummary(), ['Default (recommended)=false', 'xhigh [warning]=true'], `${cell}: none`)
  }
  const emptyPick = cellHarness({ getService: emptyService })
  await emptyPick.pickModel(FABLE)
  assert.deepEqual(emptyPick.calls, ['/advisor model anthropic/claude-fable-5-2'])
})

test('hook order: the same hooks in the same order while the directory throws then answers, a session id comes and goes, and routes arrive', () => {
  for (const cell of ['advisor', 'verifier']) {
    let throwing = true
    const directory = fakeDirectory()
    const getService = (name) => name === 'modelDirectories'
      ? {
        directoryFor(sessionId) {
          if (throwing) throw new Error(`ui-model-selection: session "${sessionId}" resolved no scope`)
          return directory.service.directoryFor(sessionId)
        },
      }
      : undefined
    const field = cell === 'verifier' ? 'verifierModel' : 'advisorModel'
    const harness = cellHarness({ cell, view: { [field]: withEffort(FABLE, 'xhigh') }, routes: null, getService, sessionId: null })
    const first = harness.trace()
    // anchor ref, cell ref, open, desired, useCommand (busy, error, mounted,
    // effect), the directory version and subscription, the open-efforts and
    // refused refs, the desired-clearing effect, the failure watch (ref,
    // effect), the effect that closes the flyout on a reset.
    assert.equal(first, 'ref,ref,state,state,state,state,ref,effect,state,effect,ref,ref,effect,ref,effect,effect', cell)
    assert.equal(directory.listeners.size, 0)
    const steps = [
      ['a session id appears, the directory still throws', () => harness.setProps({ sessionId: 'session-1' }), 0],
      ['the directory answers', () => { throwing = false; harness.rerender() }, 1],
      ['routes null -> list', () => { harness.state.routes = ALL_ROUTES; harness.rerender() }, 1],
      ['flyout open', () => harness.openFlyout(), 1],
      ['the directory throws again', () => { throwing = true; harness.rerender() }, 0],
      ['routes list -> null', () => { harness.state.routes = null; harness.rerender() }, 0],
      ['the directory answers again', () => { throwing = false; harness.rerender() }, 1],
      ['the session id goes', () => harness.setProps({ sessionId: undefined }), 0],
    ]
    for (const [name, step, listeners] of steps) {
      step()
      assert.equal(harness.trace(), first, `${cell}: ${name}`)
      assert.equal(directory.listeners.size, listeners, `${cell}: ${name}: subscriptions`)
      if (name === 'flyout open') {
        assert.equal(harness.effortRows().length, 3, `${cell}: the loaded directory shows in the group`)
      }
    }
    assert.equal(harness.effortRows().length, 3, `${cell}: rows frozen through every change while open`)
    assert.equal(directory.sessions.every((id) => id === 'session-1'), true)
  }
})

test('recommended default comes from the picked model, not from the model the cell shows', async () => {
  const getService = directoryService(fakeDirectory())
  for (const [from, to, line] of [
    [FLASH, OPUS, '/advisor model anthropic/claude-opus-5-5 effort=xhigh'],
    [OPUS, FLASH, '/advisor model openrouter/~deepseek/deepseek-flash-latest effort=high'],
    [OPUS, MAX_ONLY, '/advisor model anthropic/claude-max-only'],
    [OPUS, PLAIN, '/advisor model anthropic/claude-plain'],
    [OPUS, UNLISTED, '/advisor model anthropic/claude-unlisted'],
    [MAX_ONLY, FLASH, '/advisor model openrouter/~deepseek/deepseek-flash-latest effort=high'],
    [PLAIN, OPUS, '/advisor model anthropic/claude-opus-5-5 effort=xhigh'],
  ]) {
    const harness = cellHarness({ view: { advisorModel: from }, getService })
    await harness.pickModel(to)
    assert.deepEqual(harness.calls, [line], `${keyOf(from)} -> ${keyOf(to)}`)
  }
  // The same while another pick is unconfirmed, so the cell shows that model.
  const pending = cellHarness({ getService })
  await pending.pickModel(FLASH)
  await pending.pickModel(OPUS)
  await pending.pickModel(MAX_ONLY)
  assert.deepEqual(pending.calls, [
    '/advisor model openrouter/~deepseek/deepseek-flash-latest effort=high',
    '/advisor model anthropic/claude-opus-5-5 effort=xhigh',
    '/advisor model anthropic/claude-max-only',
  ])
})

test('the desired setting is cleared once the session shows it (read from the hook state), so a later change elsewhere shows', async () => {
  const getService = directoryService(fakeDirectory())
  const harness = cellHarness({ getService })
  assert.equal(harness.desired(), null)
  await harness.pickModel(OPUS)
  const sent = { key: 'anthropic/claude-opus-5-5', effort: 'xhigh', auto: true }
  assert.deepEqual(harness.desired(), sent)
  harness.save(FLASH)
  assert.deepEqual(harness.desired(), sent, 'another setting landed: not this one')
  assert.equal(textOf(harness.cellValue()), 'claude-opus-5-5 · xhigh', 'the cell still shows the setting being saved')
  harness.save(OPUS)
  assert.deepEqual(harness.desired(), sent, 'the model without the effort is not this setting either')
  harness.save(withEffort(OPUS, 'xhigh'))
  assert.equal(harness.desired(), null, 'cleared once the session shows it')
  harness.save(FLASH)
  assert.equal(textOf(harness.cellValue()), 'deepseek-flash-latest', 'the cell follows the session, not a stale desired setting')
  assert.equal(harness.cellNode().props['aria-busy'], false)

  // An effort row's setting, and Inherit, clear the same way.
  await harness.pickEffort('High')
  assert.deepEqual(harness.desired(), { key: 'openrouter/~deepseek/deepseek-flash-latest', effort: 'high' })
  harness.save(withEffort(FLASH, 'high'))
  assert.equal(harness.desired(), null)
  await harness.pickInherit()
  assert.deepEqual(harness.desired(), { key: 'inherit', effort: undefined })
  harness.save(null)
  assert.equal(harness.desired(), null)

  // A recorded refusal, and a command line that is not admitted, clear it too.
  const refused = cellHarness({ getService })
  await refused.pickModel(OPUS)
  refused.fail(AUTO_REFUSAL)
  assert.equal(refused.desired(), null)
  const outcomes = [{ kind: 'error', text: BUSY }]
  const notAdmitted = cellHarness({ getService, execute: () => outcomes.shift() ?? { kind: 'success' } })
  await notAdmitted.pickModel(OPUS)
  assert.equal(notAdmitted.desired(), null)
})

test('only a pick of another model is automatic: the saved model\'s row restores the saved setting as it is, and its refusal changes nothing', async () => {
  const getService = directoryService(fakeDirectory())
  const outcomes = []
  const harness = cellHarness({ view: { advisorModel: FABLE }, getService, execute: () => outcomes.shift() ?? { kind: 'success' } })
  await harness.pickModel(OPUS)
  assert.deepEqual(harness.desired(), { key: 'anthropic/claude-opus-5-5', effort: 'xhigh', auto: true }, 'another model: automatic')
  outcomes.push({ kind: 'error', text: BUSY })
  await harness.pickModel(FABLE)
  assert.deepEqual(harness.calls, [
    '/advisor model anthropic/claude-opus-5-5 effort=xhigh',
    '/advisor model anthropic/claude-fable-5-2',
  ], 'the saved setting as it is: a saved route never gets the recommended effort')
  assert.deepEqual(harness.reports, [BUSY])
  harness.save(withEffort(OPUS, 'xhigh'))
  await harness.pickModel(FABLE)
  assert.deepEqual(harness.calls.slice(2), ['/advisor model anthropic/claude-fable-5-2 effort=xhigh'],
    'now another model: automatic, untouched by the refused restore')

  // The restore while a pick is unconfirmed is not automatic, nor are effort rows or Inherit.
  const restore = cellHarness({ view: { advisorModel: withEffort(FABLE, 'max') }, getService })
  await restore.pickModel(OPUS)
  restore.openFlyout()
  restore.rows().find((row) => row.props.title === keyOf(FABLE)).props.onSelect()
  assert.deepEqual(restore.desired(), { key: 'anthropic/claude-fable-5-2', effort: 'max' })
  await ticks()
  restore.rerender()
  await restore.pickEffort('Extra high')
  assert.deepEqual(restore.desired(), { key: 'anthropic/claude-fable-5-2', effort: 'xhigh' })
  await restore.pickInherit()
  assert.deepEqual(restore.desired(), { key: 'inherit', effort: undefined })

  // The Verifier model cell has no automatic effort at all.
  const verifier = cellHarness({ cell: 'verifier', view: { verifierModel: FABLE }, getService })
  await verifier.pickModel(OPUS)
  assert.deepEqual(verifier.desired(), { key: 'anthropic/claude-opus-5-5', effort: undefined, auto: false })
  assert.deepEqual(verifier.calls, ['/advisor verifier-model anthropic/claude-opus-5-5'])
})
