/**
 * Render harness for the usage plugin's browser half (src/client.js).
 *
 * The client is a plain script handed to `window.__ModuleLoader__.load`. This
 * helper boots it inside a fresh vm context with:
 *   - a fake React: `createElement` builds `{ type, props, children }` trees and
 *     renders function components eagerly; hook state is keyed by RENDER PATH
 *     (parent path + component type + key or sibling index), so two instances
 *     of one component type keep separate state;
 *   - a stub `document` that captures the stylesheet the client inserts and
 *     dispatches document events (mousedown, keydown, ...);
 *   - stub Remote namespaces, a stub locale service, a session id and a fake
 *     model directory, all supplied by the caller.
 *
 * It uses no network and reads only src/client.js. The client runs in the
 * current realm (like the older fake renderer), so objects it creates compare
 * equal with `assert.deepStrictEqual`. `window` and `document` are installed
 * on globalThis only while client code that needs them runs. Always call
 * `dispose()`: it runs the effect cleanups that clear the poll timers.
 */

import vm from 'node:vm'
import { readFileSync } from 'node:fs'

export const CLIENT_SOURCE = readFileSync(new URL('../../src/client.js', import.meta.url), 'utf8')
export const CARD_SLOT = 'settings.models.provider-card'
export const EDITOR_SLOT = 'settings.models.provider-editor'
export const CHIP_SLOT = 'conversation.composer.dock'
export const PACKAGE_ID = 'dsh-plugin-provider-usage'

const PRIMITIVES_SPECIFIER = '@deepseek-ai/dsh-client-ui-primitives'
const PROVIDERS_DECLARATION = 'const PROVIDERS = ['
const MOUNT_LABEL = 'usage: mount remotes'

export const immediate = () => new Promise((resolve) => setImmediate(resolve))

function sameDeps(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

/** Flatten nested child arrays and drop empty children. */
export function flattenChildren(children) {
  const out = []
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
    } else if (value !== null && value !== undefined && value !== false && value !== true) {
      out.push(value)
    }
  }
  visit(children)
  return out
}

/** Depth-first visit of every element node in a tree (arrays are flattened). */
export function walk(tree, visit) {
  for (const node of flattenChildren(tree)) {
    if (typeof node !== 'object') continue
    visit(node)
    walk(node.children, visit)
  }
}

export function findAll(tree, predicate) {
  const found = []
  walk(tree, (node) => { if (predicate(node)) found.push(node) })
  return found
}

export function find(tree, predicate) {
  return findAll(tree, predicate)[0] ?? null
}

export function findByType(tree, type) {
  return find(tree, (node) => node.type === type)
}

export function findByClass(tree, className) {
  return find(tree, (node) => typeof node.props?.className === 'string' && node.props.className.split(' ').includes(className))
}

/** The first node that has `text` as one of its direct children. */
export function findByText(tree, text) {
  return find(tree, (node) => flattenChildren(node.children).includes(text))
}

/** All text below a tree, concatenated. */
export function textContent(tree) {
  let text = ''
  const visit = (value) => {
    for (const node of flattenChildren(value)) {
      if (typeof node === 'object') visit(node.children)
      else text += String(node)
    }
  }
  visit(tree)
  return text
}

/**
 * The identity of every host element in a tree, the way React matches them
 * between renders: parent identity, element type, and the key or the position
 * among the parent's children (empty slots count). An element whose path
 * differs between two renders is a different DOM node: React unmounts the old
 * one and mounts a new one, which drops focus, selection and input state.
 */
export function hostPaths(tree) {
  const out = []
  const visit = (value, prefix) => {
    const list = Array.isArray(value) ? value : [value]
    list.forEach((child, index) => {
      if (Array.isArray(child)) {
        visit(child, `${prefix}.${index}`)
        return
      }
      if (child === null || typeof child !== 'object') return
      const key = child.props?.key
      const path = `${prefix}/${String(child.type)}${key !== undefined && key !== null ? `[${key}]` : `:${index}`}`
      out.push(path)
      visit(child.children, path)
    })
  }
  visit(tree, '')
  return out
}

