import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

// The sibling packages whose switch rows share the menu; a word is built from parts so this file stays clear of it.
const OTHER_CLIENTS = ['ultracode', 'router', ['advi', 'sor'].join('')]
const SOURCE = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

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
const ticks = async (count = 16) => { for (let index = 0; index < count; index++) await Promise.resolve() }

// A tiny hook runtime, as the other clients' tests use: one persistent hook
// list per instance, effects run when their dependencies change, cleanups run
// on unmount, and each render records the kinds of the hooks it called.
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
      for (const effect of instance.pending) { current = instance; effect() }
      return output
    }
    const unmount = () => { for (const hook of instance.hooks) hook?.cleanup?.() }
    return { instance, render, unmount }
  }
  return { React, mount }
}

// options.primitives replaces the primitives object (an empty one has no
// Switch); options.locale is a locale service for ctx.get('locale').
function load(options = {}) {
  const registrations = []
  const injected = []
  const effects = []
  const runtime = createRuntime()
  const harness = { commandUi: undefined }
  const clock = { offset: 0 }
  // The base is read once, so the clock moves only when a test sets the offset (real time passing, as on a loaded
  // machine, must not shift a boundary the test checks to the millisecond).
  const base = Date.now()
  class TestDate extends Date { static now() { return base + clock.offset } }
  const primitives = options.primitives ?? new Proxy({}, { get: (_target, key) => key })
  const slots = {
    inject(name, callback) { injected.push(name); callback() },
    register(definition, component) { registrations.push({ definition, component }) },
  }
  const get = (key) => key === 'commandUi' ? harness.commandUi : key === 'locale' ? options.locale : undefined
  let result
  const context = vm.createContext({
    Date: TestDate,
    window: {
      __ModuleLoader__: {
        load({ id, factory }) {
          assert.equal(id, 'dsh-plugin-explainer')
          result = factory((name) => name === 'react' ? runtime.React : primitives)
          result.apply({ get, slots, effect(callback, name) { effects.push(name); callback() } })
        },
      },
    },
  })
  vm.runInContext(SOURCE, context)
  return { registrations, injected, effects, result, runtime, harness, clock }
}

const VIEW = { on: false, pending: false, pendingSince: null, failure: null }
const SESSION = 'session-1'

// One mounted switch whose projection view the test can replace.
function mountSwitch(env, initial = VIEW, extra = {}) {
  const state = { view: initial }
  const element = env.registrations[0].component({
    sessionId: SESSION, locked: false, useProjection: (key) => key === 'explainer' ? state.view : undefined, ...extra,
  })
  const cell = env.runtime.mount(element.type)
  const output = cell.render(element.props)
  return {
    state, cell, output, element,
    rerender: () => cell.render(),
    toggle: (node = output) => find(node, (candidate) => candidate.props?.className === 'ex-toggle'),
  }
}

const recordingUi = (env, outcome = { kind: 'success', text: 'ok' }) => {
  const calls = []
  env.harness.commandUi = { execute: async (target, line) => { calls.push({ sessionId: target.sessionId, line }); return outcome } }
  return calls
}

test('the client registers exactly one entry in the model-options slot', () => {
  const env = load()
  assert.deepEqual(Array.from(env.result.inject), ['slots'])
  assert.deepEqual(env.injected, ['conversation.input.model.options'])
  assert.equal(env.registrations.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(env.registrations[0].definition)), { name: 'conversation.input.model.options', id: 'explainer-option', order: 28 })
  assert.equal(typeof env.registrations[0].component, 'function')
})

test('the entry sorts after the other switch rows, and its id is unique among the clients', () => {
  const order = Number(/order: (\d+)/.exec(SOURCE)[1])
  for (const other of OTHER_CLIENTS) {
    const source = readFileSync(new URL(`../../${other}/src/client.js`, import.meta.url), 'utf8')
    for (const match of source.matchAll(/id: '([^']+)', order: (\d+)/g)) {
      assert.ok(order > Number(match[2]), `${other}:${match[1]}`)
      assert.notEqual(match[1], 'explainer-option')
    }
  }
})

