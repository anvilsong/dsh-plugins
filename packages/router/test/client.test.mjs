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

function load() {
  const registrations = []
  const runtime = createRuntime()
  const harness = { commandUi: undefined }
  const primitives = new Proxy({}, { get: (_target, key) => key })
  const slots = {
    inject(_name, callback) { callback() },
    register(definition, component) { registrations.push({ definition, component }) },
  }
  vm.runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), {
    window: {
      __ModuleLoader__: {
        load({ id, factory }) {
          const result = factory((name) => name === 'react' ? runtime.React : primitives)
          assert.equal(id, 'dsh-plugin-router')
          assert.equal(result.inject[0], 'slots')
          result.apply({ get: (key) => key === 'commandUi' ? harness.commandUi : undefined, slots, effect() {} })
        },
      },
    },
  })
  return { registrations, runtime, harness }
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
  assert.match(text(button), /deepseek-flash-latest \+1/)
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
  const rows = findAll(flyout.children, (node) => typeof node.props?.onSelect === 'function')
  assert.equal(rows[0].props.label, 'Inherit (session default)')
  assert.equal(rows[0].props.checked, false)
  assert.deepEqual(rows.slice(1).map((row) => [row.props.title, row.props.checked]), [
    ['openrouter/~deepseek/deepseek-flash-latest', true],
    ['openai-codex/~deepseek/deepseek-flash-latest', true],
    ['anthropic/claude-haiku-5-5', false],
  ])
  assert.deepEqual(findAll(flyout.children, (node) => node.props?.role === 'group').map((group) => group.props['aria-label']),
    ['openrouter', 'openai-codex', 'anthropic'])

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