// ---------------------------------------------------------------------------
// Stub document
// ---------------------------------------------------------------------------

function makeEvent(type, init = {}) {
  return {
    type,
    target: null,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.propagationStopped = true },
    ...init,
  }
}

/**
 * A document stub: `head.appendChild` records inserted elements (the client's
 * stylesheet), `getElementById` finds them, and document-level event listeners
 * can be fired with `dispatch(type, init)`.
 */
export function createStubDocument() {
  const listeners = new Map()
  const byId = new Map()
  const head = {
    children: [],
    appendChild(element) {
      this.children.push(element)
      if (element.id) byId.set(element.id, element)
      element.parentNode = this
      return element
    },
    removeChild(element) {
      const index = this.children.indexOf(element)
      if (index >= 0) this.children.splice(index, 1)
      if (element.id && byId.get(element.id) === element) byId.delete(element.id)
      element.parentNode = null
      return element
    },
  }
  const document = {
    head,
    body: { children: [], appendChild(element) { this.children.push(element); return element } },
    createElement(tagName) {
      return { tagName: String(tagName).toUpperCase(), id: '', textContent: '', parentNode: null }
    },
    getElementById(id) { return byId.get(id) ?? null },
    addEventListener(type, listener) {
      if (typeof listener !== 'function') return
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
    listenerCount(type) { return listeners.get(type)?.size ?? 0 },
    /** Fire a document event (mousedown, keydown, ...) at every listener. */
    dispatch(type, init = {}) {
      const event = makeEvent(type, init)
      for (const listener of [...(listeners.get(type) ?? [])]) listener.call(document, event)
      return event
    },
    /** The textContent of every inserted `<style>` element, joined. */
    get styleText() {
      return head.children.filter((element) => element.tagName === 'STYLE').map((element) => element.textContent).join('\n')
    },
  }
  return document
}

// ---------------------------------------------------------------------------
// Fake elements for ref props
// ---------------------------------------------------------------------------

/**
 * Give every node that has a `ref` prop a fake element and assign it to the
 * ref (object `{ current }` or callback). Elements know their nearest ref'd
 * ancestor, so `contains(target)` works for outside-click tests.
 */
export function attachRefs(tree, { rect = { top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 } } = {}) {
  const attached = []
  const visit = (value, parentElement) => {
    for (const node of flattenChildren(value)) {
      if (typeof node !== 'object') continue
      let element = null
      const ref = node.props?.ref
      if (ref && typeof node.type === 'string') {
        element = {
          tagName: node.type.toUpperCase(),
          node,
          props: node.props,
          parent: parentElement,
          isConnected: true,
          focused: false,
          contains(other) {
            for (let current = other; current; current = current.parent) if (current === this) return true
            return false
          },
          getBoundingClientRect() { return { ...rect } },
          focus() { this.focused = true },
          blur() { this.focused = false },
        }
        if (typeof ref === 'function') ref(element)
        else ref.current = element
        attached.push(element)
      }
      visit(node.children, element ?? parentElement)
    }
  }
  visit(tree, null)
  return attached
}

// ---------------------------------------------------------------------------
// Fake React
// ---------------------------------------------------------------------------

function createReactRuntime() {
  let frame = null
  const typeIds = new WeakMap()
  let nextTypeId = 1

  const typeLabel = (type) => {
    let id = typeIds.get(type)
    if (!id) {
      id = nextTypeId
      nextTypeId += 1
      typeIds.set(type, id)
    }
    return `${type.displayName || type.name || 'Anonymous'}#${id}`
  }

  function currentInstance() {
    if (!frame || !frame.instance) throw new Error('hook called outside a component render')
    return frame.instance
  }

  function hookCell() {
    const instance = currentInstance()
    const index = instance.cursor
    instance.cursor += 1
    if (!instance.cells[index]) instance.cells[index] = {}
    return instance.cells[index]
  }

  function memo(cell, create, deps) {
    if (!cell.initialized || !sameDeps(cell.deps, deps)) {
      cell.value = create()
      cell.deps = deps
      cell.initialized = true
    }
    return cell.value
  }

  function effectHook(layout) {
    return (fn, deps) => {
      const cell = hookCell()
      const instance = currentInstance()
      if (cell.initialized && sameDeps(cell.deps, deps)) return
      cell.initialized = true
      cell.deps = deps
      const list = layout ? instance.runtime.pass.layoutEffects : instance.runtime.pass.effects
      list.push({ cell, fn })
    }
  }

  const React = {
    Fragment: 'fragment',
    createElement(type, props, ...children) {
      if (typeof type !== 'function') return { type, props: props ?? {}, children }
      if (!frame) throw new Error('a component element was created outside a render pass; mount it through the harness')
      const { runtime } = frame
      const { key, ...rest } = props ?? {}
      const label = typeLabel(type)
      let suffix
      if (key !== undefined && key !== null) {
        suffix = `[${key}]`
      } else {
        const count = frame.counts.get(label) ?? 0
        frame.counts.set(label, count + 1)
        suffix = `:${count}`
      }
      const path = `${frame.path}/${label}${suffix}`
      let instance = runtime.instances.get(path)
      if (!instance) {
        instance = { path, type, cells: [], cursor: 0, unmounted: false, runtime }
        runtime.instances.set(path, instance)
      }
      runtime.pass.seen.add(path)
      instance.cursor = 0
      const previous = frame
      frame = { path, counts: new Map(), instance, runtime }
      try {
        const output = type({ ...rest, children })
        // React throws when a component calls another number of hooks than on
        // its previous render (an early return above a hook, a conditional hook).
        const hooks = instance.cursor
        if (instance.hookCount !== undefined && instance.hookCount !== hooks) {
          throw new Error(`${label} called ${hooks} hooks, but ${instance.hookCount} on its previous render`)
        }
        instance.hookCount = hooks
        return output
      } finally {
        frame = previous
      }
    },
    useState(initial) {
      const cell = hookCell()
      const instance = currentInstance()
      if (!cell.initialized) {
        cell.value = typeof initial === 'function' ? initial() : initial
        cell.initialized = true
        cell.set = (next) => {
          if (instance.unmounted) return
          const value = typeof next === 'function' ? next(cell.value) : next
          if (!Object.is(value, cell.value)) {
            cell.value = value
            instance.runtime.dirty = true
          }
        }
      }
      return [cell.value, cell.set]
    },
    useEffect: effectHook(false),
    useLayoutEffect: effectHook(true),
    useMemo(fn, deps) { return memo(hookCell(), fn, deps) },
    useCallback(fn, deps) { return memo(hookCell(), () => fn, deps) },
    useRef(value) {
      const cell = hookCell()
      if (!cell.initialized) {
        cell.value = { current: value }
        cell.initialized = true
      }
      return cell.value
    },
    useId() {
      const cell = hookCell()
      const instance = currentInstance()
      if (!cell.initialized) {
        instance.runtime.idSeq += 1
        cell.value = `:u${instance.runtime.idSeq}:`
        cell.initialized = true
      }
      return cell.value
    },
  }

  function runCleanups(instance) {
    for (const cell of instance.cells) {
      if (typeof cell.cleanup === 'function') {
        const cleanup = cell.cleanup
        cell.cleanup = null
        cleanup()
      }
    }
  }

  function finishPass(runtime) {
    const { seen, effects, layoutEffects } = runtime.pass
    for (const [path, instance] of [...runtime.instances]) {
      if (seen.has(path)) continue
      instance.unmounted = true
      runCleanups(instance)
      runtime.instances.delete(path)
    }
    const pending = [...layoutEffects, ...effects]
    for (const { cell } of pending) {
      if (typeof cell.cleanup === 'function') {
        const cleanup = cell.cleanup
        cell.cleanup = null
        cleanup()
      }
    }
    for (const { cell, fn } of pending) {
      const cleanup = fn()
      cell.cleanup = typeof cleanup === 'function' ? cleanup : null
    }
  }

  /**
   * A mounted root. `render()` runs one pass (effects run after it); `settle()`
   * waits for async work and re-renders while state setters marked it dirty.
   */
  function createRoot(component, initialProps, { name = 'root', autoRefs = true } = {}) {
    const runtime = { instances: new Map(), pass: null, dirty: false, idSeq: 0 }
    let props = initialProps
    let tree = null
    let renders = 0
    let unmounted = false

    const root = {
      get tree() { return tree },
      get renders() { return renders },
      get dirty() { return runtime.dirty },
      get instancePaths() { return [...runtime.instances.keys()] },
      /** Host-element identities of the current tree (see `hostPaths`). */
      get hostPaths() { return hostPaths(tree) },
      render(nextProps) {
        if (unmounted) throw new Error('render on an unmounted root')
        if (nextProps !== undefined) props = nextProps
        runtime.dirty = false
        runtime.pass = { seen: new Set(), effects: [], layoutEffects: [] }
        const previous = frame
        frame = { path: `root:${name}`, counts: new Map(), instance: null, runtime }
        try {
          tree = React.createElement(component, props)
        } finally {
          frame = previous
        }
        renders += 1
        if (autoRefs) attachRefs(tree)
        finishPass(runtime)
        return tree
      },
      /** Wait for pending promises and re-render until two quiet rounds pass. */
      async settle({ rounds = 25, quiet = 2 } = {}) {
        let quietRounds = 0
        for (let index = 0; index < rounds && !unmounted; index += 1) {
          await immediate()
          if (runtime.dirty) {
            root.render()
            quietRounds = 0
          } else {
            quietRounds += 1
            if (quietRounds >= quiet) break
          }
        }
        return tree
      },
      attachRefs(options) { return attachRefs(tree, options) },
      unmount() {
        if (unmounted) return
        unmounted = true
        for (const instance of runtime.instances.values()) {
          instance.unmounted = true
          runCleanups(instance)
        }
        runtime.instances.clear()
        tree = null
      },
    }
    return root
  }

  return { React, createRoot }
}

// ---------------------------------------------------------------------------
// Stubs a caller can hand to bootClient
// ---------------------------------------------------------------------------

/**
 * A usage Remote namespace. Like a generated Remote client, `snapshot` and
 * `refresh` answer with a Result: `{ ok: true, value: state }`, or
 * `{ ok: false, error }` when the call itself failed (dsh-client-ui-commands
 * src/client/service.ts:423-424 reads `result.ok` / `result.value` the same
 * way). A client that forgets to unwrap would put the envelope in the store.
 *
 * Options: `refreshState` replaces the state on a refresh; `refreshFailure`
 * makes every refresh answer `{ ok: false, error: { code, message } }`;
 * `refreshGate` is a promise the refresh awaits before it answers.
 * `snapshotFailure` does the same for `snapshot`; `snapshotRejection` and
 * `refreshRejection` make the call reject with an Error of that message (the
 * transport itself failed). The four failure options are properties of the
 * stub: set one to `undefined` and the next call answers normally again.
 */
export function createUsageNamespaceStub(state, { refreshState, refreshFailure, refreshGate, snapshotFailure, snapshotRejection, refreshRejection } = {}) {
  const calls = { snapshot: 0, refresh: 0 }
  const failure = (message) => ({ ok: false, error: { code: 'remote.failed', message } })
  return {
    calls,
    state,
    snapshotFailure,
    snapshotRejection,
    refreshFailure,
    refreshRejection,
    async snapshot() {
      calls.snapshot += 1
      if (this.snapshotRejection !== undefined) throw new Error(this.snapshotRejection)
      if (this.snapshotFailure !== undefined) return failure(this.snapshotFailure)
      return { ok: true, value: this.state }
    },
    async refresh() {
      calls.refresh += 1
      if (refreshGate !== undefined) await refreshGate
      if (this.refreshRejection !== undefined) throw new Error(this.refreshRejection)
      if (this.refreshFailure !== undefined) return failure(this.refreshFailure)
      if (refreshState !== undefined) this.state = refreshState
      return { ok: true, value: this.state }
    },
  }
}

/**
 * A providerLogin namespace. `status` answers a Result, `{ ok: true, value:
 * { configured } }` (or `{ ok: false, error }`, or never answers); `begin`
 * returns a stream handle that yields `events`, waits
 * for an answer after each prompt, and then either ends, (hold) never ends, or
 * (failWith) throws that message.
 *
 * Like the real RemoteStreamHandle the handle has `dispose()`: it ends the
 * iteration quietly (no further event, no error) and is counted in
 * `disposeCalls`. `send` throws once the handle was disposed or its iteration
 * ended, as the real handle does "once the stream has terminated"
 * (dsh-typert-protocol src/types.ts:166-169). `handles` lists every stream
 * `begin` opened.
 */
export function createProviderLoginStub({ configured = false, status = 'answer', statusError, events = [], hold = false, failWith } = {}) {
  const statusCalls = []
  const beginCalls = []
  const answers = []
  const handles = []
  const stub = {
    statusCalls,
    beginCalls,
    answers,
    handles,
    get disposeCalls() { return handles.reduce((total, handle) => total + handle.disposeCount, 0) },
    async status(request) {
      statusCalls.push(request)
      if (status === 'pending') return new Promise(() => {})
      if (status === 'error') return { ok: false, error: { message: statusError ?? 'The sign-in state could not be read.' } }
      return { ok: true, value: { configured } }
    },
    begin(request) {
      beginCalls.push(request)
      let wake
      let resolveAnswer
      const handle = {
        disposed: false,
        finished: false,
        disposeCount: 0,
        send(value) {
          if (handle.disposed || handle.finished) throw new Error('RemoteStreamHandle.send: the stream has terminated')
          answers.push(value)
          resolveAnswer?.()
          resolveAnswer = undefined
        },
        dispose() {
          handle.disposeCount += 1
          handle.disposed = true
          wake?.()
          resolveAnswer?.()
        },
        async *[Symbol.asyncIterator]() {
          try {
            const stopped = new Promise((resolve) => { wake = resolve })
            for (const event of events) {
              if (handle.disposed) return
              yield event
              if (event.type === 'prompt') {
                await Promise.race([new Promise((resolve) => { resolveAnswer = resolve }), stopped])
              }
            }
            if (handle.disposed) return
            if (failWith !== undefined) throw new Error(failWith)
            if (hold) await stopped
          } finally {
            handle.finished = true
          }
        },
      }
      handles.push(handle)
      return handle
    },
  }
  return stub
}

/**
 * A fake per-session model directory: `directoryFor(sessionId).store` offers
 * getSnapshot/subscribe like the real one. `setProvider` notifies subscribers.
 */
export function createFakeModelDirectory({ provider = null } = {}) {
  let current = provider
  const subscribers = new Set()
  const requested = []
  const store = {
    getSnapshot() { return { current: current === null || current === undefined ? null : { provider: current } } },
    subscribe(listener) {
      subscribers.add(listener)
      return () => subscribers.delete(listener)
    },
  }
  return {
    requested,
    directoryFor(sessionId) {
      requested.push(sessionId)
      return { store }
    },
    setProvider(next) {
      current = next
      for (const listener of [...subscribers]) listener()
    },
  }
}

/** A minimal locale service stub. */
export function createLocaleStub({ locale = 'en', messages = {} } = {}) {
  const subscribers = new Set()
  return {
    locale,
    t(key, fallback) { return Object.prototype.hasOwnProperty.call(messages, key) ? messages[key] : (fallback ?? key) },
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener) },
  }
}

