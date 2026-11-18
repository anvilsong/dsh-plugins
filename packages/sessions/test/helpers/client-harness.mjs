// vm harness for the dsh-plugin-sessions client script (src/client.js).
//
// The client is a plain browser script: it calls window.__ModuleLoader__.load
// and receives React through the factory's require. This harness runs it in a
// fresh vm context with
// - a require stub that answers only 'react' and throws for any other module;
// - a small fake React with a real hook runtime and a recursive renderer, so a
//   test renders the whole page tree, presses buttons and reads the result.
//   `strict: true` replays every effect of a newly mounted component (all
//   cleanups, then every effect again), as React's StrictMode does after the
//   first commit (pattern of packages/router/test/client.test.mjs:22-29);
// - a fake Cordis ctx: effect, slots.inject/register, remote.$mount and get,
//   each recording what the client did and returning working disposers;
// - a fake document (head, one listener table, visibilityState), fake timers
//   and a fixed clock;
// - focus tracking: every rendered host element has a fake DOM node (focus,
//   contains, querySelectorAll over a simple selector list, isConnected,
//   disabled, tabIndex, getAttribute); focus() sets document.activeElement,
//   and a removed focused node hands focus to document.body, as browsers do.
// Nothing here touches the file system except reading the client source.
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

import { METHOD_NAMES, NAMESPACE } from '../../src/contract.js'
import { archivedPageFixture, overviewFixture, trashListFixture } from './fixtures.mjs'

export const CLIENT_URL = new URL('../../src/client.js', import.meta.url)
export const CLIENT_SOURCE = readFileSync(CLIENT_URL, 'utf8')
/** The fixtures' clock: 2026-11-17 12:00 UTC. */
export const NOW = Date.UTC(2026, 10, 17, 12, 0, 0)

/** Values built in the vm realm have another Object.prototype; compare them as JSON. */
export const plain = (value) => JSON.parse(JSON.stringify(value))
/** Drain the microtask queue and pending immediates a few times. */
export const settle = async (rounds = 4) => { for (let index = 0; index < rounds; index++) await new Promise((resolve) => setImmediate(resolve)) }

// ---------------------------------------------------------------------------
// Fake React: createElement, Fragment, useState, useRef, useMemo, useCallback,
// useEffect; nothing else, so a client that reaches for more fails loudly.
// ---------------------------------------------------------------------------

const FRAGMENT = 'Fragment'

const FOCUSABLE_TAGS = new Set(['button', 'input', 'select', 'textarea'])

