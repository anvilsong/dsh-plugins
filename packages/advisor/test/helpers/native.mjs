// Fakes for the native executor mount (src/executor.js): the loaded plugin and
// a cordis fiber as ctx.plugin returns it. Shared by the advisor tests; it is
// not a test file itself (the test glob is test/*.test.mjs).

export const NATIVE = Object.freeze({ plugin: Object.freeze({ name: 'native-tool-executor', inject: Object.freeze(['tools']), apply() {} }) })
export const MOUNT_ERROR = 'Only one tool executor may be registered in each scope'

/**
 * A fake cordis fiber: `state` holds the cordis state number, `then` is the
 * thenable over its start (cordis Fiber.await), `dispose` counts its calls.
 * `initial` is the state right after ctx.plugin (1, loading, by default).
 * `outcome`, one microtask later as in cordis: 'active' (state 2), 'reject'
 * (state 3, rejects with MOUNT_ERROR), 'inactive' (resolves in state 0, as
 * await() does for a missing injection) or 'never'.
 */
export function fakeFiber({ initial = 1, outcome = 'active' } = {}) {
  let resolve
  let reject
  const started = new Promise((res, rej) => { resolve = res; reject = rej })
  started.catch(() => {})
  const fiber = {
    state: initial,
    disposeCalls: 0,
    then: (onFulfilled, onRejected) => started.then(onFulfilled, onRejected),
    dispose() {
      fiber.disposeCalls++
      fiber.state = 4
      return Promise.resolve()
    },
  }
  queueMicrotask(() => {
    if (outcome === 'active') { fiber.state = 2; resolve({}) }
    if (outcome === 'reject') { fiber.state = 3; reject(new Error(MOUNT_ERROR)) }
    if (outcome === 'inactive') { fiber.state = 0; resolve({}) }
  })
  return fiber
}

/**
 * Give a fake child (a handle with `agent.ctx` and `sequence`) a ctx.plugin
 * that records `plugin:<name>` in its sequence and returns a fakeFiber.
 * `throws`: an error ctx.plugin throws synchronously instead.
 * @returns the handle, with `fibers` (one per ctx.plugin call) and `plugins`
 */
export function withPlugin(handle, { throws, ...fiberOptions } = {}) {
  handle.fibers = []
  handle.plugins = []
  handle.agent.ctx.plugin = (value) => {
    handle.sequence.push(`plugin:${value?.name}`)
    handle.plugins.push(value)
    if (throws !== undefined) throw throws
    const fiber = fakeFiber(fiberOptions)
    handle.fibers.push(fiber)
    return fiber
  }
  return handle
}

/** How often each fiber of a handle was disposed. */
export const disposals = (handle) => handle.fibers.map((fiber) => fiber.disposeCalls)
