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

const find = (node, predicate) => findAll(node, predicate)[0]
const text = (node) => JSON.stringify(node)
const plain = (value) => JSON.parse(JSON.stringify(value))
const ticks = async (count = 16) => { for (let index = 0; index < count; index++) await Promise.resolve() }

// A tiny hook runtime: one persistent hook list per instance, effects run
// when their dependencies change, cleanups run on unmount. Each render
// records the kinds of the hooks it called, in order (instance.trace).
// mount(component, { strict: true }) does what React's StrictMode does in
// development after the first commit: every effect cleanup, in order, then
// every effect of that render again, with the same closures. cycle() does
// the same at any later time, with each effect's latest closure, while the
// instance stays mounted (as for a subtree hidden and shown again).
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
      current.creates[index] = { effect, list }
      const hook = current.hooks[index]
      if (hook === undefined || deps(hook.deps, list)) {
        current.pending.push(() => {
          hook?.cleanup?.()
          const cleanup = effect()
          current.hooks[index] = { deps: list, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
        })
        current.ran.push({ index, effect, list })
        if (hook === undefined) current.hooks[index] = { deps: undefined }
      }
    },
  }
  const mount = (component, options = {}) => {
    const instance = { hooks: [], index: 0, pending: [], ran: [], creates: [], dirty: false, props: null, trace: [], committed: false }
    const render = (props) => {
      if (props !== undefined) instance.props = props
      current = instance
      instance.index = 0
      instance.pending = []
      instance.ran = []
      instance.dirty = false
      instance.trace = []
      const output = component(instance.props)
      const effects = instance.pending
      for (const effect of effects) { current = instance; effect() }
      if (options.strict === true && !instance.committed) {
        for (const { index } of instance.ran) instance.hooks[index]?.cleanup?.()
        for (const { index, effect, list } of instance.ran) {
          current = instance
          const cleanup = effect()
          instance.hooks[index] = { deps: list, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
        }
      }
      instance.committed = true
      return output
    }
    const unmount = () => {
      for (const hook of instance.hooks) hook?.cleanup?.()
    }
    const cycle = () => {
      for (const hook of instance.hooks) hook?.cleanup?.()
      instance.creates.forEach(({ effect, list }, index) => {
        current = instance
        const cleanup = effect()
        instance.hooks[index] = { deps: list, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
      })
    }
    return { instance, render, unmount, cycle }
  }
  return { React, mount }
}

// options.locale: a locale service for ctx.get('locale') (its effects run);
// options.getService: answers every other ctx.get (modelDirectories) and may
// throw, as a lazily read service may;
// options.globals: extra globals for the client, such as a fake document or
// localStorage;
// options.prelude: source run in the client's context first, for a global
// whose getter throws (a sandbox accessor would read as undefined instead).
function load(options = {}) {
  const registrations = []
  const runtime = createRuntime()
  const harness = { commandUi: undefined }
  // The client reads time only through Date.now(); tests move this clock.
  const clock = { offset: 0 }
  class TestDate extends Date { static now() { return Date.now() + clock.offset } }
  const primitives = new Proxy({}, { get: (_target, key) => key })
  const slots = {
    inject(_name, callback) { callback() },
    register(definition, component) { registrations.push({ definition, component }) },
  }
  const get = (key) => key === 'commandUi' ? harness.commandUi : key === 'locale' ? options.locale : options.getService?.(key)
  const context = vm.createContext({
    ...options.globals,
    Date: TestDate,
    window: {
      __ModuleLoader__: {
        load({ id, factory }) {
          const result = factory((name) => name === 'react' ? runtime.React : primitives)
          assert.equal(id, 'dsh-plugin-router')
          // Exactly slots: an inject entry for a service the page lacks (such
          // as modelDirectories) leaves the whole client entry pending and
          // breaks web boot, so that service is read lazily instead.
          assert.deepEqual(Array.from(result.inject), ['slots'])
          result.apply({ get, slots, effect(callback) { if (options.locale !== undefined) callback() } })
        },
      },
    },
  })
  if (options.prelude !== undefined) vm.runInContext(options.prelude, context)
  vm.runInContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), context)
  return { registrations, runtime, harness, clock }
}

const selected = [
  { provider: 'openrouter', model: '~deepseek/deepseek-flash-latest' },
  { provider: 'openai-codex', model: '~deepseek/deepseek-flash-latest' },
]
const haiku = { provider: 'anthropic', model: 'claude-haiku-5-5' }
const routes = [...selected, haiku]
const manualView = (selections, extra = {}) => ({
  mode: 'manual', pending: false, pendingTarget: null, pendingLevel: null, pendingSince: null, failure: null,
  selections: { mechanical: null, ordinary: null, hard: null, ...selections }, ...extra,
})

// Resolve the registered wrapper and the LevelCell elements it renders.
function levels(env, view, routeList, extra = {}) {
  const wrapper = env.registrations[1].component({
    useProjection: (key) => key === 'router' ? view : routeList,
    ...extra,
  })
  const parent = env.runtime.mount(wrapper.type)
  const output = parent.render(wrapper.props)
  const cells = output === null ? null : findAll(output, (node) => typeof node.type === 'function' && typeof node.props?.level === 'string')
  return { parent, output, cells }
}

function mountCell(env, element) {
  const cell = env.runtime.mount(element.type)
  return { ...cell, output: cell.render(element.props) }
}

const pick = (output, title) => findAll(output, (node) => node.props?.title === title && node.props?.onSelect)[0].props.onSelect()
const cellButton = (output) => find(output, (node) => node.props?.role === 'menuitem')

// An execute() that records each line and resolves only when the test settles
// it: settle[i]() with success, or resolveWith[i](outcome) with any outcome.
function deferredExecute(env) {
  const calls = []
  const settle = []
  const resolveWith = []
  env.harness.commandUi = {
    execute: (_target, line) => {
      calls.push(line)
      return new Promise((resolve) => {
        settle.push(() => resolve({ kind: 'success' }))
        resolveWith.push(resolve)
      })
    },
  }
  return { calls, settle, resolveWith }
}

// Press the switch through its own instance, as the menu does.
function pressSwitch(env, enabled, extra = {}) {
  const option = env.registrations[0].component({ useProjection: () => manualView({}), ...extra })
  find(env.runtime.mount(option.type).render(option.props), (node) => node.props?.className === 'router-toggle').props.onChange(enabled)
}

// A projection update re-renders RouterLevels and, with fresh props, the cell.
function rerender(menu, cell, level, extra = { open: false }) {
  const fresh = findAll(menu.parent.render(), (node) => typeof node.type === 'function' && node.props?.level === level)[0]
  return cell.render({ ...fresh.props, ...extra })
}

// As React does: re-render RouterLevels only when its own state changed.
function flush(menu, cell, level, extra) {
  if (!menu.parent.instance.dirty) return false
  rerender(menu, cell, level, extra)
  return true
}

// The host menu closes while a level flyout still holds a draft.
function closeMenuWithDraft(env, menu, index, title) {
  const closing = env.runtime.mount(menu.cells[index].type)
  pick(closing.render({ ...menu.cells[index].props, open: true }), title)
  closing.render()
  closing.unmount()
  menu.parent.unmount()
}

test('client registers the switch and one level-cell entry with distinct orders', async () => {
  const env = load()
  assert.deepEqual(env.registrations.map((entry) => [entry.definition.id, entry.definition.order]), [
    ['router-option', 22], ['router-levels', 23],
  ])
  const option = env.registrations[0].component({
    useProjection: () => ({ mode: 'off', pending: true, pendingTarget: 'mode', pendingSince: Date.now() }),
  })
  const calls = []
  env.harness.commandUi = { execute: async (_target, line) => { calls.push(line); return { kind: 'success' } } }
  const rendered = env.runtime.mount(option.type).render(option.props)
  const toggle = find(rendered, (node) => node.props?.className === 'router-toggle')
  assert.equal(toggle.props.disabled, undefined, 'a focused switch is never disabled mid-flight (that blur closes the host menu)')
  toggle.props.onChange(true)
  assert.deepEqual(calls, [], 'changes are ignored while a router command is pending')
  assert.equal(toggle.props.label, 'Model router')
  assert.equal(findAll(rendered, (node) => node.props?.role === 'status').length, 0)
  assert.equal(find(rendered, (node) => node.type === 'Button').props['aria-label'], 'About Model router')
  assert.match(find(rendered, (node) => node.type === 'Tooltip').props.label, /subagents, not for this chat/)

  const stale = env.registrations[0].component({
    useProjection: () => ({ mode: 'off', pending: true, pendingTarget: 'mode', pendingSince: Date.now() - 6 * 60_000 }),
  })
  const staleRendered = env.runtime.mount(stale.type).render(stale.props)
  find(staleRendered, (node) => node.props?.className === 'router-toggle').props.onChange(true)
  await ticks()
  assert.deepEqual(calls, ['/router manual'], 'a pending marker older than five minutes no longer blocks the switch')
})

test('level cells stay mounted while the router is off so the switch does not move', () => {
  const env = load()
  const { cells } = levels(env, { ...manualView({ mechanical: selected }), mode: 'off' }, routes)
  assert.equal(cells.length, 3)
  const cell = mountCell(env, cells[0])
  const button = find(cell.output, (node) => node.props?.role === 'menuitem')
  assert.equal(button.props['data-inactive'], '')
})

test('a level cell is a native-style menu cell summarizing its selection', () => {
  const env = load()
  const { cells } = levels(env, manualView({ mechanical: selected }), routes)
  assert.deepEqual(cells.map((cell) => cell.props.level), ['mechanical', 'ordinary', 'hard'])
  const cell = mountCell(env, cells[0])
  const button = find(cell.output, (node) => node.props?.role === 'menuitem')
  assert.equal(button.props['aria-haspopup'], 'menu')
  assert.equal(button.props['aria-expanded'], false)
  assert.equal(button.props['data-inactive'], undefined)
  assert.match(text(button), /Mechanical/)
  // The model truncates; the count keeps its own span.
  assert.equal(find(button, (node) => node.props?.className === 'router-cell-value').children.join(''), 'deepseek-flash-latest')
  assert.equal(find(button, (node) => node.props?.className === 'router-cell-more').children.join(''), '+1')
  assert.match(button.props['aria-label'], /^Mechanical: ~deepseek\/deepseek-flash-latest, 1 more$/)
  assert.match(button.props.title, /Fully specified/)
  assert.equal(findAll(cell.output, (node) => node.props?.role === 'menu').length, 0)
  assert.doesNotMatch(text(cell.output), /fieldset|details|"checkbox"/)
  assert.match(text(mountCell(env, cells[1]).output), /"Inherit"/)
})

test('the open flyout lists the level hint, Inherit, provider groups, checks, and the cap', () => {
  const env = load()
  const { cells } = levels(env, manualView({ mechanical: selected }), routes)
  const cell = mountCell(env, { ...cells[0], props: { ...cells[0].props, open: true } })
  const flyout = find(cell.output, (node) => typeof node.type === 'function' && node.props?.cellRef)
  assert.equal(flyout.props.label, 'Mechanical models')
  assert.match(text(flyout.children), /Fully specified, no judgment/)
  // Route rows (checkboxes); each model's effort rows (single-choice) follow its row.
  const rows = findAll(flyout.children, (node) => typeof node.props?.onSelect === 'function' && node.props.role !== 'menuitemradio')
  assert.equal(rows[0].props.label, 'Inherit (session default)')
  assert.equal(rows[0].props.checked, false)
  assert.deepEqual(rows.slice(1).map((row) => [row.props.title, row.props.checked]), [
    ['openrouter/~deepseek/deepseek-flash-latest', true],
    ['openai-codex/~deepseek/deepseek-flash-latest', true],
    ['anthropic/claude-haiku-5-5', false],
  ])
  const groups = findAll(flyout.children, (node) => node.props?.role === 'group')
  assert.deepEqual(groups.filter((group) => group.props.className === 'router-group').map((group) => group.props['aria-label']),
    ['openrouter', 'openai-codex', 'anthropic'])
  // No model directory here: every model's efforts are unknown, so its effort group offers Default only.
  assert.deepEqual(groups.filter((group) => group.props.className === 'router-efforts').map((group) => [group.props['aria-label'], group.props.hidden]), [
    ['Effort for ~deepseek/deepseek-flash-latest', false],
    ['Effort for ~deepseek/deepseek-flash-latest', false],
    ['Effort for claude-haiku-5-5', true],
  ])
  assert.equal(findAll(flyout.children, (node) => node.props?.role === 'separator').length, 1, 'one separator, after Inherit; effort groups add none')

  const four = [...routes, { provider: 'kimi-coding', model: 'k3.1-pro' }]
  const capped = levels(env, manualView({ mechanical: four }), [...four, { provider: 'openai-codex', model: 'gpt-6-sol' }])
  const cappedCell = mountCell(env, { ...capped.cells[0], props: { ...capped.cells[0].props, open: true } })
  const cappedRows = findAll(cappedCell.output, (node) => typeof node.props?.onSelect === 'function')
  assert.equal(cappedRows.find((row) => row.props.title === 'openai-codex/gpt-6-sol').props.disabled, true)
  assert.equal(cappedRows.find((row) => row.props.title === 'anthropic/claude-haiku-5-5').props.disabled, false)
  assert.match(text(cappedCell.output), /Up to 4 models per level/)
})

test('stale selections stay listed for removal and no-route sessions offer Inherit only', () => {
  const env = load()
  const partial = levels(env, manualView({ mechanical: selected }), [selected[0]])
  const cell = mountCell(env, { ...partial.cells[0], props: { ...partial.cells[0].props, open: true } })
  assert.match(text(cell.output), /Unavailable — removed on next change/)
  const staleRow = () => findAll(cell.instance.props && cell.render(), (node) => node.props?.title === 'openai-codex/~deepseek/deepseek-flash-latest' && node.props?.onSelect)[0]
  staleRow().props.onSelect()
  const after = staleRow()
  assert.ok(after, 'the removed stale row stays mounted so focus survives')
  assert.equal(after.props.checked, false)

  const none = levels(env, manualView({ mechanical: null }), null)
  const noneCell = mountCell(env, { ...none.cells[0], props: { ...none.cells[0].props, open: true } })
  assert.match(text(noneCell.output), /Inherit only/)
  assert.equal(findAll(noneCell.output, (node) => node.props?.role === 'separator').length, 0)
})

test('edits are drafts while open and commit once when the flyout closes', async () => {
  const env = load()
  const calls = []
  env.harness.commandUi = { execute: async (_target, line) => { calls.push(line); return { kind: 'success' } } }
  const { cells } = levels(env, manualView({ ordinary: null }), routes)
  const open = { ...cells[1].props, open: true }
  const cell = env.runtime.mount(cells[1].type)
  let output = cell.render(open)
  const row = (title) => findAll(output, (node) => node.props?.title === title && node.props?.onSelect)[0]
  row('anthropic/claude-haiku-5-5').props.onSelect()
  output = cell.render()
  row('openrouter/~deepseek/deepseek-flash-latest').props.onSelect()
  output = cell.render()
  row('anthropic/claude-haiku-5-5').props.onSelect()
  output = cell.render()
  await ticks()
  assert.deepEqual(calls, [], 'nothing is sent while the flyout is open')
  output = cell.render({ ...open, open: false })
  await ticks()
  assert.deepEqual(calls, ['/router level ordinary openrouter/~deepseek/deepseek-flash-latest'])
  output = cell.render()
  assert.equal(find(output, (node) => node.props?.role === 'menuitem').props['aria-busy'], true, 'the cell shows saving until confirmed')
  output = cell.render({ ...open, open: false, view: manualView({ ordinary: [selected[0]] }) })
  output = cell.render()
  assert.equal(find(output, (node) => node.props?.role === 'menuitem').props['aria-busy'], false)
  await ticks()
  assert.equal(calls.length, 1)
})

test('a reverted choice made while an earlier command is in flight is still sent', async () => {
  const env = load()
  const calls = []
  let release
  env.harness.commandUi = { execute: (_target, line) => { calls.push(line); return new Promise((resolve) => { release = () => resolve({ kind: 'success' }) }) } }
  const { cells } = levels(env, manualView({ ordinary: null }), routes)
  const base = { ...cells[1].props }
  const cell = env.runtime.mount(cells[1].type)
  let output = cell.render({ ...base, open: true })
  findAll(output, (node) => node.props?.title === 'anthropic/claude-haiku-5-5' && node.props?.onSelect)[0].props.onSelect()
  output = cell.render({ ...base, open: false })
  await ticks()
  assert.deepEqual(calls, ['/router level ordinary anthropic/claude-haiku-5-5'])
  output = cell.render({ ...base, open: true })
  findAll(output, (node) => node.props?.label === 'Inherit (session default)')[0].props.onSelect()
  output = cell.render({ ...base, open: false })
  release()
  await ticks()
  output = cell.render({ ...base, open: false, view: manualView({ ordinary: [haiku] }) })
  await ticks()
  output = cell.render()
  await ticks()
  assert.deepEqual(calls, ['/router level ordinary anthropic/claude-haiku-5-5', '/router level ordinary inherit'])
})