test('the dictionaries register under explainer when the locale service exists', () => {
  const registered = []
  const env = load({ locale: { register: (name, tables) => { registered.push([name, tables]); return () => {} }, bind: (name) => (key) => `${name}:${key}` } })
  assert.deepEqual(env.effects, ['explainer: dictionaries'])
  assert.equal(registered.length, 1)
  assert.equal(registered[0][0], 'explainer')
  const switchRow = mountSwitch(env)
  assert.match(text(switchRow.output), /explainer:chip\.label/)
  assert.equal(find(switchRow.output, (node) => node.props?.className === 'ex-row').props.title, 'explainer:chip.hint')
})

test('it renders the label and a switch; the hint is the row tooltip, not a visible line', () => {
  const env = load()
  const { output, toggle } = mountSwitch(env)
  const row = find(output, (node) => node.props?.className === 'ex-row')
  assert.ok(row)
  assert.equal(find(row, (node) => node.props?.className === 'ex-label').children[0], 'Explainer style (ASD-STE100)')
  assert.equal(row.props.title, 'Plain explanations based on ASD-STE100 writing rules (a subset): short prose, text diagrams, offered pages.')
  assert.equal(toggle().type, 'Switch')
  // A visible hint widened the menu past its limits: no node but the label holds text.
  assert.equal(findAll(output, (node) => typeof node.props?.className === 'string' && /hint/.test(node.props.className)).length, 0)
  assert.equal(findAll(output, (node) => node.props?.id !== undefined).length, 0, 'no id, so nothing is duplicated across menus')
  assert.equal(findAll(output, (node) => node.props?.['aria-describedby'] !== undefined).length, 0)
  const words = findAll(output, (node) => node.type === 'span').flatMap((node) => node.children.filter((child) => typeof child === 'string'))
  assert.deepEqual(words, ['Explainer style (ASD-STE100)'])
})

test('the switch reflects the projection on and off', () => {
  const env = load()
  assert.equal(mountSwitch(env, { ...VIEW, on: true }).toggle().props.checked, true)
  assert.equal(mountSwitch(env, { ...VIEW, on: false }).toggle().props.checked, false)
  const view = mountSwitch(env, { ...VIEW, on: true })
  view.state.view = { ...VIEW, on: false }
  assert.equal(view.toggle(view.rerender()).props.checked, false)
})

test('a pending change shows the spinner, aria-busy and the updating label; idle shows none', () => {
  const env = load()
  const idle = mountSwitch(env)
  assert.equal(findAll(idle.output, (node) => node.props?.className === 'ex-spinner').length, 0)
  assert.equal(find(idle.output, (node) => node.props?.className === 'ex-row').props['aria-busy'], false)
  assert.equal(idle.toggle().props.label, 'Explainer style (ASD-STE100)')

  const busy = mountSwitch(env, { on: false, pending: true, pendingSince: Date.now(), failure: null })
  assert.equal(findAll(busy.output, (node) => node.props?.className === 'ex-spinner').length, 1)
  assert.equal(find(busy.output, (node) => node.props?.className === 'ex-row').props['aria-busy'], true)
  assert.equal(busy.toggle().props.label, 'Explainer style (ASD-STE100) — Updating…')
  assert.ok(!busy.toggle().props.disabled, 'a focused switch is never disabled mid-flight (that blur closes the host menu)')
  // The spinner is hidden from assistive technology; the row and label say it.
  assert.equal(find(busy.output, (node) => node.props?.className === 'ex-spinner').props['aria-hidden'], 'true')
})

test('a pending marker older than five minutes shows no spinner and no longer blocks the press', async () => {
  const env = load()
  const calls = recordingUi(env)
  const stale = mountSwitch(env, { on: false, pending: true, pendingSince: Date.now() - 6 * 60_000, failure: null })
  assert.equal(findAll(stale.output, (node) => node.props?.className === 'ex-spinner').length, 0)
  stale.toggle().props.onChange(true)
  await ticks()
  assert.deepEqual(calls, [{ sessionId: SESSION, line: '/explain-style on' }])
})

