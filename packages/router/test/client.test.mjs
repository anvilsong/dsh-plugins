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

// options.locale: a locale service for ctx.get('locale') (its effects run);
// options.getService: answers every other ctx.get (modelDirectories) and may
// throw, as a lazily read service may;
// options.globals: extra globals for the client, such as a fake document.
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
  vm.runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), {
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
function cellHarness({ level = 'hard', view = manualView({}), routeList = routes, getService = directoryService(fakeDirectory()), execute = 'record', extra = {}, locale, globals } = {}) {
  const env = load({ getService, locale, globals })
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