test('one level waits while another level holds the shared lock or a router command is pending', async () => {
  const env = load()
  const calls = []
  env.harness.commandUi = { execute: async (_target, line) => { calls.push(line); return { kind: 'success' } } }
  const pendingView = manualView({}, { pending: true, pendingTarget: 'mode', pendingSince: Date.now() })
  const { cells } = levels(env, pendingView, routes)
  const cell = env.runtime.mount(cells[2].type)
  let output = cell.render({ ...cells[2].props, open: true })
  findAll(output, (node) => node.props?.title === 'anthropic/claude-haiku-5-5' && node.props?.onSelect)[0].props.onSelect()
  output = cell.render({ ...cells[2].props, open: false })
  await ticks()
  assert.deepEqual(calls, [])
  cells[2].props.lock.current = { level: 'mechanical', promise: Promise.resolve(true) }
  output = cell.render({ ...cells[2].props, open: false, view: manualView({}) })
  await ticks()
  assert.deepEqual(calls, [], 'the shared lock defers the commit')
  cells[2].props.lock.current = null
  output = cell.render({ ...cells[2].props, open: false, view: manualView({}), lockTick: 1 })
  await ticks()
  assert.deepEqual(calls, ['/router level hard anthropic/claude-haiku-5-5'])
})

test('a host rejection recorded in the projection is reported once and the draft snaps back', async () => {
  const env = load()
  const reports = []
  env.harness.commandUi = { execute: async () => ({ kind: 'success' }) }
  const { cells } = levels(env, manualView({}), routes, { reportFailure: (message) => reports.push(message) })
  const cell = env.runtime.mount(cells[0].type)
  const base = cells[0].props
  let output = cell.render({ ...base, open: true })
  findAll(output, (node) => node.props?.title === 'anthropic/claude-haiku-5-5' && node.props?.onSelect)[0].props.onSelect()
  output = cell.render({ ...base, open: false })
  await ticks()
  const failure = { count: 1, text: 'Router is already updating. Try again after it finishes.', target: 'level', level: 'mechanical' }
  output = cell.render({ ...base, open: false, view: manualView({}, { failure }) })
  output = cell.render()
  assert.deepEqual(reports, ['Router is already updating. Try again after it finishes.'])
  assert.match(text(find(output, (node) => node.props?.role === 'menuitem')), /"Inherit"/)
  output = cell.render({ ...base, open: false, view: manualView({}, { failure: { ...failure, level: 'hard', count: 2 } }) })
  assert.equal(reports.length, 1, 'failures for other levels are ignored')
})

test('a host rejection without a failure channel is shown in the level cell; with a channel it is not', async () => {
  const failure = { count: 1, text: 'Router is already updating. Try again after it finishes.', target: 'level', level: 'mechanical' }
  for (const withChannel of [false, true]) {
    const env = load()
    const reports = []
    env.harness.commandUi = { execute: async () => ({ kind: 'success' }) }
    const extra = withChannel ? { reportFailure: (message) => reports.push(message) } : undefined
    const { cells } = levels(env, manualView({}), routes, extra)
    const cell = env.runtime.mount(cells[0].type)
    const base = cells[0].props
    let output = cell.render({ ...base, open: true })
    findAll(output, (node) => node.props?.title === 'anthropic/claude-haiku-5-5' && node.props?.onSelect)[0].props.onSelect()
    output = cell.render({ ...base, open: false })
    await ticks()
    output = cell.render({ ...base, open: false, view: manualView({}, { failure }) })
    output = cell.render()
    const alert = findAll(output, (node) => node.props?.role === 'alert')
    if (withChannel) {
      assert.deepEqual(reports, [failure.text], 'with a channel the message goes to the channel')
      assert.equal(alert.length, 0, 'and is not drawn in the cell')
    } else {
      assert.equal(alert.length, 1, 'without a channel the cell shows it')
      assert.deepEqual(alert[0].children, [failure.text])
      assert.equal(alert[0].props.className, 'router-error')
    }
  }
})

test('a draft left open when the host menu closes is committed on unmount', async () => {
  const env = load()
  const calls = []
  env.harness.commandUi = { execute: async (_target, line) => { calls.push(line); return { kind: 'success' } } }
  const { cells } = levels(env, manualView({}), routes)
  const cell = env.runtime.mount(cells[0].type)
  let output = cell.render({ ...cells[0].props, open: true })
  findAll(output, (node) => node.props?.title === 'anthropic/claude-haiku-5-5' && node.props?.onSelect)[0].props.onSelect()
  output = cell.render()
  cell.unmount()
  await ticks()
  assert.deepEqual(calls, ['/router level mechanical anthropic/claude-haiku-5-5'])
})

test('mode failures go to the host toast', async () => {
  const env = load()
  const reports = []
  let view = { mode: 'off', pending: false, pendingTarget: null, pendingSince: null, failure: null }
  const option = env.registrations[0].component({ useProjection: () => view, reportFailure: (message) => reports.push(message) })
  env.harness.commandUi = { execute: async () => ({ kind: 'success' }) }
  const instance = env.runtime.mount(option.type)
  let output = instance.render(option.props)
  find(output, (node) => node.props?.className === 'router-toggle').props.onChange(true)
  await ticks()
  view = { ...view, failure: { count: 1, text: 'Router is already updating. Try again after it finishes.', target: 'mode', level: null } }
  output = instance.render()
  assert.deepEqual(reports, ['Router is already updating. Try again after it finishes.'])

  env.harness.commandUi = { execute: async () => ({ kind: 'error', text: 'unknown or malformed command: /router x' }) }
  find(output, (node) => node.props?.className === 'router-toggle').props.onChange(true)
  await ticks()
  assert.equal(reports[1], 'unknown or malformed command: /router x')
})

test('an unmount commit waits for the command already in flight instead of dropping the draft', async () => {
  const env = load()
  const calls = []
  let release
  env.harness.commandUi = { execute: (_target, line) => { calls.push(line); return new Promise((resolve) => { release = () => resolve({ kind: 'success' }) }) } }
  const { cells } = levels(env, manualView({}), routes)
  const first = env.runtime.mount(cells[0].type)
  let output = first.render({ ...cells[0].props, open: true })
  findAll(output, (node) => node.props?.title === 'anthropic/claude-haiku-5-5' && node.props?.onSelect)[0].props.onSelect()
  first.render({ ...cells[0].props, open: false })
  await ticks()
  assert.equal(calls.length, 1)
  const second = env.runtime.mount(cells[1].type)
  output = second.render({ ...cells[1].props, open: true })
  findAll(output, (node) => node.props?.title === 'anthropic/claude-haiku-5-5' && node.props?.onSelect)[0].props.onSelect()
  second.render()
  second.unmount()
  await ticks()
  assert.equal(calls.length, 1, 'the second commit is queued behind the first')
  release()
  await ticks()
  assert.deepEqual(calls, ['/router level mechanical anthropic/claude-haiku-5-5', '/router level ordinary anthropic/claude-haiku-5-5'])
})

test('a resolved commit overwritten by another tab clears the saving state without a toast', async () => {
  const env = load()
  const reports = []
  env.harness.commandUi = { execute: async () => ({ kind: 'success' }) }
  const { cells } = levels(env, manualView({}), routes, { reportFailure: (message) => reports.push(message) })
  const cell = env.runtime.mount(cells[0].type)
  let output = cell.render({ ...cells[0].props, open: true })
  findAll(output, (node) => node.props?.title === 'anthropic/claude-haiku-5-5' && node.props?.onSelect)[0].props.onSelect()
  output = cell.render({ ...cells[0].props, open: false })
  await ticks()
  output = cell.render({ ...cells[0].props, open: false, view: manualView({ mechanical: [selected[0]] }) })
  output = cell.render()
  const button = find(output, (node) => node.props?.role === 'menuitem')
  assert.equal(button.props['aria-busy'], false)
  assert.match(text(button), /deepseek-flash-latest/)
  assert.deepEqual(reports, [])
})

test('a switch press made while a level commit is in flight is queued, not dropped', async () => {
  const env = load()
  const calls = []
  let release
  env.harness.commandUi = { execute: (_target, line) => { calls.push(line); return line.startsWith('/router level') ? new Promise((resolve) => { release = () => resolve({ kind: 'success' }) }) : Promise.resolve({ kind: 'success' }) } }
  const { cells } = levels(env, manualView({}), routes)
  const cell = env.runtime.mount(cells[0].type)
  const output = cell.render({ ...cells[0].props, open: true })
  findAll(output, (node) => node.props?.title === 'anthropic/claude-haiku-5-5' && node.props?.onSelect)[0].props.onSelect()
  cell.render({ ...cells[0].props, open: false })
  await ticks()
  const option = env.registrations[0].component({ useProjection: () => manualView({}) })
  const toggle = find(env.runtime.mount(option.type).render(option.props), (node) => node.props?.className === 'router-toggle')
  toggle.props.onChange(false)
  await ticks()
  assert.deepEqual(calls, ['/router level mechanical anthropic/claude-haiku-5-5'])
  release()
  await ticks()
  assert.deepEqual(calls, ['/router level mechanical anthropic/claude-haiku-5-5', '/router off'])
})

const HAIKU = 'anthropic/claude-haiku-5-5'
const FLASH = 'openrouter/~deepseek/deepseek-flash-latest'
const levelLine = (level, text) => `/router level ${level} ${text}`

// 1. The lock, not a component callback, announces every release.
test('a level draft waiting behind the switch commits when the switch command settles', async () => {
  const env = load()
  const { calls, settle } = deferredExecute(env)
  const menu = levels(env, manualView({}), routes)
  pressSwitch(env, false)
  await ticks()
  const cell = env.runtime.mount(menu.cells[0].type)
  pick(cell.render({ ...menu.cells[0].props, open: true }), HAIKU)
  cell.render({ ...menu.cells[0].props, open: false })
  await ticks()
  assert.deepEqual(calls, ['/router off'], 'the draft waits while the switch holds the lock')
  settle[0]()
  await ticks()
  assert.equal(flush(menu, cell, 'mechanical'), true, 'the lock wakes the level cells')
  await ticks()
  assert.deepEqual(calls, ['/router off', levelLine('mechanical', HAIKU)])
})

test('a reopened menu wakes when the commit of the closed menu settles', async () => {
  const env = load()
  const { calls, settle } = deferredExecute(env)
  closeMenuWithDraft(env, levels(env, manualView({}), routes), 0, HAIKU)
  await ticks()
  assert.deepEqual(calls, [levelLine('mechanical', HAIKU)])
  const menu = levels(env, manualView({}), routes)
  const cell = env.runtime.mount(menu.cells[1].type)
  pick(cell.render({ ...menu.cells[1].props, open: true }), HAIKU)
  cell.render({ ...menu.cells[1].props, open: false })
  await ticks()
  assert.equal(calls.length, 1, 'the reopened menu waits for the earlier commit')
  settle[0]()
  await ticks()
  assert.equal(flush(menu, cell, 'ordinary'), true, 'the live menu is woken, not the closed one')
  await ticks()
  assert.deepEqual(calls, [levelLine('mechanical', HAIKU), levelLine('ordinary', HAIKU)])
})

// 2. The unmount commit never re-sends a draft that was already sent.
test('closing the flyout and then the menu before a re-render sends the draft once', async () => {
  const env = load()
  const calls = []
  env.harness.commandUi = { execute: async (_target, line) => { calls.push(line); return { kind: 'success' } } }
  const { cells } = levels(env, manualView({}), routes)
  const cell = env.runtime.mount(cells[0].type)
  pick(cell.render({ ...cells[0].props, open: true }), HAIKU)
  cell.render({ ...cells[0].props, open: false })
  cell.unmount()
  await ticks()
  assert.deepEqual(calls, [levelLine('mechanical', HAIKU)])
})

test('a new draft equal to an earlier confirmed one is still committed on unmount', async () => {
  const env = load()
  const calls = []
  env.harness.commandUi = { execute: async (_target, line) => { calls.push(line); return { kind: 'success' } } }
  const { cells } = levels(env, manualView({}), routes)
  const base = cells[0].props
  const cell = env.runtime.mount(cells[0].type)
  pick(cell.render({ ...base, open: true }), HAIKU)
  cell.render({ ...base, open: false })
  await ticks()
  cell.render({ ...base, open: false, view: manualView({ mechanical: [haiku] }) })
  // Another tab changes the level; the user picks the earlier value again.
  pick(cell.render({ ...base, open: true, view: manualView({ mechanical: [selected[0]] }) }), FLASH)
  pick(cell.render(), HAIKU)
  cell.render()
  cell.unmount()
  await ticks()
  assert.deepEqual(calls, [levelLine('mechanical', HAIKU), levelLine('mechanical', HAIKU)])
})

// 3. Expiry counts from when a command starts, and commands still run one at a time.
test('lock expiry counts from when a command starts, not from when it was queued', async () => {
  const env = load()
  const { calls, settle } = deferredExecute(env)
  const menu = levels(env, manualView({}), routes)
  pressSwitch(env, false)
  closeMenuWithDraft(env, menu, 0, HAIKU)
  await ticks()
  assert.deepEqual(calls, ['/router off'], 'the unmount commit queues behind the switch')
  env.clock.offset += 29_000
  settle[0]()
  await ticks()
  assert.deepEqual(calls, ['/router off', levelLine('mechanical', HAIKU)])
  // Queued 31 s ago, but started only 2 s ago: still in flight.
  env.clock.offset += 2_000
  pressSwitch(env, true)
  await ticks()
  assert.deepEqual(calls, ['/router off', levelLine('mechanical', HAIKU)], 'one command at a time')
  settle[1]()
  await ticks()
  assert.deepEqual(calls, ['/router off', levelLine('mechanical', HAIKU), '/router manual'])
})

test('a hung command lets the queue advance in order once it has run for 30 s', async () => {
  const env = load()
  const { calls, settle } = deferredExecute(env)
  const menu = levels(env, manualView({}), routes)
  pressSwitch(env, false)
  env.clock.offset += 1_000
  closeMenuWithDraft(env, menu, 0, HAIKU)
  await ticks()
  env.clock.offset += 32_000
  pressSwitch(env, true)
  await ticks()
  assert.deepEqual(calls, ['/router off', levelLine('mechanical', HAIKU)], 'the queued command runs next; the new press waits')
  settle[1]()
  await ticks()
  assert.deepEqual(calls, ['/router off', levelLine('mechanical', HAIKU), '/router manual'])
  settle[0]()
  await ticks()
  assert.equal(calls.length, 3, 'the hung call returning late starts nothing')
})

test('cells waiting on a hung command commit once it has run for 30 s', async () => {
  const env = load()
  const { calls } = deferredExecute(env)
  const menu = levels(env, manualView({}), routes)
  pressSwitch(env, false)
  await ticks()
  const cell = env.runtime.mount(menu.cells[0].type)
  pick(cell.render({ ...menu.cells[0].props, open: true }), HAIKU)
  cell.render({ ...menu.cells[0].props, open: false })
  await ticks()
  assert.deepEqual(calls, ['/router off'])
  env.clock.offset += 31_000
  rerender(menu, cell, 'mechanical')
  await ticks()
  assert.equal(flush(menu, cell, 'mechanical'), true, 'the expiry wakes the waiting cells')
  await ticks()
  assert.deepEqual(calls, ['/router off', levelLine('mechanical', HAIKU)])
})

// 4. A sent draft has a deadline, so the spinner cannot stay forever.
test('a sent draft the session never confirms snaps back after the deadline with one report', async () => {
  const env = load()
  const calls = []
  const reports = []
  env.harness.commandUi = { execute: async (_target, line) => { calls.push(line); return { kind: 'success' } } }
  const { cells } = levels(env, manualView({}), routes, { reportFailure: (message) => reports.push(message) })
  const cell = env.runtime.mount(cells[0].type)
  pick(cell.render({ ...cells[0].props, open: true }), HAIKU)
  cell.render({ ...cells[0].props, open: false })
  await ticks()
  env.clock.offset += 29_000
  assert.equal(cellButton(cell.render()).props['aria-busy'], true, 'saving until confirmed, within the deadline')
  env.clock.offset += 2_000
  cell.render()
  const button = cellButton(cell.render())
  assert.equal(button.props['aria-busy'], false)
  assert.match(text(button), /"Inherit"/)
  assert.deepEqual(reports, ['Could not update this level.'])
  cell.render()
  assert.equal(reports.length, 1)
  assert.deepEqual(calls, [levelLine('mechanical', HAIKU)], 'the draft is not sent again')
})

test('the save deadline counts from when the command starts and covers a call that never returns', async () => {
  const env = load()
  const { calls, settle } = deferredExecute(env)
  const reports = []
  const extra = { reportFailure: (message) => reports.push(message) }
  closeMenuWithDraft(env, levels(env, manualView({}), routes, extra), 0, HAIKU)
  const menu = levels(env, manualView({}), routes, extra)
  const cell = env.runtime.mount(menu.cells[0].type)
  pick(cell.render({ ...menu.cells[0].props, open: true }), FLASH)
  cell.render({ ...menu.cells[0].props, open: false })
  await ticks()
  assert.equal(calls.length, 1, 'the new commit queues behind the slow one')
  env.clock.offset += 20_000
  settle[0]()
  await ticks()
  assert.deepEqual(calls, [levelLine('mechanical', HAIKU), levelLine('mechanical', FLASH)])
  env.clock.offset += 25_000
  cell.render()
  assert.equal(cellButton(cell.render()).props['aria-busy'], true)
  assert.deepEqual(reports, [], 'time spent queued does not count')
  env.clock.offset += 6_000
  cell.render()
  assert.equal(cellButton(cell.render()).props['aria-busy'], false)
  assert.deepEqual(reports, ['Could not update this level.'])
})

const FAILED = 'Could not update this level.'
const rowFor = (output, title) => findAll(output, (node) => node.props?.title === title && node.props?.onSelect)[0]
const cellIn = (output, level) => findAll(output, (node) => typeof node.type === 'function' && node.props?.level === level)[0]