/** One simple selector: a tag, attribute tests ([name] or [name="value"]), or both. */
function parseSelector(selector) {
  return String(selector).split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const match = /^([a-z][a-z0-9-]*)?((?:\[[\w-]+(?:="[^"]*")?\])*)$/i.exec(part)
    if (!match) throw new Error(`fake querySelectorAll: unsupported selector "${part}"`)
    const attributes = [...match[2].matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].map(([, name, value]) => ({ name, value }))
    return { tag: match[1]?.toLowerCase() ?? null, attributes }
  })
}

/** Host prop name for an attribute name (tabindex -> tabIndex, class -> className). */
const PROP_OF = { tabindex: 'tabIndex', class: 'className', for: 'htmlFor' }
const attributeOf = (props, name) => {
  const value = props[PROP_OF[name] ?? name]
  if (value === undefined || value === null || value === false) return null
  return value === true ? '' : String(value)
}

export function createReact({ strict = false, document = null } = {}) {
  let current = null
  let nextTypeId = 1
  const typeIds = new WeakMap()
  const typeId = (type) => {
    if (!typeIds.has(type)) typeIds.set(type, nextTypeId++)
    return typeIds.get(type)
  }
  const changed = (a, b) => a === undefined || b === undefined || a.length !== b.length || a.some((value, index) => !Object.is(value, b[index]))
  const hook = (kind) => {
    const instance = current
    if (instance === null) throw new Error(`${kind} hook called outside a component render`)
    instance.trace.push(kind)
    const index = instance.index++
    return { instance, index }
  }

  const React = {
    Fragment: FRAGMENT,
    createElement(type, props, ...children) {
      if (type === undefined || type === null) throw new TypeError(`createElement: invalid element type ${type}`)
      return { type, key: props?.key ?? null, props: props ?? {}, children }
    },
    useState(initial) {
      const { instance, index } = hook('state')
      if (!(index in instance.hooks)) {
        const slot = { value: typeof initial === 'function' ? initial() : initial }
        slot.set = (next) => {
          const value = typeof next === 'function' ? next(slot.value) : next
          if (Object.is(value, slot.value)) return
          slot.value = value
          if (instance.unmounted) { instance.root.stats.setAfterUnmount++; return }
          instance.root.schedule()
        }
        instance.hooks[index] = slot
      }
      const slot = instance.hooks[index]
      return [slot.value, slot.set]
    },
    useRef(initial) {
      const { instance, index } = hook('ref')
      if (!(index in instance.hooks)) instance.hooks[index] = { current: initial }
      return instance.hooks[index]
    },
    useMemo(factory, deps) {
      const { instance, index } = hook('memo')
      const slot = instance.hooks[index]
      if (slot === undefined || changed(slot.deps, deps)) instance.hooks[index] = { value: factory(), deps }
      return instance.hooks[index].value
    },
    useCallback(callback, deps) {
      const { instance, index } = hook('callback')
      const slot = instance.hooks[index]
      if (slot === undefined || changed(slot.deps, deps)) instance.hooks[index] = { value: callback, deps }
      return instance.hooks[index].value
    },
    useEffect(effect, deps) {
      const { instance, index } = hook('effect')
      if (!(index in instance.hooks)) instance.hooks[index] = { effect: true, deps: undefined, cleanup: undefined, mounted: false }
      const slot = instance.hooks[index]
      instance.latest[index] = effect
      if (!slot.mounted || changed(slot.deps, deps)) instance.pending.push({ index, effect, deps })
    },
  }

  const runEffect = (instance, index, effect) => {
    const result = effect()
    if (result !== undefined && typeof result !== 'function') throw new TypeError('an effect must return a cleanup function or nothing (an async effect returns a promise)')
    return result
  }

  function createRoot(element) {
    const instances = new Map()
    const nodes = new Map()
    let scheduled = false
    let rendering = false
    let dirty = false
    const root = {
      tree: [],
      components: [],
      focused: [],
      /** The fake DOM node that last received focus in this root, while it is connected. */
      activeElement: null,
      stats: { renders: 0, setAfterUnmount: 0 },
      unmounted: false,
      schedule() {
        dirty = true
        if (rendering || scheduled || root.unmounted) return
        scheduled = true
        queueMicrotask(() => {
          scheduled = false
          if (dirty && !root.unmounted) commit()
        })
      },
      /** Render (again), optionally with a new root element. */
      render(next) {
        if (next !== undefined) element = next
        root.unmounted = false
        commit()
        return root
      },
      unmount() {
        for (const instance of instances.values()) unmountInstance(instance)
        instances.clear()
        for (const node of nodes.values()) node.isConnected = false
        nodes.clear()
        if (root.activeElement) {
          if (document && document.activeElement === root.activeElement) document.activeElement = document.body ?? null
          root.activeElement = null
        }
        root.tree = []
        root.components = []
        root.unmounted = true
      },
      findAll: (predicate) => findAll(root.tree, predicate),
      find: (predicate) => findAll(root.tree, predicate)[0],
      text: (node) => textOf(node ?? root.tree),
      /** Latest props of the rendered components called `name`. */
      componentProps: (name) => root.components.filter((entry) => entry.name === name).map((entry) => entry.props),
    }

    const unmountInstance = (instance) => {
      instance.unmounted = true
      for (const slot of instance.hooks) if (slot?.effect) { const cleanup = slot.cleanup; slot.cleanup = undefined; cleanup?.() }
    }

    // One fake DOM node per rendered host element, kept by tree path while the
    // element stays at that path with the same tag (React keeps its DOM node).
    const hostNodes = new WeakMap()
    let order = 0
    const fakeNode = (path, type, props) => {
      let node = nodes.get(path)
      if (!node || node.type !== type) {
        if (node) node.isConnected = false
        node = {
          path,
          type,
          props: {},
          order: 0,
          isConnected: true,
          inertAncestor: false,
          get disabled() { return node.props.disabled === true },
          get tabIndex() {
            if (typeof node.props.tabIndex === 'number') return node.props.tabIndex
            return FOCUSABLE_TAGS.has(node.type) || (node.type === 'a' && node.props.href) ? 0 : -1
          },
          getAttribute(name) { return name === 'id' ? (node.id ?? null) : attributeOf(node.props, name) },
          hasAttribute(name) { return node.getAttribute(name) !== null },
          contains(other) { return other === node || (other !== null && typeof other?.path === 'string' && other.path.startsWith(`${node.path}.`)) },
          querySelectorAll(selector) {
            const tests = parseSelector(selector)
            return [...nodes.values()]
              .filter((candidate) => candidate.isConnected && candidate !== node && node.contains(candidate))
              .filter((candidate) => tests.some((test) => (test.tag === null || test.tag === candidate.type)
                && test.attributes.every(({ name, value }) => {
                  const actual = candidate.getAttribute(name)
                  return actual !== null && (value === undefined || actual === value)
                })))
              .sort((a, b) => a.order - b.order)
          },
          focus() {
            if (!node.isConnected) return // a browser ignores focus() on a removed node
            root.focused.push(node.id ?? node.path)
            root.activeElement = node
            if (document) document.activeElement = node
          },
          blur() {
            if (root.activeElement === node) root.activeElement = null
            if (document && document.activeElement === node) document.activeElement = document.body ?? null
          },
        }
        nodes.set(path, node)
      }
      node.id = props.id
      return node
    }
    /** The fake DOM node of a rendered host element (from find/findAll), or undefined. */
    root.nodeOf = (host) => hostNodes.get(host)
    /** The fake DOM node rendered with this id, or undefined. */
    root.nodeById = (id) => [...nodes.values()].find((node) => node.isConnected && node.id === id)

    function resolveList(list, path, pass) {
      const out = []
      list.forEach((child, index) => {
        if (Array.isArray(child)) { out.push(...resolveList(child, `${path}.${index}`, pass)); return }
        const key = child !== null && typeof child === 'object' && child.key !== null && child.key !== undefined ? `k${child.key}` : String(index)
        out.push(...resolve(child, `${path}.${key}`, pass))
      })
      return out
    }

    function resolve(node, path, pass) {
      if (node === null || node === undefined || typeof node === 'boolean') return []
      if (typeof node === 'string' || typeof node === 'number') return [String(node)]
      if (Array.isArray(node)) return resolveList(node, path, pass)
      if (typeof node !== 'object' || !('type' in node)) throw new TypeError(`cannot render ${Object.prototype.toString.call(node)}`)
      const { type, props, children } = node
      const kids = children.length > 0 ? children : props.children === undefined ? [] : [props.children]
      if (type === FRAGMENT) return resolveList(kids, path, pass)
      if (typeof type === 'function') {
        const id = `${path}:${typeId(type)}`
        let instance = instances.get(id)
        if (!instance) {
          instance = { root, id, type, hooks: [], latest: [], kinds: null, trace: [], index: 0, pending: [], fresh: true, unmounted: false }
          instances.set(id, instance)
        }
        pass.visited.add(id)
        const merged = { ...props }
        delete merged.key
        if (children.length === 1) merged.children = children[0]
        else if (children.length > 1) merged.children = children
        const previous = current
        current = instance
        instance.index = 0
        instance.trace = []
        instance.pending = []
        let output
        try { output = type(merged) } finally { current = previous }
        if (instance.kinds !== null && instance.kinds.join() !== instance.trace.join()) {
          throw new Error(`hook order changed in ${type.name || 'a component'}: ${instance.kinds.join()} -> ${instance.trace.join()}`)
        }
        instance.kinds = instance.trace
        pass.components.push({ name: type.name, type, props: merged })
        const resolved = resolve(output, `${id}>`, pass)
        pass.rendered.push(instance)
        return resolved
      }
      if (typeof type !== 'string') throw new TypeError(`invalid element type ${String(type)}`)
      const hostProps = { ...props }
      delete hostProps.key
      delete hostProps.ref
      delete hostProps.children
      const dom = fakeNode(path, type, props)
      dom.props = hostProps
      dom.order = order++
      dom.isConnected = true
      pass.hosts.add(path)
      if (typeof props.ref === 'function') props.ref(dom)
      else if (props.ref && typeof props.ref === 'object') props.ref.current = dom
      const host = { type, props: hostProps, children: resolveList(kids, path, pass) }
      hostNodes.set(host, dom)
      return [host]
    }

    function commit() {
      for (let round = 0; ; round++) {
        if (round > 50) throw new Error('render loop: state keeps changing after every commit')
        dirty = false
        rendering = true
        const pass = { visited: new Set(), components: [], rendered: [], hosts: new Set() }
        order = 0
        try {
          root.tree = resolve(element, 'r', pass)
        } finally {
          rendering = false
        }
        root.components = pass.components
        root.stats.renders++
        // Host nodes that left the tree are disconnected; a focused one hands focus to the body.
        for (const [path, node] of nodes) {
          if (pass.hosts.has(path)) continue
          node.isConnected = false
          nodes.delete(path)
        }
        if (root.activeElement && !root.activeElement.isConnected) {
          if (document && document.activeElement === root.activeElement) document.activeElement = document.body ?? null
          root.activeElement = null
        }
        for (const [id, instance] of instances) {
          if (!pass.visited.has(id)) { unmountInstance(instance); instances.delete(id) }
        }
        for (const instance of pass.rendered) {
          for (const { index, effect, deps } of instance.pending) {
            const slot = instance.hooks[index]
            const cleanup = slot.cleanup
            slot.cleanup = undefined
            cleanup?.()
            slot.cleanup = runEffect(instance, index, effect)
            slot.deps = deps
            slot.mounted = true
          }
          instance.pending = []
        }
        if (strict) {
          for (const instance of pass.rendered) {
            if (!instance.fresh) continue
            for (const slot of instance.hooks) if (slot?.effect) { const cleanup = slot.cleanup; slot.cleanup = undefined; cleanup?.() }
            instance.hooks.forEach((slot, index) => { if (slot?.effect) slot.cleanup = runEffect(instance, index, instance.latest[index]) })
          }
        }
        for (const instance of pass.rendered) instance.fresh = false
        if (!dirty) return
      }
    }

    return root
  }

  return { React, createRoot }
}

// ---------------------------------------------------------------------------
// Tree helpers.
// ---------------------------------------------------------------------------

export function findAll(node, predicate, found = []) {
  if (Array.isArray(node)) { for (const child of node) findAll(child, predicate, found); return found }
  if (node === null || typeof node !== 'object') return found
  if (predicate(node)) found.push(node)
  for (const child of node.children ?? []) findAll(child, predicate, found)
  return found
}

export function textOf(node) {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node === null || typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join('')
}

export const byRole = (root, role) => root.findAll((node) => node.props?.role === role)
export const byClass = (root, name) => root.findAll((node) => typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes(name))

/** A minimal event object for a handler prop. */
export const event = (extra = {}) => ({
  defaultPrevented: false,
  propagationStopped: false,
  preventDefault() { this.defaultPrevented = true },
  stopPropagation() { this.propagationStopped = true },
  target: { value: '' },
  ...extra,
})

// ---------------------------------------------------------------------------
// Fakes for the page environment.
// ---------------------------------------------------------------------------

export function createDocument() {
  const listeners = new Map()
  const head = {
    children: [],
    appendChild(element) { head.children.push(element); element.parentNode = head; return element },
    removeChild(element) {
      const at = head.children.indexOf(element)
      if (at >= 0) head.children.splice(at, 1)
      element.parentNode = null
      return element
    },
  }
  const body = { tagName: 'BODY', type: 'body', id: '', isConnected: true, focus() { document.activeElement = body }, contains: () => true }
  const document = {
    head,
    body,
    /** Focus tracking: a rendered node's focus() sets it; a removed focused node hands it back to body. */
    activeElement: body,
    visibilityState: 'visible',
    domWrites: 0,
    createElement(tag) { document.domWrites++; return { tagName: String(tag).toUpperCase(), id: '', textContent: '', parentNode: null } },
    getElementById(id) { return head.children.find((element) => element.id === id) ?? null },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(listener)
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
    listenerCount(type) { return listeners.get(type)?.size ?? 0 },
    setVisibility(state) {
      document.visibilityState = state
      for (const listener of [...(listeners.get('visibilitychange') ?? [])]) listener({ type: 'visibilitychange' })
    },
  }
  return document
}

export function createTimers() {
  let now = 0
  let nextId = 1
  const active = new Map()
  const timers = {
    get now() { return now },
    get count() { return active.size },
    list: () => [...active.values()].map(({ at, interval }) => ({ at, interval })),
    setTimeout(callback, ms = 0) { const id = nextId++; active.set(id, { at: now + Math.max(0, Number(ms) || 0), callback, interval: null }); return id },
    clearTimeout(id) { active.delete(id) },
    setInterval(callback, ms = 0) { const step = Math.max(1, Number(ms) || 0); const id = nextId++; active.set(id, { at: now + step, callback, interval: step }); return id },
    clearInterval(id) { active.delete(id) },
    /** Move the clock forward, firing every timer that comes due, in order. */
    advance(ms) {
      const end = now + ms
      for (;;) {
        let dueId = null
        let due = null
        for (const [id, timer] of active) if (timer.at <= end && (due === null || timer.at < due.at)) { dueId = id; due = timer }
        if (due === null) break
        now = due.at
        if (due.interval === null) active.delete(dueId)
        else due.at = now + due.interval
        due.callback()
      }
      now = end
    },
  }
  return timers
}

/**
 * A fake locale service. `mode: 'en' | 'zh'` translates from the registered
 * dictionaries; `mode: 'marker'` returns ⟦key⟧ for every key, so any text that
 * did not come from t() stands out.
 */
export function createLocale({ mode = 'en', registerThrows = false, bindThrows = false } = {}) {
  const locale = {
    mode,
    registered: [],
    disposed: 0,
    register(ns, dictionaries) {
      if (registerThrows) throw new Error('locale register failed')
      const entry = { ns, dictionaries, disposed: false }
      locale.registered.push(entry)
      return () => { entry.disposed = true; locale.disposed++ }
    },
    bind(ns) {
      if (bindThrows) throw new Error('locale bind failed')
      return (key) => {
        if (locale.mode === 'marker') return `⟦${key}⟧`
        const entry = locale.registered.find((item) => item.ns === ns && !item.disposed)
        return entry?.dictionaries?.[locale.mode]?.[key] ?? key
      }
    },
    dictionaries(ns) { return locale.registered.find((item) => item.ns === ns)?.dictionaries },
  }
  return locale
}

/**
 * A fake `remote.sessionsManager`: one function per contract method, each
 * recording { method, request } and answering through `handlers[method]`.
 * The default overview, archived and trash answer with a RemoteResult around
 * overviewFixture(), archivedPageFixture() and trashListFixture(); the
 * mutating methods and plan have no default (a test names what they answer).
 */
export function createApi(handlers = {}) {
  const calls = []
  const api = {}
  const all = {
    overview: async () => ({ ok: true, value: overviewFixture() }),
    archived: async () => ({ ok: true, value: archivedPageFixture() }),
    trash: async () => ({ ok: true, value: trashListFixture() }),
    ...handlers,
  }
  for (const method of METHOD_NAMES) {
    api[method] = (request) => {
      calls.push({ method, request: plain(request ?? null) })
      const handler = all[method]
      if (!handler) return Promise.resolve({ ok: false, error: { code: 'test/unhandled', message: `no handler for ${method}` } })
      return handler(request, calls)
    }
  }
  return { api, calls }
}

/**
 * Load the client in a fresh vm context and run its apply.
 * Options:
 *   strict        replay effects of newly mounted components (React StrictMode)
 *   locale        a createLocale() service, or undefined for no locale service
 *   api           a createApi() result (default: createApi())
 *   mount         custom $mount(contribution) implementation
 *   noRemote      ctx.remote is undefined
 *   namespace     false: the mount resolves but ctx.get('remote.sessionsManager') is undefined
 *   getThrows     ctx.get keys whose read throws
 *   injectThrows  slots.inject throws
 *   apply         false: do not run apply (call env.apply(ctx) yourself)
 *   usePanelInfo  null to omit the prop, or a function; default reads env.activePanelId
 */
export function loadClient(options = {}) {
  const timers = createTimers()
  const document = createDocument()
  const fake = createReact({ strict: options.strict === true, document })
  const { api, calls } = options.api ?? createApi()
  const env = {
    id: null,
    result: null,
    requires: [],
    effects: [],
    effectErrors: [],
    injects: [],
    registrations: [],
    mounts: [],
    mountDisposals: 0,
    gets: [],
    consoleErrors: [],
    applyError: null,
    applyReturn: undefined,
    activePanelId: 'sessions-manager',
    api,
    calls,
    timers,
    document,
    locale: options.locale,
    React: fake.React,
    roots: [],
  }

  let mounted = false
  const defaultMount = async (contribution) => {
    env.mounts.push(contribution)
    mounted = true
    return () => { env.mountDisposals++; mounted = false }
  }
  const remote = options.noRemote ? undefined : { $mount: options.mount ? (contribution) => { env.mounts.push(contribution); return options.mount(contribution) } : defaultMount }

  env.ctx = {
    remote,
    get(key) {
      env.gets.push(key)
      if (options.getThrows?.includes(key)) throw new Error(`ctx.get(${key}) failed`)
      if (key === 'locale') return options.locale
      if (key === `remote.${NAMESPACE}`) return (mounted || options.mount) && options.namespace !== false ? api : undefined
      return options.services?.[key]
    },
    slots: {
      inject(name, callback) {
        if (options.injectThrows) throw new Error('slots.inject failed')
        const entry = { name, cleanup: undefined, returned: undefined }
        env.injects.push(entry)
        entry.returned = callback()
        if (typeof entry.returned === 'function') entry.cleanup = entry.returned
        return () => entry.cleanup?.()
      },
      register(definition, component) {
        const entry = { definition, component, disposed: false }
        env.registrations.push(entry)
        return () => { entry.disposed = true }
      },
    },
    effect(callback, label) {
      const entry = { label, cleanup: undefined, promise: null, disposed: false }
      env.effects.push(entry)
      const result = callback()
      if (result && typeof result.then === 'function') {
        entry.promise = Promise.resolve(result).then(
          (cleanup) => { entry.cleanup = cleanup },
          (error) => { env.effectErrors.push(error) },
        )
      } else {
        entry.cleanup = result
      }
      return () => env.disposeEffect(entry)
    },
  }

  env.disposeEffect = async (entry) => {
    if (entry.disposed) return
    entry.disposed = true
    if (entry.promise) await entry.promise
    if (typeof entry.cleanup === 'function') entry.cleanup()
  }

  /** Unload the plugin: every effect and inject cleanup, in reverse order. */
  env.unload = async () => {
    for (const root of env.roots) root.unmount()
    for (const entry of [...env.effects].reverse()) await env.disposeEffect(entry)
    for (const entry of [...env.injects].reverse()) entry.cleanup?.()
  }

  env.require = (name) => {
    env.requires.push(name)
    if (name === 'react') return fake.React
    throw new Error(`the sessions client may require only 'react', not '${name}'`)
  }

  class TestDate extends Date {
    static now() { return NOW + timers.now }
  }

  const context = vm.createContext({
    window: {
      __ModuleLoader__: {
        load({ id, factory }) {
          env.id = id
          env.result = factory(env.require)
        },
      },
    },
    document,
    Date: TestDate,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    console: { error: (...args) => env.consoleErrors.push(args), warn: () => {}, log: () => {}, info: () => {} },
  })
  vm.runInContext(CLIENT_SOURCE, context, { filename: 'client.js' })

  env.apply = (ctx = env.ctx) => {
    try {
      env.applyReturn = env.result.apply(ctx)
    } catch (error) {
      env.applyError = error
    }
  }
  if (options.apply !== false) env.apply()

  env.registration = (name) => env.registrations.find((entry) => entry.definition.name === name)

  /**
   * Move the fake clock forward by `ms` (firing due timers, such as the
   * Archived tab's request timer), then let promises and renders settle.
   */
  env.advance = async (ms = 0) => {
    timers.advance(ms)
    await settle()
  }

  /** Render the registered `main` component (the page) and return its root. */
  env.renderPage = (props = {}) => {
    const main = env.registration('main')
    if (!main) throw new Error('no main registration')
    const usePanelInfo = options.usePanelInfo === null
      ? undefined
      : options.usePanelInfo ?? ((selector) => selector({ activePanelId: env.activePanelId }))
    const root = fake.createRoot(fake.React.createElement(main.component, { ...(usePanelInfo ? { usePanelInfo } : {}), ...props }))
    env.roots.push(root)
    return root.render()
  }

  return env
}