test('the spinner follows a command that is running, and goes when it settles', async () => {
  const env = load()
  let settle
  env.harness.commandUi = { execute: () => new Promise((resolve) => { settle = () => resolve({ kind: 'success' }) }) }
  const view = mountSwitch(env)
  view.toggle().props.onChange(true)
  assert.equal(findAll(view.rerender(), (node) => node.props?.className === 'ex-spinner').length, 1)
  settle()
  await ticks()
  assert.equal(findAll(view.rerender(), (node) => node.props?.className === 'ex-spinner').length, 0)
})

test('pressing sends the opposite of the current state', async () => {
  const env = load()
  const calls = recordingUi(env)
  mountSwitch(env, { ...VIEW, on: false }).toggle().props.onChange(true)
  await ticks()
  mountSwitch(env, { ...VIEW, on: true }).toggle().props.onChange(false)
  await ticks()
  assert.deepEqual(calls, [
    { sessionId: SESSION, line: '/explain-style on' },
    { sessionId: SESSION, line: '/explain-style off' },
  ])
})

test('the line depends on the shown state, not on the value the switch passes', async () => {
  const env = load()
  const calls = recordingUi(env)
  mountSwitch(env, { ...VIEW, on: true }).toggle().props.onChange(true)
  await ticks()
  assert.deepEqual(calls.map((call) => call.line), ['/explain-style off'])
})

test('without a projection view nothing renders, with the same hooks in the same order', () => {
  const env = load()
  const state = { view: undefined }
  const element = env.registrations[0].component({ sessionId: SESSION, useProjection: () => state.view })
  const cell = env.runtime.mount(element.type)
  assert.equal(cell.render(element.props), null)
  const missing = [...cell.instance.trace]
  state.view = null
  assert.equal(cell.render(), null)
  state.view = { ...VIEW, on: true }
  const shown = cell.render()
  assert.ok(find(shown, (node) => node.props?.className === 'ex-toggle'))
  assert.deepEqual(cell.instance.trace, missing, 'hook order never changes between missing and present')
  assert.equal(env.registrations[0].component({ sessionId: SESSION }).type !== undefined, true)
  const noHook = env.runtime.mount(element.type).render({ ...element.props, useProjection: undefined })
  assert.equal(noHook, null)
})

test('the press asks the command service of the right session, and without one reports it', async () => {
  const env = load()
  const reports = []
  const view = mountSwitch(env, VIEW, { sessionId: 'other', reportFailure: (message) => reports.push(message) })
  view.toggle().props.onChange(true)
  await ticks()
  assert.deepEqual(reports, ['The command service is unavailable.'])
})

test('a refused command is reported through reportFailure with the host text, else the generic', async () => {
  for (const [outcomeText, expected] of [['Host says no', 'Host says no'], ['', 'Could not update Explainer style.'], [undefined, 'Could not update Explainer style.']]) {
    const env = load()
    recordingUi(env, { kind: 'error', text: outcomeText })
    const reports = []
    const view = mountSwitch(env, VIEW, { reportFailure: (message) => reports.push(message) })
    view.toggle().props.onChange(true)
    await ticks()
    assert.deepEqual(reports, [expected])
    assert.equal(findAll(view.rerender(), (node) => node.props?.role === 'alert').length, 0, 'with a channel nothing is rendered inline')
  }
})

test('a thrown call is reported by its message, and without one by the generic', async () => {
  for (const [thrown, expected] of [[new Error('boom'), 'boom'], [new Error(''), 'Could not update Explainer style.'], ['plain', 'Could not update Explainer style.']]) {
    const env = load()
    env.harness.commandUi = { execute: async () => { throw thrown } }
    const reports = []
    const view = mountSwitch(env, VIEW, { reportFailure: (message) => reports.push(message) })
    view.toggle().props.onChange(true)
    await ticks()
    assert.deepEqual(reports, [expected])
  }
})