// 5. A call that never returns stops holding back its own cell once the lock
// has ended its turn.
test('after a hung commit passes the deadline, a new draft from the same open menu is sent', async () => {
  const env = load()
  const { calls } = deferredExecute(env)
  const reports = []
  const { cells } = levels(env, manualView({}), routes, { reportFailure: (message) => reports.push(message) })
  const base = cells[0].props
  const cell = env.runtime.mount(cells[0].type)
  pick(cell.render({ ...base, open: true }), HAIKU)
  cell.render({ ...base, open: false })
  await ticks()
  assert.deepEqual(calls, [levelLine('mechanical', HAIKU)])
  env.clock.offset += 31_000
  cell.render()
  assert.deepEqual(reports, [FAILED])
  assert.match(text(cellButton(cell.render())), /"Inherit"/, 'the unconfirmed draft snapped back')
  pick(cell.render({ ...base, open: true }), FLASH)
  cell.render({ ...base, open: false })
  await ticks()
  assert.deepEqual(calls, [levelLine('mechanical', HAIKU), levelLine('mechanical', FLASH)],
    'the hung call no longer holds back the cell')
  assert.equal(cellButton(cell.render()).props['aria-busy'], true, 'the new commit shows its own spinner')
  assert.deepEqual(reports, [FAILED])
})

test('a draft waiting behind its own hung commit is sent once, after the deadline reports the hung one', async () => {
  const env = load()
  const { calls, settle } = deferredExecute(env)
  const reports = []
  const { cells } = levels(env, manualView({}), routes, { reportFailure: (message) => reports.push(message) })
  const base = cells[0].props
  const cell = env.runtime.mount(cells[0].type)
  pick(cell.render({ ...base, open: true }), HAIKU)
  cell.render({ ...base, open: false })
  await ticks()
  // The user changes their mind while the first commit is still in flight.
  env.clock.offset += 5_000
  pick(cell.render({ ...base, open: true }), HAIKU)
  pick(cell.render(), FLASH)
  cell.render({ ...base, open: false })
  await ticks()
  assert.deepEqual(calls, [levelLine('mechanical', HAIKU)], 'the new draft waits while its own call is in flight')
  env.clock.offset += 26_000
  // The deadline render, then the render its state change causes.
  cell.render()
  cell.render()
  await ticks()
  assert.deepEqual(reports, [FAILED], 'the hung commit is reported once')
  assert.deepEqual(calls, [levelLine('mechanical', HAIKU), levelLine('mechanical', FLASH)],
    'the waiting draft survives the deadline and is sent')
  settle[1]()
  await ticks()
  cell.render()
  await ticks()
  assert.equal(calls.length, 2, 'the waiting draft is sent exactly once')
  assert.equal(cellButton(cell.render()).props['aria-busy'], true, 'saving until the session confirms it')
  cell.render({ ...base, open: false, view: manualView({ mechanical: [selected[0]] }) })
  assert.equal(cellButton(cell.render()).props['aria-busy'], false)
  assert.deepEqual(reports, [FAILED])
})

test('a hung call the host already rejected stops holding back a newer draft once it has run for 30 s', async () => {
  const env = load()
  const { calls } = deferredExecute(env)
  const reports = []
  const { cells } = levels(env, manualView({}), routes, { reportFailure: (message) => reports.push(message) })
  const base = cells[0].props
  const cell = env.runtime.mount(cells[0].type)
  pick(cell.render({ ...base, open: true }), HAIKU)
  cell.render({ ...base, open: false })
  await ticks()
  // The session records a rejection, but the call itself never returns.
  const failure = { count: 1, text: `Route ${HAIKU} is not authorized for this session.`, target: 'level', level: 'mechanical' }
  const rejected = { ...base, open: false, view: manualView({}, { failure }) }
  cell.render(rejected)
  assert.deepEqual(reports, [failure.text])
  pick(cell.render({ ...rejected, open: true }), FLASH)
  cell.render({ ...rejected, open: false })
  await ticks()
  assert.deepEqual(calls, [levelLine('mechanical', HAIKU)], 'the new draft waits while its own call runs')
  env.clock.offset += 31_000
  cell.render()
  await ticks()
  assert.deepEqual(calls, [levelLine('mechanical', HAIKU), levelLine('mechanical', FLASH)], 'the first render after 30 s sends it')
  assert.deepEqual(reports, [failure.text], 'the rejected call is not reported again')
})

// 6. One toast per failed commit.
test('a hung commit that fails after the deadline is not reported a second time', async () => {
  const env = load()
  const { resolveWith } = deferredExecute(env)
  const reports = []
  const { cells } = levels(env, manualView({}), routes, { reportFailure: (message) => reports.push(message) })
  const base = cells[0].props
  const cell = env.runtime.mount(cells[0].type)
  pick(cell.render({ ...base, open: true }), HAIKU)
  cell.render({ ...base, open: false })
  await ticks()
  env.clock.offset += 31_000
  cell.render()
  assert.deepEqual(reports, [FAILED])
  resolveWith[0]({ kind: 'error', text: `unknown or malformed command: ${levelLine('mechanical', HAIKU)}` })
  await ticks()
  cell.render()
  assert.deepEqual(reports, [FAILED], 'one toast per failed commit')
  assert.match(text(cellButton(cell.render())), /"Inherit"/)
})

test('a level command the host does not admit is reported once, also when it is sent on unmount', async () => {
  const env = load()
  const reports = []
  env.harness.commandUi = { execute: async (_target, line) => ({ kind: 'error', text: `unknown or malformed command: ${line}` }) }
  const { cells } = levels(env, manualView({}), routes, { reportFailure: (message) => reports.push(message) })
  const cell = env.runtime.mount(cells[0].type)
  pick(cell.render({ ...cells[0].props, open: true }), HAIKU)
  cell.render({ ...cells[0].props, open: false })
  await ticks()
  assert.match(text(cellButton(cell.render())), /"Inherit"/)
  assert.deepEqual(reports, [`unknown or malformed command: ${levelLine('mechanical', HAIKU)}`])
  const closing = env.runtime.mount(cells[1].type)
  pick(closing.render({ ...cells[1].props, open: true }), HAIKU)
  closing.render()
  closing.unmount()
  await ticks()
  assert.deepEqual(reports, [
    `unknown or malformed command: ${levelLine('mechanical', HAIKU)}`,
    `unknown or malformed command: ${levelLine('ordinary', HAIKU)}`,
  ])
})

// 7. Only the draft that was sent snaps back; a newer one survives.
test('a pick made just as the deadline passes survives it and is committed', async () => {
  const env = load()
  const calls = []
  const reports = []
  env.harness.commandUi = { execute: async (_target, line) => { calls.push(line); return { kind: 'success' } } }
  const { cells } = levels(env, manualView({}), routes, { reportFailure: (message) => reports.push(message) })
  const base = cells[0].props
  const cell = env.runtime.mount(cells[0].type)
  pick(cell.render({ ...base, open: true }), HAIKU)
  cell.render({ ...base, open: false })
  await ticks()
  env.clock.offset += 29_000
  const reopened = cell.render({ ...base, open: true })
  assert.deepEqual(reports, [])
  env.clock.offset += 2_000
  // The click comes after the deadline; the render it causes runs the deadline.
  pick(reopened, FLASH)
  cell.render()
  assert.deepEqual(reports, [FAILED], 'the unconfirmed commit is still reported')
  assert.equal(rowFor(cell.render(), FLASH).props.checked, true, 'the click survives the deadline')
  cell.render({ ...base, open: false })
  await ticks()
  assert.deepEqual(calls, [levelLine('mechanical', HAIKU), levelLine('mechanical', `${HAIKU},${FLASH}`)])
})

test('a commit the host does not admit snaps back without discarding a newer pick', async () => {
  const env = load()
  const { calls, resolveWith } = deferredExecute(env)
  const reports = []
  const { cells } = levels(env, manualView({}), routes, { reportFailure: (message) => reports.push(message) })
  const base = cells[0].props
  const cell = env.runtime.mount(cells[0].type)
  pick(cell.render({ ...base, open: true }), HAIKU)
  cell.render({ ...base, open: false })
  await ticks()
  pick(cell.render({ ...base, open: true }), HAIKU)
  pick(cell.render(), FLASH)
  cell.render()
  resolveWith[0]({ kind: 'error', text: 'unknown or malformed command: x' })
  await ticks()
  assert.deepEqual(reports, ['unknown or malformed command: x'])
  assert.equal(rowFor(cell.render(), FLASH).props.checked, true, 'the newer pick survives the failed commit')
  cell.render({ ...base, open: false })
  await ticks()
  assert.deepEqual(calls, [levelLine('mechanical', HAIKU), levelLine('mechanical', FLASH)])
})

// 8. A cell belongs to one session.
test('a session switch remounts the level cells, so an open draft commits to its own session', async () => {
  const env = load()
  const calls = []
  env.harness.commandUi = { execute: async (target, line) => { calls.push([target.sessionId, line]); return { kind: 'success' } } }
  const menu = levels(env, manualView({}), routes, { sessionId: 'one' })
  menu.cells[0].props.onOpen()
  const before = cellIn(menu.parent.render(), 'mechanical')
  assert.equal(before.props.open, true)
  let cell = env.runtime.mount(before.type)
  pick(cell.render(before.props), HAIKU)
  cell.render()
  // The host switches the session while the model menu stays open.
  const after = cellIn(menu.parent.render({ ...menu.parent.instance.props, sessionId: 'two' }), 'mechanical')
  // As React reconciles keyed children: a kept key re-renders the same cell,
  // a new key unmounts it and mounts a fresh one.
  if (after.props.key === before.props.key) cell.render(after.props)
  else {
    cell.unmount()
    cell = env.runtime.mount(after.type)
    cell.render(after.props)
  }
  const shown = text(cellButton(cell.render()))
  cell.unmount()
  menu.parent.unmount()
  await ticks()
  assert.deepEqual(calls, [['one', levelLine('mechanical', HAIKU)]], 'the draft goes to the session it was made in')
  assert.match(shown, /"Inherit"/, "the switched session's cell does not show the old draft")
})

// 9. The switch sends one command per press, not per click while queued.
test('a second switch press while the first is still queued sends no second command', async () => {
  const env = load()
  const { calls, settle } = deferredExecute(env)
  const { cells } = levels(env, manualView({}), routes)
  const cell = env.runtime.mount(cells[0].type)
  pick(cell.render({ ...cells[0].props, open: true }), HAIKU)
  cell.render({ ...cells[0].props, open: false })
  await ticks()
  let view = manualView({})
  const option = env.registrations[0].component({ useProjection: () => view })
  const instance = env.runtime.mount(option.type)
  const toggle = () => find(instance.render(option.props), (node) => node.props?.className === 'router-toggle')
  toggle().props.onChange(false)
  await ticks()
  toggle().props.onChange(false)
  await ticks()
  settle[0]()
  await ticks()
  settle[1]()
  await ticks()
  assert.deepEqual(calls, [levelLine('mechanical', HAIKU), '/router off'])
  // Once the session shows the result, the switch works again.
  view = { ...manualView({}), mode: 'off' }
  toggle().props.onChange(true)
  await ticks()
  assert.deepEqual(calls, [levelLine('mechanical', HAIKU), '/router off', '/router manual'])
})