/** Default props for a provider-card occupant. */
export function cardProps(route, { oauth = false, keyConfigured = true, configured = false, ...rest } = {}) {
  return {
    provider: { provider: route, nativeAuth: { env: [], oauth } },
    configured,
    keyConfigured,
    ...rest,
  }
}

// ---------------------------------------------------------------------------
// Interaction helpers
// ---------------------------------------------------------------------------

/** Call a node's onClick, then let the mount settle. Returns the handler result. */
export async function click(mount, node, event = {}) {
  const handler = node?.props?.onClick
  if (typeof handler !== 'function') throw new Error('the node has no onClick handler')
  if (node.props.disabled) throw new Error('the node is disabled')
  const result = handler({ type: 'click', target: node, preventDefault() {}, stopPropagation() {}, ...event })
  await mount.settle()
  return result
}

/** Call a node's onChange with a target value, then let the mount settle. */
export async function change(mount, node, value) {
  const handler = node?.props?.onChange
  if (typeof handler !== 'function') throw new Error('the node has no onChange handler')
  handler({ type: 'change', target: { value }, currentTarget: { value } })
  await mount.settle()
}

// ---------------------------------------------------------------------------
// bootClient
// ---------------------------------------------------------------------------

function effectFilter(option) {
  if (option === undefined || option === 'all') return () => true
  if (option === 'none') return () => false
  if (Array.isArray(option)) return (label) => option.includes(label)
  if (typeof option === 'function') return option
  throw new Error('effects must be "all", "none", an array of labels or a function')
}