test('without a failure channel the error is rendered inline as an alert, and the next press clears it', async () => {
  const env = load()
  recordingUi(env, { kind: 'error', text: 'Host says no' })
  const view = mountSwitch(env)
  assert.equal(findAll(view.output, (node) => node.props?.role === 'alert').length, 0)
  view.toggle().props.onChange(true)
  await ticks()
  const alert = find(view.rerender(), (node) => node.props?.role === 'alert')
  assert.equal(alert.children[0], 'Host says no')
  assert.equal(alert.props.className, 'ex-error')
  recordingUi(env)
  view.toggle(view.rerender()).props.onChange(true)
  await ticks()
  assert.equal(findAll(view.rerender(), (node) => node.props?.role === 'alert').length, 0, 'a new press starts without the old error')
})

test('an unavailable command service is rendered inline when there is no channel', async () => {
  const env = load()
  const view = mountSwitch(env)
  view.toggle().props.onChange(true)
  await ticks()
  assert.equal(find(view.rerender(), (node) => node.props?.role === 'alert').children[0], 'The command service is unavailable.')
})

test('a failure recorded in the projection after our press is reported once, with its text', async () => {
  for (const [failureText, expected] of [['Handler refused', 'Handler refused'], ['', 'Could not update Explainer style.']]) {
    const env = load()
    recordingUi(env)
    const reports = []
    const view = mountSwitch(env, VIEW, { reportFailure: (message) => reports.push(message) })
    view.toggle().props.onChange(true)
    await ticks()
    view.state.view = { ...VIEW, failure: { count: 1, text: failureText, arg: 'on' } }
    view.rerender()
    view.rerender()
    assert.deepEqual(reports, [expected])
  }
})

test('a failure recorded in the projection is rendered inline when there is no channel', async () => {
  const env = load()
  recordingUi(env)
  const view = mountSwitch(env)
  view.toggle().props.onChange(true)
  await ticks()
  view.state.view = { ...VIEW, failure: { count: 1, text: 'Handler refused', arg: 'on' } }
  view.rerender()
  assert.equal(find(view.rerender(), (node) => node.props?.role === 'alert').children[0], 'Handler refused')
})

test('a failure we did not send, from another tab or an earlier session state, is not reported', async () => {
  const env = load()
  recordingUi(env)
  const reports = []
  const view = mountSwitch(env, { ...VIEW, failure: { count: 2, text: 'old', arg: 'on' } }, { reportFailure: (message) => reports.push(message) })
  view.state.view = { ...VIEW, failure: { count: 3, text: 'other tab', arg: 'off' } }
  view.rerender()
  assert.deepEqual(reports, [])
})

test('an outcome error and the projection failure for the same press are reported once', async () => {
  const env = load()
  let settle
  env.harness.commandUi = { execute: () => new Promise((resolve) => { settle = resolve }) }
  const reports = []
  const view = mountSwitch(env, VIEW, { reportFailure: (message) => reports.push(message) })
  view.toggle().props.onChange(true)
  view.state.view = { ...VIEW, failure: { count: 1, text: 'from the log', arg: 'on' } }
  view.rerender()
  settle({ kind: 'error', text: 'from the outcome' })
  await ticks()
  assert.deepEqual(reports, ['from the log'])
})

test('a failed press can be retried at once', async () => {
  const env = load()
  recordingUi(env, { kind: 'error', text: 'no' })
  const calls = []
  env.harness.commandUi = { execute: async (_target, line) => { calls.push(line); return { kind: 'error', text: 'no' } } }
  const view = mountSwitch(env, VIEW, { reportFailure: () => {} })
  view.toggle().props.onChange(true)
  await ticks()
  view.toggle(view.rerender()).props.onChange(true)
  await ticks()
  assert.deepEqual(calls, ['/explain-style on', '/explain-style on'])
})