// 10. Per-model efforts: under each authorized model row, a row of effort
// rows from the session's model directory, part of the same draft.
const LEVEL_NAMES = ['mechanical', 'ordinary', 'hard']
const CODEX = 'openai-codex/~deepseek/deepseek-flash-latest'
const SESSION = 'session-1'
const NAMES = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }
const efforts = (...ids) => ids.map((id) => ({ id, name: NAMES[id] ?? id }))
// Provider groups as the directory snapshot holds them, efforts least to
// greatest. The openai-codex model is listed without efforts.
const CATALOG = [
  { id: 'openrouter', name: 'OpenRouter', models: [{ id: '~deepseek/deepseek-flash-latest', name: 'Flash', reasoning: { efforts: efforts('off', 'low', 'high'), defaultEffort: 'high' } }] },
  { id: 'openai-codex', name: 'Codex', models: [{ id: '~deepseek/deepseek-flash-latest', name: 'Flash' }] },
  { id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-haiku-5-5', name: 'Haiku', reasoning: { efforts: efforts('low', 'medium', 'high', 'xhigh', 'max'), defaultEffort: 'medium' } }] },
]
const HAIKU_EFFORTS = ['Default (Medium)', 'Low', 'Medium', 'High', 'Extra high', 'Max']

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
// The anthropic group with only the haiku model, for the per-model cases.
const haikuCatalog = (reasoning) => [{ id: 'anthropic', models: [reasoning === undefined ? { id: 'claude-haiku-5-5' } : { id: 'claude-haiku-5-5', reasoning }] }]

function recordingExecute(env) {
  const calls = []
  env.harness.commandUi = { execute: async (_target, line) => { calls.push(line); return { kind: 'success' } } }
  return calls
}

// One level cell of the menu in session SESSION, mounted as the host menu
// mounts it; render() keeps the props given so far.
function cellHarness({ level = 'hard', view = manualView({}), routeList = routes, getService = directoryService(fakeDirectory()), execute = 'record', extra = {}, locale, globals, prelude } = {}) {
  const env = load({ getService, locale, globals, prelude })
  const commands = execute === 'deferred' ? deferredExecute(env) : { calls: recordingExecute(env) }
  const reports = []
  const menu = levels(env, view, routeList, { sessionId: SESSION, reportFailure: (message) => reports.push(message), ...extra })
  const element = menu.cells[LEVEL_NAMES.indexOf(level)]
  const cell = env.runtime.mount(element.type)
  let props = { ...element.props, open: false }
  let output = cell.render(props)
  const render = (changes = {}) => {
    props = { ...props, ...changes }
    output = cell.render(props)
    return output
  }
  return {
    env, menu, cell, reports, ...commands, render,
    open: () => render({ open: true }),
    close: () => render({ open: false }),
    output: () => output,
  }
}

const effortGroupOf = (output, key) => find(output, (node) => node.props?.key === `efforts:${key}`)
const effortRowsOf = (output, key) => {
  const row = effortGroupOf(output, key)
  return row === undefined ? undefined : findAll(row, (node) => node.props?.role === 'menuitemradio' && typeof node.props.onSelect === 'function')
}
// `<label>[ (<note>)][ [warning]]=<checked>` per effort row; undefined without an effort group.
const effortSummary = (output, key) => effortRowsOf(output, key)?.map((row) =>
  `${row.props.label}${row.props.note ? ` (${row.props.note})` : ''}${row.props.warning ? ' [warning]' : ''}=${row.props.checked}`)
const pickEffort = (output, key, label) => {
  const row = effortRowsOf(output, key)?.find((candidate) => candidate.props.label === label)
  assert.ok(row, `${key}: effort row ${label}`)
  row.props.onSelect()
}
const allEffortRows = (output) => findAll(output, (node) => node.props?.role === 'menuitemradio' && typeof node.props.onSelect === 'function')
const pickInherit = (output) => findAll(output, (node) => node.props?.label === 'Inherit (session default)')[0].props.onSelect()
const valueSpan = (output) => find(output, (node) => node.props?.className === 'router-cell-value').children.join('')
const effortSpan = (output) => find(output, (node) => node.props?.className === 'router-cell-effort')?.children.join('')
const moreSpan = (output) => find(output, (node) => node.props?.className === 'router-cell-more')?.children.join('')

test('each authorized model row is followed by its effort group of native rows, hidden until the model is checked', () => {
  const harness = cellHarness({ level: 'ordinary', view: manualView({ ordinary: [haiku] }) })
  const output = harness.open()
  assert.deepEqual(effortSummary(output, HAIKU), ['Default (Medium) (recommended)=true', 'Low=false', 'Medium=false', 'High=false', 'Extra high=false', 'Max=false'])
  assert.equal(effortGroupOf(output, HAIKU).props.hidden, false)
  assert.deepEqual(effortSummary(output, FLASH), ['Default (High) (recommended)=false', 'Off=false', 'Low=false', 'High=false'])
  assert.equal(effortGroupOf(output, FLASH).props.hidden, true, 'hidden until its model is checked')
  assert.equal(effortGroupOf(output, CODEX), undefined, 'a model listed without efforts has no effort group')
  // The group follows its model row inside the provider group, with no heading row of its own.
  const group = find(output, (node) => node.props?.className === 'router-group' && node.props['aria-label'] === 'anthropic')
  const members = group.children.flat(Infinity).filter((node) => node !== null && typeof node === 'object')
  assert.deepEqual(members.map((node) => node.props.className ?? node.props.title), ['router-heading', HAIKU, 'router-efforts'])
  const row = effortGroupOf(output, HAIKU)
  assert.deepEqual([row.type, row.props.role, row.props.className, row.props['aria-label']], ['div', 'group', 'router-efforts', 'Effort for claude-haiku-5-5'])
  assert.equal(findAll(row, (node) => node.props?.className === 'router-heading').length, 0, 'no heading row per model')
  // Rows are menuitemradio buttons in the advertised order; Default carries no effort id.
  const rows = effortRowsOf(output, HAIKU)
  assert.deepEqual(rows.map((entry) => entry.props.label), HAIKU_EFFORTS)
  assert.deepEqual(rows.map((entry) => entry.props.title ?? '-'), ['-', 'low', 'medium', 'high', 'xhigh', 'max'])
  const rendered = rows.map((entry) => entry.type(entry.props))
  // The same row look as a model row, indented, with the model rows' own check glyph on the checked row only.
  assert.deepEqual(rendered.map((button) => [button.type, button.props.role, button.props.className]),
    rows.map(() => ['button', 'menuitemradio', 'router-option router-option-effort']), 'indentation class on every effort row')
  assert.deepEqual(rendered.map((button) => button.props['aria-checked']), [true, false, false, false, false, false])
  const checkOf = (button) => find(button, (node) => node.props?.className === 'router-check')
  assert.deepEqual(rendered.map((button) => checkOf(button).children.filter((node) => node !== null).length), [1, 0, 0, 0, 0, 0], 'a check mark on the checked row only')
  const modelRow = rowFor(output, HAIKU)
  const renderedModel = modelRow.type(modelRow.props)
  assert.deepEqual([renderedModel.props.role, renderedModel.props.className], ['menuitemcheckbox', 'router-option'])
  assert.deepEqual(checkOf(rendered[0]).children, checkOf(renderedModel).children, 'the same check glyph as the model rows')
  // The caption of the recommended row is right-aligned before the check; other rows have none.
  const noteOf = (button) => find(button, (node) => node.props?.className === 'router-option-note')
  assert.equal(noteOf(rendered[0]).children.join(''), 'recommended')
  assert.deepEqual(rendered.slice(1).map(noteOf), [undefined, undefined, undefined, undefined, undefined])
  assert.deepEqual(rendered[0].children.map((node) => node.props.className), ['router-option-label', 'router-option-note', 'router-check'])
  assert.equal(find(rendered[0], (node) => node.props?.className === 'router-option-label').children.join(''), 'Default (Medium)')
  assert.equal(findAll(output, (node) => node.props?.role === 'separator').length, 1)
  const css = find(harness.menu.output, (node) => node.type === 'style').children.join('')
  assert.match(css, /\.router-efforts\[hidden\]\{display:none\}/, 'the author display rule must not show a hidden effort group')
  assert.match(css, /\.router-option-effort\{padding-inline-start:23px\}/)
  assert.match(css, /\.router-option-effort \.router-option-label\{color:var\(--dsw-alias-label-secondary\)\}/)
  assert.match(css, /\.router-option-note\{flex:none;color:var\(--dsw-alias-label-tertiary\)/)
  assert.match(css, /\.router-option\[aria-disabled=true\]\{opacity:\.4;/)
  assert.match(css, /\.router-option\[data-warning\] \.router-option-label\{color:var\(--dsw-alias-state-warn-label\)\}/)
  assert.doesNotMatch(css, /router-chip/, 'no effort row or pill styles remain')
})

test('checking a model reveals its effort rows in place; no row or effort row is added or removed while the flyout is open', () => {
  const harness = cellHarness({ view: manualView({ hard: [haiku] }) })
  let output = harness.open()
  const count = allEffortRows(output).length
  assert.equal(count, HAIKU_EFFORTS.length + 4)
  pick(output, FLASH)
  output = harness.render()
  assert.equal(effortGroupOf(output, FLASH).props.hidden, false)
  assert.equal(allEffortRows(output).length, count)
  pick(output, FLASH)
  output = harness.render()
  assert.equal(effortGroupOf(output, FLASH).props.hidden, true, 'unchecked: hidden again')
  pick(output, HAIKU)
  output = harness.render()
  assert.equal(effortGroupOf(output, HAIKU).props.hidden, true)
  pickInherit(output)
  output = harness.render()
  assert.equal(allEffortRows(output).length, count, 'no effort row comes or goes')
  assert.equal(effortRowsOf(output, FLASH).every((row) => row.props.disabled === true), true, 'effort rows of a model that is not checked are disabled')
  assert.equal(effortRowsOf(output, FLASH).some((row) => row.props.checked), false)
})

test('effort rows come from the directory snapshot frozen when the flyout opens', () => {
  const directory = fakeDirectory([])
  const harness = cellHarness({ view: manualView({ hard: [haiku] }), getService: directoryService(directory) })
  let output = harness.open()
  assert.deepEqual(effortSummary(output, HAIKU), ['Default=true'], 'loading: efforts unknown, Default only, no recommendation')
  directory.publish(CATALOG)
  assert.equal(harness.menu.parent.instance.dirty, true, 'a directory update re-renders the level menu')
  output = harness.render()
  assert.deepEqual(effortSummary(output, HAIKU), ['Default=true'], 'no effort row appears while open')
  assert.deepEqual(effortSummary(output, CODEX), ['Default=false'])
  harness.close()
  output = harness.open()
  assert.deepEqual(effortSummary(output, HAIKU), ['Default (Medium)=true', 'Low=false', 'Medium=false', 'High=false', 'Extra high (recommended)=false', 'Max=false'])
  assert.equal(effortGroupOf(output, CODEX), undefined)
  const count = allEffortRows(output).length
  directory.publish(haikuCatalog({ efforts: efforts('max'), defaultEffort: 'max' }))
  output = harness.render()
  assert.equal(allEffortRows(output).length, count, 'no effort row disappears while open')
  assert.equal(effortSummary(output, HAIKU)[0], 'Default (Medium)=true', 'nor is renamed')
  directory.publish([])
  harness.close()
  assert.deepEqual(effortSummary(harness.open(), HAIKU), ['Default=true'], 'the next opening reads the directory again')
})

// Check the haiku row on a level without saved routes: the marked effort row, the
// checked effort row, and the line sent when the flyout closes.
async function firstCheck(level, groups) {
  const harness = cellHarness({ level, getService: directoryService(fakeDirectory(groups)) })
  pick(harness.open(), HAIKU)
  const output = harness.render()
  const rows = effortRowsOf(output, HAIKU) ?? []
  const result = {
    marked: rows.filter((row) => row.props.note === 'recommended').map((row) => row.props.title ?? 'default'),
    checked: rows.filter((row) => row.props.checked).map((row) => row.props.title ?? 'default'),
  }
  harness.close()
  await ticks()
  return { ...result, line: harness.calls[0] }
}
const lineWith = (level, effort) => levelLine(level, effort === undefined ? HAIKU : `${HAIKU} effort=${effort}`)

test('recommended default: Mechanical never recommends an effort, for any list, and checking sends no effort token', async () => {
  for (const [reasoning, why] of [
    [{ efforts: efforts('low', 'medium', 'high'), defaultEffort: 'medium' }, 'low is no longer recommended below the default'],
    [{ efforts: efforts('off', 'low', 'high'), defaultEffort: 'high' }, 'a list with off and low'],
    [{ efforts: efforts('minimal', 'low', 'medium'), defaultEffort: 'low' }, 'the lowest is the default'],
    [{ efforts: efforts('off', 'low', 'high'), defaultEffort: 'off' }, 'default off'],
    [{ efforts: efforts('xhigh', 'max'), defaultEffort: 'xhigh' }, 'only high efforts'],
    [{ efforts: efforts('minimal', 'low', 'high') }, 'default unknown, low advertised'],
    [{ efforts: efforts('low', 'high'), defaultEffort: 'turbo' }, 'a default that is not advertised'],
    [{ efforts: efforts('off'), defaultEffort: 'off' }, 'only off'],
  ]) {
    const result = await firstCheck('mechanical', haikuCatalog(reasoning))
    assert.deepEqual(result, { marked: ['default'], checked: ['default'], line: lineWith('mechanical') }, why)
  }
})

test('recommended default: the Default row carries the recommended caption for Mechanical and Ordinary', () => {
  for (const level of ['mechanical', 'ordinary']) {
    const output = cellHarness({ level, view: manualView({ [level]: [haiku] }) }).open()
    assert.deepEqual(effortSummary(output, HAIKU), ['Default (Medium) (recommended)=true', 'Low=false', 'Medium=false', 'High=false', 'Extra high=false', 'Max=false'], level)
    assert.deepEqual(effortSummary(output, FLASH), ['Default (High) (recommended)=false', 'Off=false', 'Low=false', 'High=false'], level)
  }
})

test('recommended default: Ordinary keeps Default; Hard judgment takes the highest advertised below max, never off', async () => {
  for (const reasoning of [{ efforts: efforts('low', 'medium', 'high'), defaultEffort: 'medium' }, { efforts: efforts('off', 'low') }]) {
    assert.deepEqual(await firstCheck('ordinary', haikuCatalog(reasoning)), { marked: ['default'], checked: ['default'], line: lineWith('ordinary') })
  }
  for (const [reasoning, effort, why] of [
    [{ efforts: efforts('low', 'medium', 'high', 'xhigh', 'max'), defaultEffort: 'medium' }, 'xhigh', 'max stays a deliberate pick'],
    [{ efforts: efforts('low', 'high') }, 'high', 'the highest advertised'],
    [{ efforts: efforts('off', 'low') }, 'low', 'off is skipped'],
    [{ efforts: efforts('max'), defaultEffort: 'max' }, undefined, 'only max: Default'],
    [{ efforts: efforts('off', 'max') }, undefined, 'off is never recommended'],
  ]) {
    assert.deepEqual(await firstCheck('hard', haikuCatalog(reasoning)), { marked: [effort ?? 'default'], checked: [effort ?? 'default'], line: lineWith('hard', effort) }, why)
  }
})

test('recommended default: unknown or absent efforts give Default without a mark at every level', async () => {
  for (const level of LEVEL_NAMES) {
    for (const [name, groups] of [
      ['groups not loaded', []],
      ['groups malformed', null],
      ['model not listed', [{ id: 'anthropic', models: [{ id: 'claude-other', reasoning: { efforts: efforts('low') } }] }]],
      ['reasoning malformed', haikuCatalog({ efforts: 'low' })],
      ['every entry unusable', haikuCatalog({ efforts: [{ id: 'two words' }, { id: '' }, { id: 7 }, null, { id: 'a,b' }, { id: 'x'.repeat(33) }] })],
    ]) assert.deepEqual(await firstCheck(level, groups), { marked: [], checked: ['default'], line: lineWith(level) }, `${level}: ${name}`)
    for (const [name, groups] of [['listed without efforts', haikuCatalog(undefined)], ['empty list', haikuCatalog({ efforts: [], defaultEffort: 'low' })]]) {
      assert.deepEqual(await firstCheck(level, groups), { marked: [], checked: [], line: lineWith(level) }, `${level}: ${name}: no effort group`)
    }
  }
  const torn = { getSnapshot() { throw new Error('torn down') }, subscribe() { throw new Error('torn down') } }
  for (const [name, getService] of [
    ['service absent', () => undefined],
    ['ctx.get throws', (service) => { if (service === 'modelDirectories') throw new Error('no such service') }],
    ['directoryFor throws', (service) => service === 'modelDirectories' ? { directoryFor() { throw new Error('no scope') } } : undefined],
    ['no store', (service) => service === 'modelDirectories' ? { directoryFor: () => ({}) } : undefined],
    ['store throws', (service) => service === 'modelDirectories' ? { directoryFor: () => ({ store: torn }) } : undefined],
  ]) {
    const harness = cellHarness({ getService })
    pick(harness.open(), HAIKU)
    assert.deepEqual(effortSummary(harness.render(), HAIKU), ['Default=true'], name)
    harness.close()
    await ticks()
    assert.deepEqual(harness.calls, [lineWith('hard')], name)
  }
})

test('a saved model keeps its saved effort; re-checking in the same open restores the earlier pick', async () => {
  const harness = cellHarness({ view: manualView({ hard: [haiku] }) })
  let output = harness.open()
  assert.deepEqual(effortSummary(output, HAIKU), ['Default (Medium)=true', 'Low=false', 'Medium=false', 'High=false', 'Extra high (recommended)=false', 'Max=false'],
    'the saved Default is shown, not the recommendation')
  harness.close()
  await ticks()
  assert.deepEqual(harness.calls, [], 'opening and closing a saved level sends nothing: no default on load')
  // Unchecking and re-checking the saved model restores its saved effort.
  pick(harness.open(), HAIKU)
  pick(harness.render(), HAIKU)
  assert.equal(effortSummary(harness.render(), HAIKU)[0], 'Default (Medium)=true')
  // An effort row pick, then uncheck and re-check in the same open: the pick comes back.
  pickEffort(harness.render(), HAIKU, 'Low')
  pick(harness.render(), HAIKU)
  pick(harness.render(), HAIKU)
  assert.equal(effortSummary(harness.render(), HAIKU)[1], 'Low=true')
  // A model that is not saved: its first check brings the recommendation, a re-check the pick.
  pick(harness.render(), FLASH)
  assert.deepEqual(effortSummary(harness.render(), FLASH), ['Default (High)=false', 'Off=false', 'Low=false', 'High (recommended)=true'])
  pickEffort(harness.render(), FLASH, 'Off')
  pick(harness.render(), FLASH)
  pick(harness.render(), FLASH)
  assert.equal(effortSummary(harness.render(), FLASH)[1], 'Off=true', 'a hand-picked off stays')
  harness.close()
  await ticks()
  assert.deepEqual(harness.calls, [levelLine('hard', `${HAIKU} effort=low,${FLASH} effort=off`)])
  // A saved effort is restored as saved too, never replaced by the recommendation.
  const savedMax = cellHarness({ view: manualView({ hard: [{ ...haiku, effort: 'max' }] }) })
  pick(savedMax.open(), HAIKU)
  pick(savedMax.render(), HAIKU)
  assert.equal(effortSummary(savedMax.render(), HAIKU)[5], 'Max=true')
  savedMax.close()
  await ticks()
  assert.deepEqual(savedMax.calls, [])
  // A new opening forgets the picks: the next first check brings the recommendation again.
  const forget = cellHarness({ view: manualView({ hard: [haiku] }) })
  pick(forget.open(), FLASH)
  pickEffort(forget.render(), FLASH, 'Low')
  pick(forget.render(), FLASH)
  forget.close()
  await ticks()
  assert.deepEqual(forget.calls, [], 'back to the saved value: nothing to send')
  pick(forget.open(), FLASH)
  assert.equal(effortSummary(forget.render(), FLASH)[3], 'High (recommended)=true')
})

test('effort row picks and model checks commit one command for the whole level when the flyout closes', async () => {
  const harness = cellHarness({ view: manualView({ hard: [{ ...haiku, effort: 'xhigh' }] }) })
  pick(harness.open(), FLASH)
  pickEffort(harness.render(), HAIKU, 'Max')
  pickEffort(harness.render(), HAIKU, 'Low')
  const output = harness.render()
  assert.deepEqual(effortSummary(output, HAIKU), ['Default (Medium)=false', 'Low=true', 'Medium=false', 'High=false', 'Extra high (recommended)=false', 'Max=false'])
  await ticks()
  assert.deepEqual(harness.calls, [], 'nothing is sent while the flyout is open')
  harness.close()
  await ticks()
  harness.render()
  await ticks()
  assert.deepEqual(harness.calls, [levelLine('hard', `${HAIKU} effort=low,${FLASH} effort=high`)])
  assert.equal(cellButton(harness.render()).props['aria-busy'], true, 'saving until the session confirms it')
  assert.equal(effortSpan(harness.output()), '· low', 'the cell shows the draft while it is saved')
  harness.render({ view: manualView({ hard: [{ ...haiku, effort: 'low' }, { ...selected[0], effort: 'high' }] }) })
  assert.equal(cellButton(harness.render()).props['aria-busy'], false)
  await ticks()
  assert.equal(harness.calls.length, 1)
})

test('Inherit sends inherit without efforts; unchecking a model drops its effort; a re-check after Inherit restores it', async () => {
  const saved = manualView({ hard: [{ ...haiku, effort: 'xhigh' }, { ...selected[0], effort: 'low' }] })
  const inherit = cellHarness({ view: saved })
  pickInherit(inherit.open())
  const output = inherit.render()
  assert.equal(effortGroupOf(output, HAIKU).props.hidden, true)
  assert.equal(effortGroupOf(output, FLASH).props.hidden, true)
  inherit.close()
  await ticks()
  assert.deepEqual(inherit.calls, [levelLine('hard', 'inherit')])
  const drop = cellHarness({ view: saved })
  pick(drop.open(), HAIKU)
  drop.close()
  await ticks()
  assert.deepEqual(drop.calls, [levelLine('hard', `${FLASH} effort=low`)])
  const back = cellHarness({ view: saved })
  pickInherit(back.open())
  pick(back.render(), HAIKU)
  assert.equal(effortSummary(back.render(), HAIKU).find((line) => line.endsWith('=true')), 'Extra high (recommended)=true')
  back.close()
  await ticks()
  assert.deepEqual(back.calls, [levelLine('hard', `${HAIKU} effort=xhigh`)])
})

test('unknown efforts show Default plus a saved id unmarked; an id a listed model does not advertise is appended with a warning', () => {
  const unknown = cellHarness({ view: manualView({ hard: [{ ...haiku, effort: 'turbo' }] }), getService: () => undefined })
  let output = unknown.open()
  assert.deepEqual(effortSummary(output, HAIKU), ['Default=false', 'turbo=true'])
  assert.deepEqual(effortSummary(output, FLASH), ['Default=false'])
  assert.deepEqual(effortSummary(output, CODEX), ['Default=false'])
  const listed = cellHarness({ view: manualView({ hard: [{ ...haiku, effort: 'turbo' }, { ...selected[1], effort: 'high' }] }) })
  output = listed.open()
  assert.deepEqual(effortSummary(output, HAIKU), ['Default (Medium)=false', 'Low=false', 'Medium=false', 'High=false', 'Extra high (recommended)=false', 'Max=false', 'turbo [warning]=true'])
  assert.deepEqual(effortSummary(output, CODEX), ['Default=false', 'high [warning]=true'], 'a saved effort on a model without efforts can still be cleared')
  const warned = effortRowsOf(output, HAIKU).at(-1)
  assert.equal(warned.props.title, 'turbo')
  assert.equal(warned.type(warned.props).props['data-warning'], '')
  // Ids a command cannot carry, and repeats, are skipped; a missing name shows the id.
  const messy = cellHarness({
    view: manualView({ hard: [haiku] }),
    getService: directoryService(fakeDirectory(haikuCatalog({
      efforts: [{ id: 'low', name: '' }, { id: '' }, { id: 'two words', name: 'Spaced' }, { id: 7 }, null, { id: 'a,b', name: 'Comma' },
        { id: 'high', name: 'High' }, { id: 'high', name: 'Again' }, { id: 'max' }],
      defaultEffort: 'high',
    }))),
  })
  assert.deepEqual(effortSummary(messy.open(), HAIKU), ['Default (High)=true', 'low=false', 'High (recommended)=false', 'max=false'])
})

test('the Default effort row names the model\'s real default only when the directory advertises it', () => {
  const label = (reasoning) => {
    const harness = cellHarness({ view: manualView({ hard: [haiku] }), getService: directoryService(fakeDirectory(haikuCatalog(reasoning))) })
    return effortRowsOf(harness.open(), HAIKU)[0].props.label
  }
  assert.equal(label({ efforts: efforts('low', 'high'), defaultEffort: 'high' }), 'Default (High)')
  assert.equal(label({ efforts: [{ id: 'low' }, { id: 'high', name: ' ' }], defaultEffort: 'high' }), 'Default (high)', 'the id when the name is missing')
  for (const reasoning of [
    { efforts: efforts('low', 'high') },
    { efforts: efforts('low', 'high'), defaultEffort: 'medium' },
    { efforts: efforts('low', 'high'), defaultEffort: '' },
    { efforts: efforts('low', 'high'), defaultEffort: 3 },
    { efforts: [{ id: 'two words' }, { id: 'high' }], defaultEffort: 'two words' },
  ]) assert.equal(label(reasoning), 'Default', JSON.stringify(reasoning))
})

test('effort rows are disabled while the menu is locked and send nothing', async () => {
  const harness = cellHarness({ view: manualView({ hard: [haiku] }), extra: { locked: true } })
  let output = harness.open()
  assert.equal(allEffortRows(output).length, HAIKU_EFFORTS.length + 4)
  assert.equal(allEffortRows(output).every((row) => row.props.disabled === true), true)
  const row = effortRowsOf(output, HAIKU)[5]
  assert.equal(row.type(row.props).props['aria-disabled'], 'true')
  pickEffort(output, HAIKU, 'Max')
  output = harness.render()
  assert.equal(effortSummary(output, HAIKU)[0], 'Default (Medium)=true', 'a disabled effort row does not change the draft')
  harness.close()
  await ticks()
  assert.deepEqual(harness.calls, [])
})

test('an effort group about to be hidden while it holds focus hands focus to its model row first', () => {
  const doc = { activeElement: null, addEventListener() {}, removeEventListener() {} }
  const harness = cellHarness({ view: manualView({ hard: [haiku] }), globals: { document: doc } })
  let output = harness.open()
  // The elements React attaches to the model row and to its effort group.
  const modelRow = { focus() { doc.activeElement = this } }
  const row = {}
  rowFor(output, HAIKU).props.elementRef(modelRow)
  effortGroupOf(output, HAIKU).props.ref({ contains: (element) => element === row })
  doc.activeElement = row
  // Another tab resets the level while an effort row of this flyout has focus.
  output = harness.render({ view: manualView({}) })
  assert.equal(effortGroupOf(output, HAIKU).props.hidden, false, 'kept while it holds focus')
  assert.equal(doc.activeElement, modelRow, 'focus moved to the model row first')
  output = harness.render()
  assert.equal(effortGroupOf(output, HAIKU).props.hidden, true, 'then hidden')
  assert.equal(harness.cell.instance.dirty, false, 'and nothing more to do')
  // Unchecking from the model row itself hides the effort rows at once.
  pick(output, FLASH)
  output = harness.render()
  rowFor(output, FLASH).props.elementRef({ focus() { doc.activeElement = this } })
  effortGroupOf(output, FLASH).props.ref({ contains: () => false })
  doc.activeElement = { name: 'the FLASH model row' }
  pick(output, FLASH)
  output = harness.render()
  assert.equal(effortGroupOf(output, FLASH).props.hidden, true)
  // A model row that cannot take focus does not keep its effort rows shown: they hide on the next render.
  const stuck = cellHarness({ view: manualView({ hard: [haiku] }), globals: { document: doc } })
  output = stuck.open()
  const stuckChip = {}
  effortGroupOf(output, HAIKU).props.ref({ contains: (element) => element === stuckChip })
  doc.activeElement = stuckChip
  output = stuck.render({ view: manualView({}) })
  assert.equal(effortGroupOf(output, HAIKU).props.hidden, false)
  output = stuck.render()
  assert.equal(effortGroupOf(output, HAIKU).props.hidden, true, 'no loop')
  assert.equal(stuck.cell.instance.dirty, false)
})

test('the arrow keys move through model rows and the effort rows of checked models; Escape, Tab and ArrowLeft close from an effort row', () => {
  const doc = { activeElement: null, addEventListener() {}, removeEventListener() {} }
  const harness = cellHarness({ view: manualView({ hard: [haiku] }), globals: { document: doc } })
  const flyout = find(harness.open(), (node) => typeof node.type === 'function' && node.props?.cellRef)
  // The rows as the browser lays them out, in document order, each knowing
  // whether its effort group is hidden.
  const rows = []
  const walk = (node, context) => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, context)
      return
    }
    if (node === null || typeof node !== 'object') return
    if (typeof node.type === 'function' && typeof node.props?.onSelect === 'function') {
      const button = node.type(node.props).props
      rows.push({
        name: button.role === 'menuitemradio' ? `${context.key}:${node.props.label}` : node.props.title ?? node.props.label,
        attributes: { role: button.role, 'aria-checked': String(button['aria-checked']) },
        closest: (selector) => selector === '[hidden]' && context.hidden ? {} : null,
        focus() { doc.activeElement = this },
      })
      return
    }
    const key = typeof node.props?.key === 'string' && node.props.key.startsWith('efforts:') ? node.props.key.slice('efforts:'.length) : context.key
    for (const child of node.children ?? []) walk(child, { key, hidden: context.hidden || node.props?.hidden === true })
  }
  walk(flyout.children, { key: null, hidden: false })
  assert.deepEqual(rows.map((row) => row.name), [
    'Inherit (session default)',
    FLASH, ...['Default (High)', 'Off', 'Low', 'High'].map((label) => `${FLASH}:${label}`),
    CODEX,
    HAIKU, ...HAIKU_EFFORTS.map((label) => `${HAIKU}:${label}`),
  ])
  const matches = (row, selector) => selector.split(',').some((part) => {
    const wanted = [...part.matchAll(/\[([a-z-]+)="([^"]*)"\]/g)]
    return wanted.length > 0 && wanted.every(([, name, value]) => row.attributes[name] === value)
  })
  const surface = {
    style: { setProperty() {} },
    offsetHeight: 200,
    contains: (element) => rows.includes(element),
    querySelector: (selector) => rows.find((row) => matches(row, selector)) ?? null,
    querySelectorAll: (selector) => rows.filter((row) => matches(row, selector)),
  }
  const cell = { focus() { doc.activeElement = this } }
  flyout.props.cellRef.current = cell
  const instance = harness.env.runtime.mount(flyout.type)
  instance.instance.hooks[0] = { current: surface } // the flyout element ref
  const menu = instance.render(flyout.props)
  assert.equal(doc.activeElement.name, HAIKU, 'the checked model row takes the first focus')
  const press = (key) => {
    let prevented = false
    menu.props.onKeyDown({ key, nativeEvent: {}, preventDefault() { prevented = true }, stopPropagation() {} })
    assert.equal(prevented, true, key)
    return doc.activeElement === cell ? 'cell' : doc.activeElement.name
  }
  assert.equal(press('ArrowDown'), `${HAIKU}:Default (Medium)`, 'from the model row into its effort rows')
  assert.equal(press('ArrowDown'), `${HAIKU}:Low`)
  assert.equal(press('End'), `${HAIKU}:Max`)
  assert.equal(press('ArrowDown'), 'Inherit (session default)', 'and wraps around')
  assert.equal(press('ArrowDown'), FLASH)
  assert.equal(press('ArrowDown'), CODEX, 'the effort rows of an unchecked model are skipped')
  assert.equal(press('ArrowUp'), FLASH)
  assert.equal(press('Home'), 'Inherit (session default)')
  assert.equal(press('ArrowUp'), `${HAIKU}:Max`)
  for (const key of ['Escape', 'Tab', 'ArrowLeft']) {
    doc.activeElement = rows.find((row) => row.name === `${HAIKU}:Low`)
    harness.menu.parent.instance.dirty = false
    assert.equal(press(key), 'cell', `${key} returns focus to the cell`)
    assert.equal(harness.menu.parent.instance.dirty, true, `${key} closes the flyout`)
  }
})

test('the cell shows the first model with its effort in a non-shrinking span and +N, and its title lists every entry', () => {
  const env = load()
  const view = manualView({
    hard: [{ ...haiku, effort: 'xhigh' }, selected[0]],
    mechanical: [selected[0], { ...haiku, effort: 'low' }],
    ordinary: [{ ...haiku, effort: 'max' }],
  })
  const { output, cells } = levels(env, view, routes)
  const style = find(output, (node) => node.type === 'style').children.join('')
  assert.match(style, /\.router-cell-effort\{flex:0 0 auto;white-space:nowrap;/, 'the effort never shrinks; the model name truncates first')
  assert.match(style, /\.router-cell-more\{flex:0 0 auto;white-space:nowrap;/)
  const hard = mountCell(env, cells[2]).output
  const button = cellButton(hard)
  assert.deepEqual(button.children.filter(Boolean).map((node) => node.props.className),
    ['router-cell-label', 'router-cell-value', 'router-cell-effort', 'router-cell-more', 'router-chevron'])
  assert.equal(valueSpan(hard), 'claude-haiku-5-5')
  assert.equal(effortSpan(hard), '· xhigh')
  assert.equal(moreSpan(hard), '+1')
  assert.equal(button.props['aria-label'], 'Hard judgment: claude-haiku-5-5, effort xhigh, 1 more')
  assert.equal(button.props.title, 'Verification, or ambiguous work that is costly to undo.\nanthropic/claude-haiku-5-5 effort=xhigh, openrouter/~deepseek/deepseek-flash-latest')
  const mechanical = mountCell(env, cells[0]).output
  assert.equal(effortSpan(mechanical), undefined, 'the first model runs at its default')
  assert.equal(moreSpan(mechanical), '+1')
  assert.equal(cellButton(mechanical).props['aria-label'], 'Mechanical: ~deepseek/deepseek-flash-latest, 1 more')
  assert.equal(cellButton(mechanical).props.title, 'Fully specified, no judgment, checkable result.\nopenrouter/~deepseek/deepseek-flash-latest, anthropic/claude-haiku-5-5 effort=low')
  const ordinary = mountCell(env, cells[1]).output
  assert.equal(effortSpan(ordinary), '· max')
  assert.equal(moreSpan(ordinary), undefined)
  assert.equal(cellButton(ordinary).props['aria-label'], 'Ordinary: claude-haiku-5-5, effort max')
  const inherit = mountCell(env, levels(env, manualView({}), routes).cells[1]).output
  assert.equal(valueSpan(inherit), 'Inherit')
  assert.equal(effortSpan(inherit), undefined)
  assert.equal(cellButton(inherit).props.title, 'The default level for subagent work.\nInherit (session default)')
})

test('a revert to the saved value while an earlier commit was in flight sends no redundant line on unmount', async () => {
  const harness = cellHarness({ view: manualView({ hard: [haiku] }), execute: 'deferred' })
  pickEffort(harness.open(), HAIKU, 'High')
  harness.close()
  await ticks()
  assert.deepEqual(harness.calls, [levelLine('hard', `${HAIKU} effort=high`)])
  // The user reopens and picks Default again, the saved value, while that commit runs.
  pickEffort(harness.open(), HAIKU, 'Default (Medium)')
  harness.render()
  // The commit in flight fails, and the host menu closes before the cell renders again.
  harness.resolveWith[0]({ kind: 'error', text: 'unknown or malformed command: x' })
  await ticks()
  harness.cell.unmount()
  harness.menu.parent.unmount()
  await ticks()
  assert.deepEqual(harness.calls, [levelLine('hard', `${HAIKU} effort=high`)], 'the session shows the draft and nothing is in flight')
  assert.deepEqual(harness.reports, ['unknown or malformed command: x'])
})

test('an effort changed back while its commit is in flight is still committed when the host menu closes', async () => {
  const harness = cellHarness({ view: manualView({ hard: [haiku] }), execute: 'deferred' })
  pickEffort(harness.open(), HAIKU, 'High')
  harness.close()
  await ticks()
  assert.deepEqual(harness.calls, [levelLine('hard', `${HAIKU} effort=high`)])
  // While it runs, the user picks Default (the session's value) and the menu closes.
  pickEffort(harness.open(), HAIKU, 'Default (Medium)')
  harness.render()
  harness.cell.unmount()
  await ticks()
  assert.equal(harness.calls.length, 1, 'the commit on unmount waits for the one in flight')
  harness.settle[0]()
  await ticks()
  assert.deepEqual(harness.calls, [levelLine('hard', `${HAIKU} effort=high`), levelLine('hard', HAIKU)])
})

test('an effort-only edit sends the whole level and drops unavailable entries with their efforts', async () => {
  const gone = { provider: 'gone', model: 'retired', effort: 'max' }
  const harness = cellHarness({ view: manualView({ hard: [{ ...haiku, effort: 'low' }, gone] }) })
  let output = harness.open()
  assert.match(text(output), /Unavailable — removed on next change/)
  assert.equal(effortGroupOf(output, 'gone/retired'), undefined, 'an unavailable entry has no effort group')
  assert.equal(rowFor(output, 'gone/retired').props.checked, true)
  harness.close()
  await ticks()
  assert.deepEqual(harness.calls, [], 'nothing is sent without an edit')
  pickEffort(harness.open(), HAIKU, 'High')
  output = harness.render()
  assert.equal(rowFor(output, 'gone/retired').props.checked, false, 'dropped by the change, still listed')
  harness.close()
  await ticks()
  assert.deepEqual(harness.calls, [levelLine('hard', `${HAIKU} effort=high`)])
})

test('an effort row draft waiting behind the switch commits with its efforts when the switch settles', async () => {
  const harness = cellHarness({ view: manualView({ hard: [haiku] }), execute: 'deferred' })
  pressSwitch(harness.env, false, { sessionId: SESSION })
  await ticks()
  pickEffort(harness.open(), HAIKU, 'Low')
  harness.close()
  await ticks()
  assert.deepEqual(harness.calls, ['/router off'], 'the draft waits while the switch holds the lock')
  harness.settle[0]()
  await ticks()
  assert.equal(flush(harness.menu, harness.cell, 'hard'), true)
  await ticks()
  assert.deepEqual(harness.calls, ['/router off', levelLine('hard', `${HAIKU} effort=low`)])
})

test('an effort row commit the session never confirms snaps back the entries and their efforts after the deadline, with one report', async () => {
  const harness = cellHarness({ view: manualView({ hard: [haiku] }) })
  pick(harness.open(), FLASH)
  pickEffort(harness.render(), HAIKU, 'Max')
  harness.close()
  await ticks()
  assert.deepEqual(harness.calls, [levelLine('hard', `${HAIKU} effort=max,${FLASH} effort=high`)])
  harness.env.clock.offset += 29_000
  let output = harness.render()
  assert.equal(cellButton(output).props['aria-busy'], true)
  assert.equal(effortSpan(output), '· max')
  harness.env.clock.offset += 2_000
  harness.render()
  output = harness.render()
  assert.equal(cellButton(output).props['aria-busy'], false)
  assert.equal(valueSpan(output), 'claude-haiku-5-5', 'the entries snapped back')
  assert.equal(effortSpan(output), undefined, 'and their efforts too')
  assert.equal(moreSpan(output), undefined)
  assert.deepEqual(harness.reports, [FAILED])
  output = harness.open()
  assert.equal(effortSummary(output, HAIKU)[0], 'Default (Medium)=true')
  assert.equal(rowFor(output, FLASH).props.checked, false)
  assert.equal(harness.reports.length, 1)
  assert.equal(harness.calls.length, 1, 'the draft is not sent again')
})

test('a rejection recorded in the projection snaps back the entries and their efforts', async () => {
  const harness = cellHarness({ view: manualView({ hard: [haiku] }) })
  pick(harness.open(), FLASH)
  pickEffort(harness.render(), HAIKU, 'Low')
  harness.close()
  await ticks()
  const failure = { count: 1, text: 'Route x is not authorized for this session.', target: 'level', level: 'hard' }
  harness.render({ view: manualView({ hard: [haiku] }, { failure }) })
  const output = harness.render()
  assert.deepEqual(harness.reports, [failure.text])
  assert.equal(valueSpan(output), 'claude-haiku-5-5')
  assert.equal(effortSpan(output), undefined)
})

test('a rejected effort row commit snaps back without discarding a newer effort row pick', async () => {
  const harness = cellHarness({ view: manualView({ hard: [haiku] }), execute: 'deferred' })
  pickEffort(harness.open(), HAIKU, 'High')
  harness.close()
  await ticks()
  assert.deepEqual(harness.calls, [levelLine('hard', `${HAIKU} effort=high`)])
  pickEffort(harness.open(), HAIKU, 'Low')
  harness.render()
  harness.resolveWith[0]({ kind: 'error', text: 'unknown or malformed command: x' })
  await ticks()
  assert.deepEqual(harness.reports, ['unknown or malformed command: x'])
  assert.equal(effortSummary(harness.render(), HAIKU)[1], 'Low=true', 'the newer pick survives the failed commit')
  harness.close()
  await ticks()
  assert.deepEqual(harness.calls, [levelLine('hard', `${HAIKU} effort=high`), levelLine('hard', `${HAIKU} effort=low`)])
})

test('an effort row draft left open when the host menu closes is committed once on unmount', async () => {
  const harness = cellHarness({ view: manualView({ hard: [haiku], mechanical: [haiku] }) })
  pickEffort(harness.open(), HAIKU, 'Max')
  harness.render()
  harness.cell.unmount()
  await ticks()
  assert.deepEqual(harness.calls, [levelLine('hard', `${HAIKU} effort=max`)])
  // Closing the flyout and then the menu before a re-render also sends once.
  const mechanical = harness.menu.cells[0]
  const closing = harness.env.runtime.mount(mechanical.type)
  pickEffort(closing.render({ ...mechanical.props, open: true }), HAIKU, 'Low')
  closing.render({ ...mechanical.props, open: false })
  closing.unmount()
  await ticks()
  assert.deepEqual(harness.calls, [levelLine('hard', `${HAIKU} effort=max`), levelLine('mechanical', `${HAIKU} effort=low`)])
})

test('a model checked while an effort row commit runs is sent with the whole level once that commit lands', async () => {
  const harness = cellHarness({ view: manualView({ hard: [haiku] }), execute: 'deferred' })
  pickEffort(harness.open(), HAIKU, 'High')
  harness.close()
  await ticks()
  let output = harness.open()
  assert.equal(effortSummary(output, HAIKU)[3], 'High=true', 'the reopened flyout shows the commit in flight')
  pick(output, FLASH)
  output = harness.render()
  assert.equal(effortSummary(output, HAIKU)[3], 'High=true', 'checking a model keeps the other entries\' efforts')
  harness.close()
  await ticks()
  assert.equal(harness.calls.length, 1, 'the new draft waits for the commit in flight')
  harness.settle[0]()
  await ticks()
  harness.render({ view: manualView({ hard: [{ ...haiku, effort: 'high' }] }) })
  await ticks()
  harness.render()
  await ticks()
  assert.deepEqual(harness.calls, [levelLine('hard', `${HAIKU} effort=high`), levelLine('hard', `${HAIKU} effort=high,${FLASH} effort=high`)])
})

test('locale: the effort strings are in both tables with their literal wording and render localized', () => {
  let tables
  const locale = {
    register(name, value) { assert.equal(name, 'router'); tables = value },
    bind: () => (key) => tables.zh[key] ?? key,
  }
  const harness = cellHarness({ view: manualView({ hard: [{ ...haiku, effort: 'xhigh' }] }), locale })
  assert.deepEqual(Object.keys(tables.zh).sort(), Object.keys(tables.en).sort(), 'both tables carry the same keys')
  // Literal expected wording, never one table compared with the other.
  const expected = {
    en: {
      'effort.labelFor': 'Effort for %MODEL%', 'effort.default': 'Default', 'effort.defaultNamed': 'Default (%EFFORT%)',
      'effort.recommended': 'recommended', 'effort.cell': 'effort %EFFORT%',
    },
    zh: {
      'effort.labelFor': '%MODEL% 的推理等级', 'effort.default': 'Default', 'effort.defaultNamed': 'Default（%EFFORT%）',
      'effort.recommended': '推荐', 'effort.cell': '推理等级 %EFFORT%',
    },
  }
  for (const lang of ['en', 'zh']) {
    for (const [key, value] of Object.entries(expected[lang])) assert.equal(tables[lang][key], value, `${lang} ${key}`)
    assert.deepEqual(Object.keys(tables[lang]).filter((key) => key.startsWith('effort.')).sort(), Object.keys(expected[lang]).sort(), `${lang}: no ordinal strings remain`)
  }
  const output = harness.open()
  assert.equal(effortGroupOf(output, HAIKU).props['aria-label'], 'claude-haiku-5-5 的推理等级')
  assert.deepEqual(effortSummary(output, HAIKU), ['Default（Medium）=false', 'Low=false', 'Medium=false', 'High=false', 'Extra high (推荐)=true', 'Max=false'])
  assert.equal(cellButton(output).props['aria-label'], '高难度判断: claude-haiku-5-5, 推理等级 xhigh')
  assert.equal(effortSpan(output), '· xhigh', 'the id, as typed in commands')
})

test('the level menu and its cells call the same hooks in the same order on every render path, and subscribe once', () => {
  const directory = fakeDirectory([])
  const torn = { getSnapshot() { throw new Error('torn down') }, subscribe() { throw new Error('torn down') } }
  let mode = 'directory'
  const getService = (name) => {
    if (name !== 'modelDirectories') return undefined
    if (mode === 'ctx.get throws') throw new Error('no such service')
    if (mode === 'store throws') return { directoryFor: () => ({ store: torn }) }
    return directory.service
  }
  const env = load({ getService })
  const state = { view: manualView({ hard: [haiku] }) }
  const wrapper = env.registrations[1].component({ sessionId: SESSION, useProjection: (key) => key === 'router' ? state.view : routes })
  const parent = env.runtime.mount(wrapper.type)
  let output = parent.render(wrapper.props)
  const menuTrace = parent.instance.trace.join(',')
  assert.equal(menuTrace, 'state,state,effect,effect,state,effect', 'open level, lock tick, wake, reset, then the directory version and its subscription')
  assert.equal(directory.listeners.size, 1, 'subscribed while the directory is still loading')
  const element = findAll(output, (node) => node.props?.level === 'hard')[0]
  const cell = env.runtime.mount(element.type)
  cell.render({ ...element.props, open: false })
  const cellTrace = cell.instance.trace.join(',')
  const check = (name) => {
    output = parent.render()
    assert.equal(parent.instance.trace.join(','), menuTrace, `menu: ${name}`)
    const fresh = findAll(output, (node) => node.props?.level === 'hard')[0]
    for (const open of [false, true, true, false]) {
      cell.render({ ...fresh.props, open })
      assert.equal(cell.instance.trace.join(','), cellTrace, `cell: ${name}, ${open ? 'open' : 'closed'}`)
    }
  }
  check('loading')
  directory.publish(CATALOG)
  assert.equal(parent.instance.dirty, true, 'the directory update re-renders the menu')
  check('loaded')
  mode = 'store throws'
  check('store throws')
  mode = 'ctx.get throws'
  check('ctx.get throws')
  mode = 'directory'
  state.view = undefined
  assert.equal(parent.render(), null)
  assert.equal(parent.instance.trace.join(','), menuTrace, 'a missing view returns only after every hook')
  state.view = manualView({ hard: [haiku] })
  check('view back')
  assert.equal(directory.listeners.size, 1, 'one subscription across renders')
  assert.equal(directory.sessions.every((id) => id === SESSION), true)
  parent.unmount()
  assert.equal(directory.listeners.size, 0, 'unsubscribed on unmount')
})

test('the client injects only slots and reads the model directory lazily, only with a session id', () => {
  const asked = []
  const directory = fakeDirectory()
  const env = load({ getService: (name) => { asked.push(name); return name === 'modelDirectories' ? directory.service : undefined } })
  assert.deepEqual(asked, [], 'nothing is read while the client loads')
  const unnamed = levels(env, manualView({ hard: [haiku] }), routes)
  const unnamedOutput = mountCell(env, { ...unnamed.cells[2], props: { ...unnamed.cells[2].props, open: true } }).output
  assert.deepEqual(asked, [], 'never asks for a directory without a session id')
  assert.deepEqual(effortSummary(unnamedOutput, HAIKU), ['Default=true'])
  const named = levels(env, manualView({ hard: [haiku] }), routes, { sessionId: SESSION })
  const output = mountCell(env, { ...named.cells[2], props: { ...named.cells[2].props, open: true } }).output
  assert.equal(asked.every((name) => name === 'modelDirectories'), true)
  assert.ok(asked.length > 0)
  assert.equal(directory.sessions.every((id) => id === SESSION), true)
  assert.equal(effortSummary(output, HAIKU)[0], 'Default (Medium)=true')
})

test('a saved model unchecked in an earlier opening and checked again gets its saved effort, not the recommendation', async () => {
  const harness = cellHarness({ view: manualView({ hard: [{ ...haiku, effort: 'max' }] }), execute: 'deferred' })
  pick(harness.open(), HAIKU)
  harness.close()
  await ticks()
  assert.deepEqual(harness.calls, [levelLine('hard', 'inherit')])
  // A new opening, while that commit runs: the draft still leaves the saved model out.
  let output = harness.open()
  assert.equal(rowFor(output, HAIKU).props.checked, false)
  pick(output, HAIKU)
  output = harness.render()
  assert.equal(effortSummary(output, HAIKU)[5], 'Max=true', 'the saved effort, not Extra high')
  harness.close()
  await ticks()
  harness.settle[0]()
  await ticks()
  harness.render({ view: manualView({ hard: null }) })
  await ticks()
  harness.render()
  await ticks()
  assert.deepEqual(harness.calls, [levelLine('hard', 'inherit'), levelLine('hard', `${HAIKU} effort=max`)])
})

test('Inherit remembers the shown efforts: a re-check in the same opening restores the pick, not the saved effort or the recommendation', async () => {
  const harness = cellHarness({ view: manualView({ hard: [{ ...haiku, effort: 'xhigh' }] }) })
  pickEffort(harness.open(), HAIKU, 'Low')
  pickInherit(harness.render())
  assert.equal(effortGroupOf(harness.render(), HAIKU).props.hidden, true)
  pick(harness.output(), HAIKU)
  const output = harness.render()
  assert.deepEqual(effortSummary(output, HAIKU).filter((line) => line.endsWith('=true')), ['Low=true'],
    'the pick made before Inherit, not the saved Extra high that is also the recommendation')
  harness.close()
  await ticks()
  assert.deepEqual(harness.calls, [levelLine('hard', `${HAIKU} effort=low`)])
})

test('a draft equal to the commit still in flight is not sent again on unmount', async () => {
  const harness = cellHarness({ view: manualView({ hard: [{ ...haiku, effort: 'low' }] }), execute: 'deferred' })
  pickEffort(harness.open(), HAIKU, 'Max')
  harness.close()
  await ticks()
  assert.deepEqual(harness.calls, [levelLine('hard', `${HAIKU} effort=max`)])
  // While it runs, the user reopens, picks High and then Max again, and the menu closes.
  pickEffort(harness.open(), HAIKU, 'High')
  pickEffort(harness.render(), HAIKU, 'Max')
  harness.render()
  harness.cell.unmount()
  await ticks()
  harness.settle[0]()
  await ticks()
  assert.deepEqual(harness.calls, [levelLine('hard', `${HAIKU} effort=max`)], 'exactly one effort=max line')
})

test('a directory change between the render and the subscription still refreshes the menu, once', () => {
  const listeners = new Set()
  const loaded = { groups: CATALOG }
  let snapshot = { groups: [] }
  let subscriptions = 0
  const store = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      subscriptions++
      // The catalog lands after the render read the snapshot and before this
      // subscription, so no listener hears of it.
      snapshot = loaded
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  const serviceOf = (directoryStore) => (name) => name === 'modelDirectories' ? { directoryFor: () => ({ store: directoryStore }) } : undefined
  const env = load({ getService: serviceOf(store) })
  const menu = levels(env, manualView({ hard: [haiku] }), routes, { sessionId: SESSION })
  assert.equal(subscriptions, 1)
  assert.equal(listeners.size, 1)
  assert.equal(menu.parent.instance.dirty, true, 'the subscription notices the change it missed and asks for a render')
  const output = menu.parent.render()
  assert.equal(menu.parent.instance.dirty, false, 'the refreshed render asks for nothing more')
  assert.equal(subscriptions, 1, 'the same store keeps its one subscription')
  const cell = cellIn(output, 'hard')
  assert.equal(effortSummary(env.runtime.mount(cell.type).render({ ...cell.props, open: true }), HAIKU)[0], 'Default (Medium)=true')
  // A store that does not change meanwhile asks for no render.
  const steady = { getSnapshot: () => loaded, subscribe: () => () => {} }
  const quiet = levels(load({ getService: serviceOf(steady) }), manualView({}), routes, { sessionId: SESSION })
  assert.equal(quiet.parent.instance.dirty, false)
})

test('an unadvertised effort saved by another tab while the flyout is open shows in the cell, and gets an effort row at the next opening', () => {
  const harness = cellHarness({ view: manualView({ hard: [{ ...haiku, effort: 'low' }] }) })
  let output = harness.open()
  const count = allEffortRows(output).length
  output = harness.render({ view: manualView({ hard: [{ ...haiku, effort: 'turbo' }] }) })
  assert.equal(effortSpan(output), '· turbo', 'the cell shows the saved effort')
  assert.deepEqual(effortSummary(output, HAIKU).filter((line) => line.endsWith('=true')), [], 'no effort row is checked while open')
  assert.equal(allEffortRows(output).length, count, 'and no effort row is added')
  harness.close()
  assert.deepEqual(effortSummary(harness.open(), HAIKU).slice(-2), ['Max=false', 'turbo [warning]=true'])
})

// 11. The recommended effort, applied once and automatically to a saved level
// whose entries lack an effort (today only Hard judgment recommends one): one
// whole-level command through the draft path, guarded by one localStorage
// key per session and level.
const markerKey = (level, session = SESSION) => `dsh.autoEffort.v1:router:${session}:${level}`
const MARKER = markerKey('hard')
const AUTO_LINE = levelLine('hard', `${HAIKU} effort=xhigh`)
const SECURITY_ERROR = "Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('SecurityError') }, configurable: true })"

// A localStorage stand-in: its items, and every call in order.
function fakeStorage(initial = {}) {
  const items = new Map(Object.entries(initial))
  const log = []
  return {
    items,
    log,
    getItem(key) { log.push(`get ${key}`); return items.has(key) ? items.get(key) : null },
    setItem(key, value) { log.push(`set ${key}=${value}`); items.set(key, String(value)) },
    removeItem(key) { log.push(`remove ${key}`); items.delete(key) },
  }
}

// A cell of SESSION (Hard judgment saved as Haiku without an effort, unless
// given) with that storage; other options as cellHarness.
function autoHarness({ storage = fakeStorage(), view = manualView({ hard: [haiku] }), globals = {}, ...options } = {}) {
  return { ...cellHarness({ view, globals: { localStorage: storage, ...globals }, ...options }), storage }
}

// The render that a draft set by an effect asks for, then the call it starts.
async function settleRender(harness, changes) {
  harness.render(changes)
  await ticks()
  return harness.calls
}

test('automatic effort: a saved Hard judgment entry without an effort gets its recommendation once, as one whole-level command sent after the marker is written', async () => {
  assert.equal(MARKER, 'dsh.autoEffort.v1:router:session-1:hard', 'one key per session and level')
  const storage = fakeStorage()
  const harness = autoHarness({ storage })
  // The first render claimed the marker and made the draft: no call yet, and no timer.
  assert.deepEqual(storage.log, [`get ${MARKER}`, `set ${MARKER}=auto`, `get ${MARKER}`])
  assert.equal(harness.cell.instance.dirty, true, 'the draft asks for a render')
  await ticks()
  assert.deepEqual(harness.calls, [])
  const markerAtSend = []
  const execute = harness.env.harness.commandUi.execute
  harness.env.harness.commandUi = { execute: (target, line) => { markerAtSend.push(storage.items.get(MARKER)); return execute(target, line) } }
  const output = harness.render()
  assert.equal(effortSpan(output), '· xhigh', 'the cell shows the effort it is saving')
  assert.equal(cellButton(output).props['aria-busy'], true)
  await ticks()
  assert.deepEqual(harness.calls, [AUTO_LINE])
  assert.deepEqual(markerAtSend, ['auto'], 'the marker is in storage when the command is sent')
  // Nothing but the command entry and the cell's effort: no toast, caption, or switch.
  assert.deepEqual(harness.reports, [])
  assert.deepEqual(cellButton(output).children.filter(Boolean).map((node) => node.props.className),
    ['router-cell-label', 'router-cell-value', 'router-cell-effort', 'router-chevron'])
  assert.equal(findAll(output, (node) => ['status', 'alert', 'switch'].includes(node.props?.role)).length, 0)
  // The session confirms it; the cell settles and sends nothing more.
  harness.render({ view: manualView({ hard: [{ ...haiku, effort: 'xhigh' }] }) })
  const settled = harness.render()
  assert.equal(cellButton(settled).props['aria-busy'], false)
  assert.equal(effortSpan(settled), '· xhigh')
  for (let index = 0; index < 3; index++) harness.render()
  await ticks()
  assert.deepEqual(harness.calls, [AUTO_LINE])
  assert.deepEqual([...storage.items.keys()], [MARKER])
})

test('automatic effort: the line keeps the saved order and efforts, adds the recommendation only where a model has one, and uses one key per session and level', async () => {
  const storage = fakeStorage()
  const harness = autoHarness({ storage, view: manualView({ hard: [selected[0], { ...haiku, effort: 'low' }, selected[1]] }) })
  assert.deepEqual(await settleRender(harness), [levelLine('hard', `${FLASH} effort=high,${HAIKU} effort=low,${CODEX}`)],
    'Flash gets high, Haiku keeps low, Codex (listed without efforts) keeps Default')
  const both = fakeStorage()
  assert.deepEqual(await settleRender(autoHarness({ storage: both, view: manualView({ hard: [haiku, selected[0]] }) })),
    [levelLine('hard', `${HAIKU} effort=xhigh,${FLASH} effort=high`)])
  assert.deepEqual([...both.items.keys()], [MARKER], 'one key for the level, never one per model')
  // A model whose only efforts are off and max gets nothing; the others still get theirs.
  const catalog = [
    { id: 'openrouter', models: [{ id: '~deepseek/deepseek-flash-latest', reasoning: { efforts: efforts('off', 'max'), defaultEffort: 'max' } }] },
    { id: 'anthropic', models: [{ id: 'claude-haiku-5-5', reasoning: { efforts: efforts('low', 'high') } }] },
  ]
  const mixed = autoHarness({ view: manualView({ hard: [selected[0], haiku] }), getService: directoryService(fakeDirectory(catalog)) })
  assert.deepEqual(await settleRender(mixed), [levelLine('hard', `${FLASH},${HAIKU} effort=high`)])
  // The keys of another level or another session do not count; another session has a key of its own.
  const others = fakeStorage({ [markerKey('mechanical')]: 'user', [markerKey('hard', 'session-2')]: 'auto' })
  assert.deepEqual(await settleRender(autoHarness({ storage: others })), [AUTO_LINE])
  const second = fakeStorage()
  assert.deepEqual(await settleRender(autoHarness({ storage: second, extra: { sessionId: 'session-2' } })), [AUTO_LINE])
  assert.deepEqual([...second.items.keys()], ['dsh.autoEffort.v1:router:session-2:hard'])
})

test('automatic effort: Mechanical and Ordinary recommend Default, so they never send and never read or write storage', async () => {
  for (const level of ['mechanical', 'ordinary']) {
    const storage = fakeStorage()
    const harness = autoHarness({ level, storage, view: manualView({ [level]: [haiku, selected[0]] }) })
    assert.equal(harness.cell.instance.dirty, false, level)
    assert.deepEqual(await settleRender(harness), [], level)
    harness.open()
    harness.close()
    await settleRender(harness)
    assert.deepEqual(harness.calls, [], `${level}: opening and closing without a choice sends nothing`)
    assert.deepEqual(storage.log, [], `${level}: storage is never read or written`)
  }
})

test('automatic effort: Inherit, entries that all carry an effort, and a level with an unavailable entry send nothing and leave the marker alone', async () => {
  for (const [name, hard, routeList] of [
    ['Inherit', null, routes],
    ['every entry has an effort', [{ ...haiku, effort: 'low' }, { ...selected[0], effort: 'off' }], routes],
    ['an unavailable entry', [haiku, { provider: 'gone', model: 'retired' }], routes],
    ['an entry no longer authorized that the directory still lists', [haiku, selected[0]], [selected[1], haiku]],
    ['no authorized routes', [haiku], null],
  ]) {
    const storage = fakeStorage()
    const harness = autoHarness({ storage, view: manualView({ hard }), routeList })
    assert.deepEqual(await settleRender(harness), [], name)
    assert.deepEqual(storage.log, [], name)
  }
  // Routes that load after the level, with the level unchanged, make it eligible.
  const late = autoHarness({ routeList: selected })
  assert.deepEqual(await settleRender(late), [], 'Haiku is not authorized yet')
  late.render({ routes })
  assert.deepEqual(await settleRender(late), [AUTO_LINE])
})

test('automatic effort: a render without a view does nothing; the first render with a view sets the saved level it compares with', async () => {
  const storage = fakeStorage()
  const env = load({ getService: directoryService(fakeDirectory()), globals: { localStorage: storage } })
  const calls = recordingExecute(env)
  const menu = levels(env, manualView({ hard: [haiku] }), routes, { sessionId: SESSION })
  const element = menu.cells[2]
  const cell = env.runtime.mount(element.type)
  cell.render({ ...element.props, view: undefined, open: false })
  cell.render()
  await ticks()
  assert.deepEqual([calls, storage.log], [[], []], 'no view: nothing is read, written or sent')
  cell.render({ ...element.props, open: false })
  cell.render()
  await ticks()
  assert.deepEqual(calls, [AUTO_LINE])
})

test('automatic effort: the router off, a locked menu, a pending router command, or the open flyout hold it back with no draft and no marker; it is sent once they clear', async () => {
  const ready = manualView({ hard: [haiku] })
  for (const [name, options, hold, release] of [
    ['the router off', { view: { ...ready, mode: 'off' } }, {}, { view: ready }],
    ['a locked menu', { extra: { locked: true } }, {}, { locked: false }],
    ['a pending router command', { view: manualView({ hard: [haiku] }, { pending: true, pendingTarget: 'level', pendingLevel: 'ordinary', pendingSince: Date.now() }) }, {}, { view: ready }],
    ['the open flyout', { extra: { locked: true } }, { locked: false, open: true }, { open: false }],
  ]) {
    const storage = fakeStorage()
    const harness = autoHarness({ storage, ...options })
    assert.deepEqual(await settleRender(harness, hold), [], `${name}: held back`)
    assert.equal(harness.cell.instance.dirty, false, `${name}: no draft`)
    assert.deepEqual(storage.log, [], `${name}: no marker`)
    harness.render(release)
    assert.deepEqual(await settleRender(harness), [AUTO_LINE], `${name}: sent once it clears`)
    assert.deepEqual(harness.reports, [], name)
  }
})

test('automatic effort: while another command holds the session lock no draft is made; once the lock is free it is sent, after that command', async () => {
  const directory = fakeDirectory([])
  const storage = fakeStorage()
  const harness = autoHarness({ storage, getService: directoryService(directory), execute: 'deferred' })
  // A Mechanical change commits from its own cell and holds the lock.
  const mechanical = harness.env.runtime.mount(harness.menu.cells[0].type)
  pick(mechanical.render({ ...harness.menu.cells[0].props, open: true }), HAIKU)
  mechanical.render({ ...harness.menu.cells[0].props, open: false })
  await ticks()
  assert.deepEqual(harness.calls, [levelLine('mechanical', HAIKU)])
  // The efforts arrive while that command runs.
  directory.publish(CATALOG)
  assert.equal(flush(harness.menu, harness.cell, 'hard'), true)
  harness.render()
  await ticks()
  assert.equal(harness.cell.instance.dirty, false, 'no draft waits behind the lock')
  assert.equal(effortSpan(harness.output()), undefined)
  assert.equal(storage.items.has(MARKER), false, 'the marker is not claimed while the lock is held')
  assert.equal(harness.calls.length, 1)
  harness.settle[0]()
  await ticks()
  assert.equal(flush(harness.menu, harness.cell, 'hard'), true, 'the released lock wakes the cells')
  assert.deepEqual(await settleRender(harness), [levelLine('mechanical', HAIKU), AUTO_LINE])
  assert.equal(storage.items.get(MARKER), 'auto')
  assert.equal(storage.items.get(markerKey('mechanical')), 'user', 'the Mechanical choice wrote its own key')
})

test('automatic effort: a command of another level that has run for 30 s no longer holds it back, as for any draft', async () => {
  const directory = fakeDirectory([])
  const harness = autoHarness({ getService: directoryService(directory), execute: 'deferred' })
  const mechanical = harness.env.runtime.mount(harness.menu.cells[0].type)
  pick(mechanical.render({ ...harness.menu.cells[0].props, open: true }), HAIKU)
  mechanical.render({ ...harness.menu.cells[0].props, open: false })
  await ticks()
  directory.publish(CATALOG)
  harness.render()
  await ticks()
  assert.equal(harness.calls.length, 1, 'held back while that command runs')
  harness.env.clock.offset += 31_000
  harness.render()
  assert.deepEqual(await settleRender(harness), [levelLine('mechanical', HAIKU), AUTO_LINE])
})

test("automatic effort: while an entry's efforts are unknown it waits without writing the marker, and sends once the directory lists them", async () => {
  const directory = fakeDirectory([])
  const storage = fakeStorage()
  const harness = autoHarness({ storage, getService: directoryService(directory) })
  assert.deepEqual(await settleRender(harness), [])
  assert.deepEqual(storage.log, [], 'nothing is written while the efforts are unknown')
  directory.publish(CATALOG)
  assert.equal(flush(harness.menu, harness.cell, 'hard'), true, 'the directory update re-renders the cells')
  assert.deepEqual(await settleRender(harness), [AUTO_LINE])
  directory.publish(CATALOG.slice())
  flush(harness.menu, harness.cell, 'hard')
  await settleRender(harness)
  assert.deepEqual(harness.calls, [AUTO_LINE], 'a later directory update sends nothing more')
  // One entry without an effort that is still unknown holds back the whole level.
  const partial = fakeDirectory(CATALOG.filter((group) => group.id !== 'anthropic'))
  const both = autoHarness({ view: manualView({ hard: [haiku, selected[0]] }), getService: directoryService(partial) })
  assert.deepEqual(await settleRender(both), [], 'Haiku is not listed yet')
  partial.publish(CATALOG)
  flush(both.menu, both.cell, 'hard')
  assert.deepEqual(await settleRender(both), [levelLine('hard', `${HAIKU} effort=xhigh,${FLASH} effort=high`)])
  // An entry that has an effort needs no directory entry.
  const kept = autoHarness({
    view: manualView({ hard: [{ ...haiku, effort: 'low' }, selected[0]] }),
    getService: directoryService(fakeDirectory(CATALOG.filter((group) => group.id !== 'anthropic'))),
  })
  assert.deepEqual(await settleRender(kept), [levelLine('hard', `${HAIKU} effort=low,${FLASH} effort=high`)])
})

test('automatic effort: a model listed without efforts, or only with max or off, gets nothing, and a level left without a recommendation sends nothing', async () => {
  for (const [name, reasoning] of [
    ['listed without efforts', undefined],
    ['an empty list', { efforts: [] }],
    ['only max', { efforts: efforts('max'), defaultEffort: 'max' }],
    ['off and max', { efforts: efforts('off', 'max') }],
    ['only off', { efforts: efforts('off') }],
  ]) {
    const storage = fakeStorage()
    const harness = autoHarness({ storage, getService: directoryService(fakeDirectory(haikuCatalog(reasoning))) })
    assert.deepEqual(await settleRender(harness), [], name)
    assert.deepEqual(storage.log, [], `${name}: the marker is left alone`)
  }
})

test('automatic effort: a saved level that changes after the first render stops the cell for its mount, even when it changes back', async () => {
  const directory = fakeDirectory([])
  const storage = fakeStorage()
  const harness = autoHarness({ storage, getService: directoryService(directory) })
  // Another tab or a typed command changes the level while the menu is open.
  harness.render({ view: manualView({ hard: [selected[0]] }) })
  directory.publish(CATALOG)
  assert.deepEqual(await settleRender(harness), [])
  assert.deepEqual(await settleRender(harness, { view: manualView({ hard: [haiku] }) }), [], 'changing back does not resume it')
  assert.deepEqual(storage.log, [])
  // The next mount takes the level as it is then.
  const next = autoHarness({ storage, view: manualView({ hard: [selected[0]] }) })
  assert.deepEqual(await settleRender(next), [levelLine('hard', `${FLASH} effort=high`)])
})

test('automatic effort: no storage, a storage that throws, or a marker that does not read back sends nothing, and nothing in memory stands in for it', async () => {
  const dropping = { ...fakeStorage(), setItem() {} }
  const other = fakeStorage()
  other.setItem = (key) => { other.items.set(key, 'another tab') }
  for (const [name, options] of [
    ['no localStorage global', { globals: {} }],
    ['localStorage is null', { globals: { localStorage: null } }],
    ['reading localStorage throws', { prelude: SECURITY_ERROR }],
    ['getItem throws', { globals: { localStorage: { ...fakeStorage(), getItem() { throw new Error('denied') } } } }],
    ['setItem throws', { globals: { localStorage: { ...fakeStorage(), setItem() { throw new Error('QuotaExceededError') } } } }],
    ['the write does not read back', { globals: { localStorage: dropping } }],
    ['another value reads back', { globals: { localStorage: other } }],
    ['the marker is already set', { globals: { localStorage: fakeStorage({ [MARKER]: 'user' }) } }],
    ['the marker is an empty string', { globals: { localStorage: fakeStorage({ [MARKER]: '' }) } }],
  ]) {
    const harness = cellHarness({ view: manualView({ hard: [haiku] }), ...options })
    assert.equal(harness.cell.instance.dirty, false, `${name}: no draft`)
    assert.deepEqual(await settleRender(harness), [], name)
    assert.equal(effortSpan(harness.output()), undefined, name)
    // The menu opened again in the same page has nothing in memory to send with either.
    harness.cell.unmount()
    const element = harness.menu.cells[2]
    const again = harness.env.runtime.mount(element.type)
    again.render({ ...element.props, open: false })
    again.render()
    await ticks()
    assert.deepEqual(harness.calls, [], `${name}: remounted`)
  }
  // A failed claim is the mount's one attempt: storage that works again later is not asked again by that mount.
  let failing = true
  const flaky = fakeStorage()
  const write = flaky.setItem
  flaky.setItem = (key, value) => { if (failing) throw new Error('QuotaExceededError'); write(key, value) }
  const once = cellHarness({ view: manualView({ hard: [haiku] }), globals: { localStorage: flaky } })
  failing = false
  for (let index = 0; index < 3; index++) once.render()
  await ticks()
  assert.deepEqual(once.calls, [])
  assert.deepEqual(flaky.log, [`get ${MARKER}`], 'one attempt per mount')
  once.cell.unmount()
  const element = once.menu.cells[2]
  const next = once.env.runtime.mount(element.type)
  next.render({ ...element.props, open: false })
  next.render()
  await ticks()
  assert.deepEqual(once.calls, [AUTO_LINE], 'the next mount makes its own attempt')
})

test('automatic effort: one attempt per mount: a rejected automatic command snaps back, is reported once, and is not tried again in that mount or the next', async () => {
  const storage = fakeStorage()
  const harness = autoHarness({ storage })
  assert.deepEqual(await settleRender(harness), [AUTO_LINE])
  const failure = { count: 1, text: 'Router is already updating. Try again after it finishes.', target: 'level', level: 'hard' }
  harness.render({ view: manualView({ hard: [haiku] }, { failure }) })
  const output = harness.render()
  assert.deepEqual(harness.reports, [failure.text])
  assert.equal(effortSpan(output), undefined, 'snapped back to the saved entry')
  assert.equal(cellButton(output).props['aria-busy'], false)
  // Even with the marker gone, this mount does not try again.
  storage.items.clear()
  for (let index = 0; index < 3; index++) harness.render()
  await ticks()
  assert.deepEqual(harness.calls, [AUTO_LINE])
  assert.equal(storage.items.size, 0, 'nor claims the marker again')
  // The next mount finds the marker and sends nothing.
  assert.deepEqual(await settleRender(autoHarness({ storage: fakeStorage({ [MARKER]: 'auto' }) })), [])
  // A line the host does not admit is final too.
  const refused = autoHarness()
  refused.env.harness.commandUi = { execute: async (_target, line) => { refused.calls.push(line); return { kind: 'error', text: `unknown or malformed command: ${line}` } } }
  assert.deepEqual(await settleRender(refused), [AUTO_LINE])
  for (let index = 0; index < 3; index++) refused.render()
  await ticks()
  assert.deepEqual(refused.calls, [AUTO_LINE])
  assert.deepEqual(refused.reports, [`unknown or malformed command: ${AUTO_LINE}`])
  assert.equal(effortSpan(refused.output()), undefined)
})

test('automatic effort: every choice in the cell writes the marker at once, before its commit; a disabled row writes nothing', async () => {
  // An unavailable entry keeps the cell from applying anything itself.
  const view = manualView({ hard: [haiku, { provider: 'gone', model: 'retired' }] })
  for (const [name, choose] of [
    ['checking a model', (output) => pick(output, FLASH)],
    ['unchecking a model', (output) => pick(output, HAIKU)],
    ['picking an effort row', (output) => pickEffort(output, HAIKU, 'Low')],
    ['picking Default', (output) => pickEffort(output, HAIKU, 'Default (Medium)')],
    ['Inherit', (output) => pickInherit(output)],
    ['removing an unavailable entry', (output) => pick(output, 'gone/retired')],
  ]) {
    const storage = fakeStorage()
    const harness = autoHarness({ storage, view })
    const output = harness.open()
    assert.deepEqual(storage.log, [], `${name}: nothing before the choice`)
    choose(output)
    assert.deepEqual(storage.log, [`set ${MARKER}=user`], name)
    assert.deepEqual(harness.calls, [], `${name}: written before the commit`)
  }
  const locked = autoHarness({ view, extra: { locked: true } })
  pick(locked.open(), FLASH)
  pickInherit(locked.render())
  assert.deepEqual(locked.storage.log, [])
})

test('automatic effort: a Default picked after the automatic effort is never undone, in that mount or after a remount', async () => {
  const storage = fakeStorage()
  const harness = autoHarness({ storage })
  assert.deepEqual(await settleRender(harness), [AUTO_LINE])
  harness.render({ view: manualView({ hard: [{ ...haiku, effort: 'xhigh' }] }) })
  pickEffort(harness.open(), HAIKU, 'Default (Medium)')
  assert.equal(storage.items.get(MARKER), 'user')
  harness.close()
  await ticks()
  harness.render({ view: manualView({ hard: [haiku] }) })
  for (let index = 0; index < 3; index++) harness.render()
  await ticks()
  assert.deepEqual(harness.calls, [AUTO_LINE, levelLine('hard', HAIKU)])
  assert.deepEqual(await settleRender(autoHarness({ storage })), [], 'the marker keeps the Default after a remount')
})

test('automatic effort: a model checked from Inherit and then set to Default stays at Default, in that mount and the next', async () => {
  const storage = fakeStorage()
  const harness = autoHarness({ storage, view: manualView({ hard: null }) })
  // The pick path adds the recommendation; the user then picks Default.
  pick(harness.open(), HAIKU)
  pickEffort(harness.render(), HAIKU, 'Default (Medium)')
  harness.close()
  await ticks()
  assert.deepEqual(harness.calls, [levelLine('hard', HAIKU)])
  harness.render({ view: manualView({ hard: [haiku] }) })
  for (let index = 0; index < 3; index++) harness.render()
  await ticks()
  assert.deepEqual(harness.calls, [levelLine('hard', HAIKU)], 'no automatic command while the menu stays open')
  assert.equal(storage.items.get(MARKER), 'user')
  assert.deepEqual(await settleRender(autoHarness({ storage })), [], 'nor when it opens again')
})

test('automatic effort: the draft takes the commit path: a menu closing before the next render commits it once, and closing after the send adds nothing', async () => {
  const early = autoHarness()
  assert.equal(early.cell.instance.dirty, true)
  early.cell.unmount()
  early.menu.parent.unmount()
  await ticks()
  assert.deepEqual(early.calls, [AUTO_LINE], 'committed once on unmount')
  const late = autoHarness()
  assert.deepEqual(await settleRender(late), [AUTO_LINE])
  late.cell.unmount()
  late.menu.parent.unmount()
  await ticks()
  assert.deepEqual(late.calls, [AUTO_LINE], 'the sent draft is not sent again')
})

test('automatic effort: its own draft and unconfirmed command, or its own call still running, hold it back even without the marker', async () => {
  const directory = fakeDirectory([])
  const harness = autoHarness({ getService: directoryService(directory) })
  pick(harness.open(), FLASH)
  harness.close()
  await ticks()
  assert.deepEqual(harness.calls, [levelLine('hard', `${HAIKU},${FLASH}`)])
  // The storage is cleared and the efforts arrive while that command awaits its confirmation.
  harness.storage.items.clear()
  directory.publish(CATALOG)
  harness.render()
  await ticks()
  assert.equal(harness.calls.length, 1, 'its own draft and unconfirmed command')
  harness.render({ view: manualView({ hard: [haiku, selected[0]] }) })
  for (let index = 0; index < 3; index++) harness.render()
  await ticks()
  assert.equal(harness.calls.length, 1, 'once confirmed, the changed level stops the cell for its mount')
  assert.equal(harness.storage.items.size, 0)

  // Its own call hangs past the lock's 30 s after the host recorded a rejection.
  const late = fakeDirectory([])
  const hung = autoHarness({ getService: directoryService(late), execute: 'deferred' })
  pick(hung.open(), FLASH)
  hung.close()
  await ticks()
  const failure = { count: 1, text: `Route ${FLASH} is not authorized for this session.`, target: 'level', level: 'hard' }
  hung.render({ view: manualView({ hard: [haiku] }, { failure }) })
  hung.render()
  hung.env.clock.offset += 31_000
  hung.storage.items.clear()
  late.publish(CATALOG)
  hung.render()
  await ticks()
  assert.equal(hung.calls.length, 1, 'its own call is still running')
  assert.equal(hung.storage.items.size, 0)
  hung.settle[0]()
  await ticks()
  hung.render()
  assert.deepEqual(await settleRender(hung), [levelLine('hard', `${HAIKU},${FLASH}`), AUTO_LINE],
    'with the marker gone, only that call held it back')
  assert.deepEqual(hung.reports, [failure.text])
})

test('automatic effort: a cell without a session id never reads or writes storage', async () => {
  for (const sessionId of [undefined, '', 7]) {
    const storage = fakeStorage()
    const harness = autoHarness({ storage, extra: { sessionId } })
    assert.deepEqual(await settleRender(harness), [], String(sessionId))
    pick(harness.open(), FLASH)
    harness.close()
    await ticks()
    assert.deepEqual(harness.calls, [levelLine('hard', `${HAIKU},${FLASH}`)], `${String(sessionId)}: the choice is still committed`)
    assert.deepEqual(storage.log, [], String(sessionId))
  }
})

test('automatic effort: the cell calls the same hooks in the same order on every automatic-effort path', async () => {
  const traces = new Map()
  const record = (name, harness) => {
    const trace = harness.cell.instance.trace.join(',')
    if (!traces.has(trace)) traces.set(trace, name)
  }
  const sent = autoHarness()
  record('claimed and drafted', sent)
  sent.render()
  record('sent', sent)
  await ticks()
  sent.render({ view: manualView({ hard: [{ ...haiku, effort: 'xhigh' }] }) })
  record('confirmed', sent)
  sent.open()
  record('open', sent)
  sent.close()
  record('closed', sent)
  for (const [name, harness] of [
    ['no storage', cellHarness({ view: manualView({ hard: [haiku] }) })],
    ['storage throws', autoHarness({ storage: { ...fakeStorage(), getItem() { throw new Error('denied') } } })],
    ['reading storage throws', cellHarness({ view: manualView({ hard: [haiku] }), prelude: SECURITY_ERROR })],
    ['efforts unknown', autoHarness({ getService: directoryService(fakeDirectory([])) })],
    ['Mechanical', autoHarness({ level: 'mechanical', view: manualView({ mechanical: [haiku] }) })],
    ['no session id', autoHarness({ extra: { sessionId: undefined } })],
    ['locked', autoHarness({ extra: { locked: true } })],
    ['the router off', autoHarness({ view: { ...manualView({ hard: [haiku] }), mode: 'off' } })],
  ]) {
    record(name, harness)
    harness.render()
    record(`${name}, again`, harness)
    harness.open()
    record(`${name}, open`, harness)
    harness.close()
    record(`${name}, closed`, harness)
  }
  assert.deepEqual([...traces.values()], ['claimed and drafted'], 'one hook order on every path')
  assert.equal([...traces.keys()][0],
    'ref,ref,state,state,ref,effect,state,state,ref,ref,ref,ref,ref,effect,effect,effect,effect,ref,effect,effect,ref,ref,ref,ref,state,effect',
    'the automatic effort adds one ref after the send bookkeeping and one effect after the unmount commit')
})

// 12. The automatic draft under StrictMode, and while it waits to be sent.
// The Hard judgment cell of SESSION, saved as Haiku without an effort: its
// first render makes the automatic draft.
const pendingView = (hard, level = 'hard') => manualView({ hard }, { pending: true, pendingTarget: 'level', pendingLevel: level, pendingSince: Date.now() })

test("automatic effort: StrictMode's practice unmount (mount effects, cleanup, effects again) sends the automatic command once", async () => {
  const storage = fakeStorage()
  const env = load({ getService: directoryService(fakeDirectory()), globals: { localStorage: storage } })
  const calls = recordingExecute(env)
  const menu = levels(env, manualView({ hard: [haiku] }), routes, { sessionId: SESSION })
  const element = menu.cells[2]
  const cell = env.runtime.mount(element.type, { strict: true })
  const props = { ...element.props, open: false }
  cell.render(props)
  // The practice unmount committed the draft; the cell, still mounted, must not send it again.
  for (let index = 0; index < 3; index++) cell.render()
  await ticks()
  for (let index = 0; index < 3; index++) cell.render()
  await ticks()
  assert.deepEqual(calls, [AUTO_LINE])
  assert.equal(storage.items.get(MARKER), 'auto')
  // The session confirms it and the cell settles.
  cell.render({ ...props, view: manualView({ hard: [{ ...haiku, effort: 'xhigh' }] }) })
  const output = cell.render()
  assert.equal(cellButton(output).props['aria-busy'], false)
  assert.equal(effortSpan(output), '· xhigh')
  await ticks()
  assert.deepEqual(calls, [AUTO_LINE])
})

// The Hard judgment cell of SESSION, saved as Haiku without an effort, mounted
// under StrictMode; outcome answers each call.
function strictCell(outcome = () => ({ kind: 'success' })) {
  const storage = fakeStorage()
  const reports = []
  const env = load({ getService: directoryService(fakeDirectory()), globals: { localStorage: storage } })
  const calls = []
  env.harness.commandUi = { execute: async (_target, line) => { calls.push(line); return outcome(line) } }
  const menu = levels(env, manualView({ hard: [haiku] }), routes, { sessionId: SESSION, reportFailure: (message) => reports.push(message) })
  const element = menu.cells[2]
  const cell = env.runtime.mount(element.type, { strict: true })
  let props = { ...element.props, open: false }
  cell.render(props)
  const render = (changes = {}) => {
    props = { ...props, ...changes }
    return cell.render(props)
  }
  return { calls, reports, storage, cell, render }
}

test("automatic effort: under StrictMode the draft is still checked when it is sent: a level changed in the next render drops it", async () => {
  const strict = strictCell()
  strict.render({ view: manualView({ hard: [selected[0]] }) })
  const output = strict.render()
  await ticks()
  strict.render()
  await ticks()
  assert.deepEqual(strict.calls, [], "the practice unmount does not send it ahead of the cell's own checks")
  assert.equal(effortSpan(output), undefined)
})

test('automatic effort: under StrictMode a refused automatic command snaps back like any other, reported once', async () => {
  const strict = strictCell((line) => ({ kind: 'error', text: `unknown or malformed command: ${line}` }))
  strict.render()
  await ticks()
  const output = strict.render()
  await ticks()
  assert.deepEqual(strict.calls, [AUTO_LINE])
  assert.deepEqual(strict.reports, [`unknown or malformed command: ${AUTO_LINE}`])
  assert.equal(effortSpan(output), undefined, 'the saved entry again, not the refused draft')
  assert.equal(cellButton(output).props['aria-busy'], false)
})

test('a draft committed by a cleanup while the cell stays mounted (effects cleaned up and run again) is not sent a second time', async () => {
  const harness = cellHarness({ view: manualView({ hard: [haiku] }) })
  pickEffort(harness.open(), HAIKU, 'Low')
  harness.render()
  // The effects are cleaned up and run again while the flyout is still open.
  harness.cell.cycle()
  await ticks()
  assert.deepEqual(harness.calls, [levelLine('hard', `${HAIKU} effort=low`)], 'the cleanup committed the draft')
  harness.close()
  await ticks()
  harness.render()
  await ticks()
  assert.deepEqual(harness.calls, [levelLine('hard', `${HAIKU} effort=low`)], 'the cell does not send it again')
})

test('automatic effort: R1: a draft waiting on another command is dropped, not sent, when that command changes the level', async () => {
  const harness = autoHarness()
  assert.equal(harness.cell.instance.dirty, true)
  // The next render: another tab's command on this level is pending.
  harness.render({ view: pendingView([haiku]) })
  await ticks()
  assert.deepEqual(harness.calls, [], 'the draft waits while a router command is pending')
  // That command lands: Hard judgment is now Flash.
  harness.render({ view: manualView({ hard: [selected[0]] }) })
  const output = harness.render()
  await ticks()
  assert.deepEqual(harness.calls, [], 'the Haiku line would overwrite Flash')
  assert.equal(valueSpan(output), 'deepseek-flash-latest')
  assert.equal(effortSpan(output), undefined)
  assert.equal(cellButton(output).props['aria-busy'], false)
  for (let index = 0; index < 3; index++) harness.render()
  await ticks()
  assert.deepEqual(harness.calls, [], 'and it is not tried again')
})

test('automatic effort: R1b: a draft whose level changes in the very next render is dropped', async () => {
  const harness = autoHarness()
  harness.render({ view: manualView({ hard: [selected[0]] }) })
  const output = harness.render()
  await ticks()
  assert.deepEqual(harness.calls, [])
  assert.equal(effortSpan(output), undefined)
  assert.deepEqual(harness.reports, [])
})

test('automatic effort: R1c: a menu closing while the draft waits on a pending command and the level has changed sends nothing', async () => {
  const harness = autoHarness()
  harness.render({ view: pendingView([haiku]) })
  await ticks()
  // The level changes while that command is still pending, and the host menu closes before the next render.
  harness.render({ view: pendingView([selected[0]]) })
  harness.cell.unmount()
  harness.menu.parent.unmount()
  await ticks()
  assert.deepEqual(harness.calls, [])
})

test('automatic effort: R2: the router turned off, or the menu locked, before the draft is sent drops it', async () => {
  const harness = autoHarness({ execute: 'deferred' })
  // The switch is pressed before the next render.
  pressSwitch(harness.env, false, { sessionId: SESSION })
  harness.render()
  await ticks()
  assert.deepEqual(harness.calls, ['/router off'], 'the draft waits behind the switch')
  harness.settle[0]()
  await ticks()
  // The session shows the router off when the released lock wakes the cell.
  harness.render({ view: { ...manualView({ hard: [haiku] }), mode: 'off' }, lockTick: 1 })
  const output = harness.render()
  await ticks()
  assert.deepEqual(harness.calls, ['/router off'], 'no level command after the router was turned off')
  assert.equal(effortSpan(output), undefined)
  // A session that shows the router off while the switch still holds the lock drops it at once.
  const early = autoHarness({ execute: 'deferred' })
  pressSwitch(early.env, false, { sessionId: SESSION })
  early.render()
  await ticks()
  early.render({ view: { ...manualView({ hard: [haiku] }), mode: 'off' } })
  assert.equal(effortSpan(early.render()), undefined, 'dropped before the lock is free')
  early.settle[0]()
  await ticks()
  early.render({ lockTick: 1 })
  early.render()
  await ticks()
  assert.deepEqual(early.calls, ['/router off'])
  // The unmount commit drops it too.
  const closing = autoHarness({ execute: 'deferred' })
  pressSwitch(closing.env, false, { sessionId: SESSION })
  closing.render({ view: { ...manualView({ hard: [haiku] }), mode: 'off' } })
  closing.cell.unmount()
  closing.menu.parent.unmount()
  await ticks()
  closing.settle[0]()
  await ticks()
  assert.deepEqual(closing.calls, ['/router off'])
  // A menu that becomes locked before the send drops it.
  const locked = autoHarness()
  locked.render({ locked: true })
  locked.render({ locked: false })
  await ticks()
  assert.deepEqual(locked.calls, [])
})

test('automatic effort: a draft waiting on a command that leaves its level alone is still sent, and a hand-made draft of the same text is never dropped', async () => {
  const harness = autoHarness()
  harness.render({ view: pendingView([haiku], 'ordinary') })
  await ticks()
  assert.deepEqual(harness.calls, [])
  assert.deepEqual(await settleRender(harness, { view: manualView({ hard: [haiku], ordinary: [selected[0]] }) }), [AUTO_LINE])
  // The automatic draft is dropped; the user then makes the same value by hand.
  const manual = autoHarness()
  manual.render({ view: manualView({ hard: [selected[0]] }) })
  manual.render()
  await ticks()
  assert.deepEqual(manual.calls, [])
  pick(manual.open(), HAIKU)
  pick(manual.render(), FLASH)
  manual.close()
  await ticks()
  assert.deepEqual(manual.calls, [AUTO_LINE], 'the same text, made by hand, is the user\'s choice')
})

test("automatic effort: a previous menu's commit of the same level still in flight holds it back, and the level it lands drops a draft made after it", async () => {
  const storage = fakeStorage({ [MARKER]: 'user' })
  const first = autoHarness({ storage, execute: 'deferred' })
  assert.equal(first.cell.instance.dirty, false, 'the marker is set: nothing automatic in the first menu')
  pick(first.open(), FLASH)
  first.render()
  first.cell.unmount()
  first.menu.parent.unmount()
  await ticks()
  const userLine = levelLine('hard', `${HAIKU},${FLASH} effort=high`)
  assert.deepEqual(first.calls, [userLine], 'the closed menu commits its draft')
  // The storage is cleared and the menu opens again while that commit runs.
  storage.items.clear()
  const menu = levels(first.env, manualView({ hard: [haiku] }), routes, { sessionId: SESSION })
  const element = menu.cells[2]
  const cell = first.env.runtime.mount(element.type)
  cell.render({ ...element.props, open: false })
  cell.render()
  await ticks()
  assert.equal(cell.instance.dirty, false, "no automatic draft while this level's commit runs")
  assert.equal(storage.items.size, 0, 'and no marker')
  assert.deepEqual(first.calls, [userLine])
  // The commit settles before the session shows its result: a draft made then is dropped when it does.
  first.settle[0]()
  await ticks()
  assert.equal(flush(menu, cell, 'hard'), true)
  cell.render({ ...element.props, open: false, view: manualView({ hard: [haiku, { ...selected[0], effort: 'high' }] }) })
  cell.render()
  await ticks()
  assert.deepEqual(first.calls, [userLine], 'the earlier choice is not overwritten')
})

test('an effort row of a model that is not checked does nothing, even when its handler is called directly', async () => {
  const storage = fakeStorage()
  const harness = autoHarness({ storage, level: 'ordinary', view: manualView({ ordinary: [haiku] }) })
  const output = harness.open()
  const rows = effortRowsOf(output, FLASH)
  assert.equal(rows.length > 0 && rows.every((row) => row.props.disabled === true), true)
  for (const row of rows) row.type(row.props).props.onClick()
  for (const row of rows) row.props.onSelect()
  assert.equal(harness.cell.instance.dirty, false, 'no draft')
  assert.deepEqual(storage.log, [], 'not a choice: no marker')
  const after = harness.render()
  assert.equal(rowFor(after, FLASH).props.checked, false)
  assert.equal(effortGroupOf(after, FLASH).props.hidden, true)
  harness.close()
  await ticks()
  assert.deepEqual(harness.calls, [])
})