/**
 * Boot src/client.js and wire it to the stubs.
 *
 * Options:
 *   namespaces      { [remoteNamespace]: stub }  reachable as `remote.<name>` once mounted
 *                   (usage namespaces and `providerLogin`)
 *   locale          stub returned by ctx.get('locale')
 *   sessionId       default session id for chips
 *   modelDirectory  fake returned by ctx.get('modelDirectories')
 *   activeProvider  shortcut: build a fake directory whose current provider is this
 *   services        extra ctx.get(name) values
 *   primitives      host primitives (default `{ Button: 'Button' }`)
 *   mountError      make `remote.$mount` reject with this message
 *   mountGate       a promise `remote.$mount` waits for; boot does not wait for the mount then,
 *                   so a card can mount before the Remote namespaces exist (`h.mounting` settles later)
 *   effects         'all' (default) | 'none' | [labels] | (label) => boolean
 */
function withBrowserGlobals(fakeWindow, document, fn) {
  const names = { window: fakeWindow, document }
  const saved = Object.entries(names).map(([name]) => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  for (const [name, value] of Object.entries(names)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true })
  }
  try {
    return fn()
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  }
}

export async function bootClient(options = {}) {
  const {
    namespaces = {},
    locale,
    sessionId = 'session-1',
    activeProvider,
    services = {},
    primitives = { Button: 'Button' },
    mountError,
    mountGate,
    effects = 'all',
  } = options
  const modelDirectory = options.modelDirectory ?? (activeProvider !== undefined ? createFakeModelDirectory({ provider: activeProvider }) : undefined)

  if (!CLIENT_SOURCE.includes(PROVIDERS_DECLARATION)) {
    throw new Error('src/client.js no longer declares PROVIDERS in the expected form; update the harness')
  }
  const source = CLIENT_SOURCE.replace(PROVIDERS_DECLARATION, 'const PROVIDERS = globalThis.__usageProviders = [')

  const document = createStubDocument()
  const loaded = []
  const fakeWindow = { document, __ModuleLoader__: { load(value) { loaded.push(value) } } }
  withBrowserGlobals(fakeWindow, document, () => {
    vm.runInThisContext(source, { filename: 'usage/src/client.js' })
  })
  if (loaded.length !== 1 || loaded[0].id !== PACKAGE_ID) {
    throw new Error(`expected one module load for ${PACKAGE_ID}, saw ${loaded.map((entry) => entry.id).join(', ') || 'none'}`)
  }

  const { React, createRoot } = createReactRuntime()
  const exportsValue = loaded[0].factory((specifier) => {
    if (specifier === 'react') return React
    if (specifier === PRIMITIVES_SPECIFIER) return primitives
    throw new Error(`unexpected require(${JSON.stringify(specifier)}) from the client module`)
  })
  // The factory body declares PROVIDERS, so the captured table exists only now.
  const providerList = globalThis.__usageProviders
  delete globalThis.__usageProviders
  if (!Array.isArray(providerList) || providerList.length === 0) throw new Error('the PROVIDERS table was not captured')

  const slots = new Map()
  const cards = new Map()
  const editors = new Map()
  const chips = new Map()
  const mounted = []
  const getLog = []
  const entries = []
  let remoteMounted = false

  const ctx = {
    effect(fn, label) { entries.push({ fn, label }) },
    get(name) {
      getLog.push(name)
      if (name.startsWith('remote.')) return remoteMounted ? namespaces[name.slice('remote.'.length)] : undefined
      if (name === 'modelDirectories') return modelDirectory
      if (name === 'locale') return locale
      return services[name]
    },
    remote: {
      async $mount(contribution) {
        if (mountGate !== undefined) await mountGate
        if (mountError !== undefined) throw new Error(mountError)
        mounted.push(contribution)
        remoteMounted = true
        return () => { remoteMounted = false }
      },
    },
    slots: {
      register(meta, component) { return { meta, component } },
      inject(name, create) {
        const registration = create()
        const list = slots.get(name) ?? []
        list.push(registration)
        slots.set(name, list)
        if (name === CARD_SLOT) cards.set(registration.meta.key, registration.component)
        else if (name === EDITOR_SLOT) editors.set(registration.meta.key, registration.component)
        else if (name === CHIP_SLOT) chips.set(registration.meta.id, registration.component)
      },
    },
  }

  exportsValue.apply(ctx)

  // Effects run in registration order; the Remote mount is awaited so the
  // poll loops that follow already see their namespaces.
  const wanted = effectFilter(effects)
  const cleanups = []
  let mounting = Promise.resolve()
  const ranEffects = []
  const skippedEffects = []
  try {
    for (const entry of entries) {
      if (!wanted(entry.label)) {
        skippedEffects.push(entry.label)
        continue
      }
      ranEffects.push(entry.label)
      const result = withBrowserGlobals(fakeWindow, document, entry.fn)
      const register = (cleanup) => {
        if (typeof cleanup === 'function') cleanups.push(() => withBrowserGlobals(fakeWindow, document, cleanup))
      }
      if (mountGate !== undefined && entry.label === MOUNT_LABEL) {
        mounting = result.then(register)
        continue
      }
      register(result && typeof result.then === 'function' ? await result : result)
    }
  } catch (error) {
    // A failed boot must not leave poll timers running.
    for (const cleanup of cleanups.reverse()) cleanup()
    throw error
  }

  const providers = new Map(providerList.map((provider) => [provider.id, provider]))
  const stores = new Map(providerList.map((provider) => [provider.id, provider.store]))

  const roots = []
  let disposed = false

  const h = {
    React,
    exports: exportsValue,
    ctx,
    document,
    providers,
    stores,
    slots,
    cards,
    editors,
    chips,
    mounted,
    getLog,
    namespaces,
    locale,
    sessionId,
    modelDirectory,
    primitives,
    ranEffects,
    skippedEffects,
    /** Settles once the gated Remote mount (`mountGate`) finished; already settled otherwise. */
    get mounting() { return mounting },
    /** The stylesheet text the client inserted through document.head. */
    get stylesheet() { return document.getElementById('usage-plugin-styles')?.textContent ?? '' },
    /** Publish a provider state through its store (notifies every subscriber). */
    setState(providerId, state) {
      const store = stores.get(providerId)
      if (!store) throw new Error(`unknown provider ${providerId}`)
      store.set(state)
    },
    /** Mount any component under the fake renderer and let it settle. */
    async mount(component, props = {}, mountOptions = {}) {
      const root = createRoot(component, props, mountOptions)
      roots.push(root)
      root.render()
      if (mountOptions.settle !== false) await root.settle()
      return root
    },
    mountCard(settingsNamespace, props, mountOptions) {
      const component = cards.get(settingsNamespace)
      if (!component) throw new Error(`no card occupant for settings namespace ${settingsNamespace}`)
      return h.mount(component, props, { name: `card:${settingsNamespace}`, ...mountOptions })
    },
    mountChip(chipId, props = {}, mountOptions) {
      const component = chips.get(chipId)
      if (!component) throw new Error(`no dock chip with id ${chipId}`)
      return h.mount(component, { sessionId, ...props }, { name: `chip:${chipId}`, ...mountOptions })
    },
    /** Unmount every root and run every effect cleanup (this clears the poll timers). */
    dispose() {
      if (disposed) return
      disposed = true
      for (const root of roots) root.unmount()
      for (const cleanup of cleanups.reverse()) cleanup()
    },
  }
  await immediate()
  await immediate()
  return h
}