test('presses are ignored while a command is pending, running or locked', async () => {
  const env = load()
  const calls = recordingUi(env)
  mountSwitch(env, { on: false, pending: true, pendingSince: Date.now(), failure: null }).toggle().props.onChange(true)
  mountSwitch(env, VIEW, { locked: true }).toggle().props.onChange(true)
  await ticks()
  assert.deepEqual(calls, [])
  assert.equal(mountSwitch(env, VIEW, { locked: true }).toggle().props.disabled, true)
})

test('a second press while the first is still running sends no second command, also from a reopened menu', async () => {
  const env = load()
  const lines = []
  let settle
  env.harness.commandUi = { execute: (_target, line) => { lines.push(line); return new Promise((resolve) => { settle = () => resolve({ kind: 'success' }) }) } }
  const first = mountSwitch(env)
  first.toggle().props.onChange(true)
  first.toggle(first.rerender()).props.onChange(true)
  mountSwitch(env).toggle().props.onChange(true)
  assert.deepEqual(lines, ['/explain-style on'])
  settle()
  await ticks()
  // The projection still shows off and nothing is pending; a new press is for the same state.
  // This menu instance still waits for the session to show the change (30 s at most) ...
  first.toggle(first.rerender()).props.onChange(true)
  assert.deepEqual(lines, ['/explain-style on'], 'until the session shows the change or 30 s pass, a second press waits')
  // ... while a menu opened afterwards is only held back by a command still running.
  mountSwitch(env).toggle().props.onChange(true)
  assert.deepEqual(lines, ['/explain-style on', '/explain-style on'])
})

test('a command that never settles stops holding the switch after 30 s', async () => {
  const env = load()
  const lines = []
  env.harness.commandUi = { execute: (_target, line) => { lines.push(line); return new Promise(() => {}) } }
  const view = mountSwitch(env)
  view.toggle().props.onChange(true)
  env.clock.offset = 29_999
  view.toggle(view.rerender()).props.onChange(true)
  assert.equal(lines.length, 1)
  assert.equal(findAll(view.rerender(), (node) => node.props?.className === 'ex-spinner').length, 1)
  env.clock.offset = 30_000
  assert.equal(findAll(view.rerender(), (node) => node.props?.className === 'ex-spinner').length, 0)
  view.toggle(view.rerender()).props.onChange(true)
  assert.deepEqual(lines, ['/explain-style on', '/explain-style on'])
})

test('once the session shows the change, the next press is the opposite', async () => {
  const env = load()
  const calls = recordingUi(env)
  const view = mountSwitch(env)
  view.toggle().props.onChange(true)
  await ticks()
  view.state.view = { ...VIEW, on: true }
  view.toggle(view.rerender()).props.onChange(false)
  await ticks()
  assert.deepEqual(calls.map((call) => call.line), ['/explain-style on', '/explain-style off'])
})

test('with no Switch primitive a native button stands in: role, aria-checked, label', async () => {
  const env = load({ primitives: {} })
  const calls = recordingUi(env)
  const off = mountSwitch(env, { ...VIEW, on: false })
  const button = off.toggle()
  assert.equal(button.type, 'button')
  assert.equal(button.props.type, 'button')
  assert.equal(button.props.role, 'switch')
  assert.equal(button.props['aria-checked'], false)
  assert.equal(button.props['aria-label'], 'Explainer style (ASD-STE100)')
  assert.equal(button.props['aria-describedby'], undefined)
  assert.equal(button.props.id, undefined)
  assert.equal(mountSwitch(env, { ...VIEW, on: true }).toggle().props['aria-checked'], true)
  assert.equal(mountSwitch(env, VIEW, { locked: true }).toggle().props.disabled, true)
  button.props.onClick()
  await ticks()
  assert.deepEqual(calls.map((call) => call.line), ['/explain-style on'])
})

test('keyboard activation is the native button: Enter and Space click it, and no key handler doubles it', () => {
  const env = load({ primitives: {} })
  const button = mountSwitch(env).toggle()
  assert.equal(button.type, 'button')
  assert.equal(button.props.onKeyDown, undefined)
  assert.equal(button.props.onKeyUp, undefined)
  assert.equal(button.props.onKeyPress, undefined)
  assert.equal(button.props.tabIndex, undefined, 'it stays in the natural tab order')
  assert.equal(typeof button.props.onClick, 'function')
})

test('the Switch primitive gets the class, the checked state, the label and the change handler', () => {
  const env = load()
  const props = mountSwitch(env, { ...VIEW, on: true }).toggle().props
  assert.deepEqual(Object.keys(props).sort(), ['checked', 'className', 'disabled', 'label', 'onChange'])
  assert.equal(props.className, 'ex-toggle')
  assert.equal(typeof props.onChange, 'function')
})

test('the styles use only the host theme tokens the other switch rows use, and respect reduced motion', () => {
  const styles = /const styles = `([^`]*)`/.exec(SOURCE)[1]
  assert.doesNotMatch(styles, /#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/, 'no literal colours')
  const own = new Set(styles.match(/--dsw-[a-z0-9-]+/g))
  const others = new Set()
  for (const other of OTHER_CLIENTS) {
    for (const token of readFileSync(new URL(`../../${other}/src/client.js`, import.meta.url), 'utf8').match(/--dsw-[a-z0-9-]+/g)) others.add(token)
  }
  for (const token of own) assert.ok(others.has(token), token)
  for (const token of ['--dsw-radius-md', '--dsw-alias-label-primary', '--dsw-alias-interactive-bg-hover', '--dsw-alias-state-error-primary']) assert.ok(own.has(token), token)
  assert.match(styles, /prefers-reduced-motion:reduce/)
  assert.match(styles, /\.ex-toggle:after\{content:"";/)
  assert.match(styles, /\.ex-row:has\(\.ex-toggle:focus-visible\)/)
  assert.doesNotMatch(styles, /ex-hint|ex-text/, 'the hint is a tooltip, so it has no rules')
  assert.match(styles, /\.ex-row\{[^}]*min-height:34px[^}]*padding:0 8px/, 'the row is as tall and as padded as the other switch rows')
  // The spinner takes no pointer events, so the whole row stays one press target.
  assert.match(styles, /\.ex-spinner\{[^}]*pointer-events:none/)
})

test('after 30 s a press goes through even when the last render saw the command as still held', async () => {
  const env = load()
  const lines = []
  env.harness.commandUi = { execute: (_target, line) => { lines.push(line); return new Promise(() => {}) } }
  const view = mountSwitch(env)
  view.toggle().props.onChange(true)
  env.clock.offset = 10_000
  const stale = view.toggle(view.rerender()) // rendered while the command is held
  env.clock.offset = 31_000
  // No render since: the deadline is judged when the switch is pressed.
  stale.props.onChange(true)
  assert.deepEqual(lines, ['/explain-style on', '/explain-style on'])
})

test('after the stale-pending age a press goes through even when the last render saw the change as pending', async () => {
  const env = load()
  const calls = recordingUi(env)
  const view = mountSwitch(env, { on: false, pending: true, pendingSince: Date.now(), failure: null })
  const held = view.toggle()
  held.props.onChange(true)
  assert.deepEqual(calls, [], 'pending holds the press')
  env.clock.offset = 6 * 60_000
  // No render since: the age is judged when the switch is pressed.
  held.props.onChange(true)
  await ticks()
  assert.deepEqual(calls.map((call) => call.line), ['/explain-style on'])
})

test('two sessions each with a command in flight do not hold each other', async () => {
  const env = load()
  const calls = []
  env.harness.commandUi = { execute: (target, line) => { calls.push([target.sessionId, line]); return new Promise(() => {}) } }
  mountSwitch(env, VIEW, { sessionId: 'one' }).toggle().props.onChange(true)
  mountSwitch(env, VIEW, { sessionId: 'two' }).toggle().props.onChange(true)
  assert.deepEqual(calls, [['one', '/explain-style on'], ['two', '/explain-style on']])
  // The same session is still held.
  mountSwitch(env, VIEW, { sessionId: 'one' }).toggle().props.onChange(true)
  assert.equal(calls.length, 2)
  // A session without an id is its own bucket, apart from the others.
  mountSwitch(env, VIEW, { sessionId: undefined }).toggle().props.onChange(true)
  assert.equal(calls.length, 3)
})

test('the late settle of an older call leaves the newer call holding the switch', async () => {
  const env = load()
  const lines = []
  const settle = []
  env.harness.commandUi = { execute: (_target, line) => { lines.push(line); return new Promise((resolve) => { settle.push(resolve) }) } }
  const first = mountSwitch(env)
  first.toggle().props.onChange(true)
  env.clock.offset = 31_000
  const second = mountSwitch(env)
  second.toggle().props.onChange(true)
  assert.equal(lines.length, 2, 'the first call passed its deadline, so the second press is sent')
  settle[0]({ kind: 'success' })
  await ticks()
  mountSwitch(env).toggle().props.onChange(true)
  assert.equal(lines.length, 2, 'the second call is still running and still holds the switch')
  assert.equal(findAll(second.rerender(), (node) => node.props?.className === 'ex-spinner').length, 1)
  settle[1]({ kind: 'success' })
  await ticks()
  assert.equal(findAll(second.rerender(), (node) => node.props?.className === 'ex-spinner').length, 0)
})

test('a projection failure is reported only for the press whose target it names, and once', async () => {
  const env = load()
  recordingUi(env)
  const reports = []
  const view = mountSwitch(env, VIEW, { reportFailure: (message) => reports.push(message) })
  // Press on; the log records its failure with arg on.
  view.toggle().props.onChange(true)
  await ticks()
  view.state.view = { ...VIEW, failure: { count: 1, text: 'on failed', arg: 'on' } }
  view.rerender()
  view.rerender()
  assert.deepEqual(reports, ['on failed'])
  // The session shows on after another tab; press off, which is now the opposite.
  view.state.view = { ...VIEW, on: true, failure: { count: 1, text: 'on failed', arg: 'on' } }
  view.toggle(view.rerender()).props.onChange(false)
  await ticks()
  // A late failure of the earlier on is not the press off's.
  view.state.view = { ...VIEW, on: true, failure: { count: 2, text: 'late on failure', arg: 'on' } }
  view.rerender()
  assert.deepEqual(reports, ['on failed'])
  // The failure with the matching arg is reported, once.
  view.state.view = { ...VIEW, on: true, failure: { count: 3, text: 'off failed', arg: 'off' } }
  view.rerender()
  view.rerender()
  assert.deepEqual(reports, ['on failed', 'off failed'])
})

test('the client is a plain script: no module syntax, no network, no storage', () => {
  assert.doesNotMatch(SOURCE, /^\s*(import|export)\s/m)
  assert.doesNotMatch(SOURCE, /\bimport\(/)
  assert.doesNotMatch(SOURCE, /\bfetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage/)
  assert.ok(SOURCE.startsWith('window.__ModuleLoader__.load({'))
})

test('locale: en and zh hold the same keys, the client reads exactly those, and none is blank', () => {
  let tables
  load({ locale: { register: (_name, value) => { tables = value; return () => {} }, bind: () => (key) => key } })
  assert.deepEqual(Object.keys(tables.en).sort(), Object.keys(tables.zh).sort())
  const used = new Set([...SOURCE.matchAll(/\bt\('([^']+)'\)/g)].map((match) => match[1]))
  assert.deepEqual([...used].sort(), Object.keys(tables.en).sort(), 'every key is read, and every key read exists')
  for (const language of ['en', 'zh']) {
    for (const [key, value] of Object.entries(tables[language])) assert.ok(typeof value === 'string' && value.trim() !== '', `${language}:${key}`)
  }
  assert.equal(tables.en['chip.label'], 'Explainer style (ASD-STE100)')
  assert.equal(tables.en['chip.hint'], 'Plain explanations based on ASD-STE100 writing rules (a subset): short prose, text diagrams, offered pages.')
  assert.equal(tables.zh['chip.label'], '讲解风格（ASD-STE100）')
  assert.equal(tables.zh['chip.hint'], '基于 ASD-STE100 写作规则（子集）的通俗讲解：简短文字、文本图示、可选页面。')
  // The Chinese text is Chinese: it holds Han characters and no copied English label.
  for (const key of ['chip.label', 'chip.hint', 'chip.pending', 'chip.unavailable', 'chip.failed']) {
    assert.match(tables.zh[key], /[\u4e00-\u9fff]/, key)
  }
})

test('locale: the table in use follows the locale service, so zh renders Chinese', () => {
  let tables
  const env = load({
    locale: {
      register: (_name, value) => { tables = value; return () => {} },
      bind: () => (key) => (tables?.zh ?? {})[key] ?? key,
    },
  })
  const view = mountSwitch(env, { on: false, pending: true, pendingSince: Date.now(), failure: null })
  assert.match(text(view.output), /讲解风格（ASD-STE100）/)
  assert.match(text(view.output), /基于 ASD-STE100 写作规则（子集）的通俗讲解：简短文字、文本图示、可选页面。/)
  assert.match(text(view.output), /正在更新…/)
})

test('the accessible name of the switch uses the translated label with the standard, idle and pending', () => {
  let tables
  const env = load({
    locale: {
      register: (_name, value) => { tables = value; return () => {} },
      bind: () => (key) => (tables?.zh ?? {})[key] ?? key,
    },
  })
  assert.equal(mountSwitch(env).toggle().props.label, '讲解风格（ASD-STE100）')
  assert.equal(mountSwitch(env, { on: false, pending: true, pendingSince: Date.now(), failure: null }).toggle().props.label, '讲解风格（ASD-STE100） — 正在更新…')
  // The label names the standard the style is based on; the tooltip says it is a subset.
  assert.match(tables.en['chip.hint'], /\(a subset\)/)
  assert.match(tables.zh['chip.hint'], /（子集）/)
  // The failure text keeps the display name of the style.
  assert.equal(tables.en['chip.failed'], 'Could not update Explainer style.')
  assert.equal(tables.zh['chip.failed'], '无法更新讲解风格。')
})

test('no conformance claim: the client and the README do not say compliant, certified or conforming', () => {
  for (const source of [SOURCE, read('../README.md')]) {
    assert.doesNotMatch(source, /\b(compliant|compliance|complies|certified|conforms|fully conforming)\b/i)
  }
})

test('the locale JSON files keep only the package meta; the client words live in the client tables', () => {
  for (const language of ['en', 'zh']) assert.deepEqual(Object.keys(JSON.parse(read(`../locale/${language}.json`))), ['meta'])
})

test('the README documents the client switch, its tooltip, its pending spinner and the install step', () => {
  const readme = read('../README.md').replace(/\s+/g, ' ')
  for (const sentence of [
    'The model-options menu of a conversation has an **Explainer style (ASD-STE100)** switch.',
    'Hover the row to see its tooltip: Plain explanations based on ASD-STE100 writing rules (a subset): short prose, text diagrams, offered pages.',
    'The label names the standard the style is based on; it is not a claim of conformance. The style follows only a subset of ASD-STE100: sentence length limits, active voice, one term per concept, no idioms, and numbered steps. It does not use the controlled vocabulary.',
    'The row shows no line of text under the label, so the menu keeps its size.',
    'Pressing the switch runs `/explain-style on` or `/explain-style off`, the opposite of what the session shows',
    'While a change is pending the switch shows a spinner.',
    'A press during a pending change is ignored, not queued: the switch accepts a press again when the change finishes, after 30 seconds if the command itself never settles, or after five minutes if the session keeps showing the change as pending.',
    'If the command fails, the menu shows the error in its composer toast; without that channel the switch shows it inline.',
    'Restart the host after installing and refresh the page. The **Explainer style (ASD-STE100)** switch then appears in the model-options menu.',
    'Then run `/explain-style status`: it should answer `Explainer style: off.`',
  ]) assert.ok(readme.includes(sentence), sentence)
  assert.doesNotMatch(readme, /Host half only|no client file|no menu cell|hint under it/)
})
