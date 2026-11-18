// A real cordis Context laid out like the rc.3 host around the new row.
//
// root                     fake `sessions` (the engines' only inject) and, unless
//                          told otherwise, a fake `pluginPackages` whose
//                          packageOf() reports the given engine version
// group                    root.isolate('sessionQuery', Symbol('sessionQuery#optional-session-search')),
//                          the scope the loader gives the rows of the group
//                          optional-session-search (docs/composition-spike.md §8)
//
// Log messages of every logger are collected; lines() returns those that start
// with `session-search-patched:`.

import { Context } from '@deepseek-ai/cordis'

export const GROUP_SCOPE = 'sessionQuery#optional-session-search'
export const LINE_PREFIX = 'session-search-patched:'
export const ENGINE_PACKAGE = '@deepseek-ai/dsh-session-query-sqlite'
/** The row config of the bundle patch (docs/composition-spike.md §4). */
export const ROW_CONFIG = Object.freeze({ path: ':memory:', openAt: 'first-search', persistedReadConcurrency: 1 })

/** cordis FiberState values (fiber.ts:147-154). */
export const STATE = Object.freeze({ PENDING: 0, LOADING: 1, ACTIVE: 2, FAILED: 3, DISPOSED: 4, UNLOADING: 5 })

const fakeSessions = Object.freeze({ list: () => [], get: () => undefined })

/**
 * @param {{ version?: unknown, packages?: 'ok'|'none'|'throws'|'no-entry'|'not-a-function', sessions?: boolean }} [options]
 */
export function createWorld(options = {}) {
  // `version: undefined` is a case of its own (an entry without a version), so no destructuring default.
  const version = 'version' in options ? options.version : '0.2.2-rc.3'
  const { packages = 'ok', sessions = true } = options
  const root = new Context()
  const messages = []
  root.logger.exporter({ levels: { default: 3 }, export: (message) => messages.push(message) })
  if (sessions) root.provide('sessions', fakeSessions)
  const packageCalls = []
  if (packages === 'ok') {
    root.provide('pluginPackages', {
      packageOf(name, importer) {
        packageCalls.push({ name, importer })
        return { name, version }
      },
    })
  } else if (packages === 'throws') {
    root.provide('pluginPackages', {
      packageOf(name, importer) {
        packageCalls.push({ name, importer })
        throw new Error('packageOf failed in the fake host')
      },
    })
  } else if (packages === 'no-entry') {
    root.provide('pluginPackages', {
      packageOf(name, importer) {
        packageCalls.push({ name, importer })
        return undefined
      },
    })
  } else if (packages === 'not-a-function') {
    root.provide('pluginPackages', { packageOf: 'not a function' })
  }
  const label = Symbol(GROUP_SCOPE)
  const group = root.isolate('sessionQuery', label)
  const rows = []

  return {
    root,
    group,
    label,
    messages,
    packageCalls,
    rows,
    /** Lines of this plugin: messages whose first argument starts with the prefix. */
    lines() {
      return messages
        .filter((message) => typeof message.args[0] === 'string' && message.args[0].startsWith(LINE_PREFIX))
        .map((message) => ({ type: message.type, name: message.name, text: message.args[0], extraArgs: message.args.length - 1 }))
    },
    /** Every registered `sessionQuery` implementation, in any scope. */
    providers() {
      return Reflect.ownKeys(root.reflect.store)
        .map((key) => root.reflect.store[key])
        .filter((impl) => impl.name === 'sessionQuery')
    },
    /** Mount a plugin as a row of `scope` and wait until it settled; an explicit undefined config stays undefined. */
    async mount(plugin, ...args) {
      const config = args.length > 0 ? args[0] : ROW_CONFIG
      const scope = args[1] ?? group
      const fiber = scope.plugin(plugin, config)
      rows.push(fiber)
      await fiber
      return fiber
    },
    /** Dispose every row mounted through mount(). */
    async close() {
      for (const fiber of rows.splice(0).reverse()) {
        try { await fiber.dispose() } catch { /* already gone */ }
      }
    },
  }
}

/** Wait for queued microtasks and two macrotask turns (unhandled rejections surface by then). */
export async function settle() {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** A deep copy that is frozen at every level (proves that nobody mutates it). */
export function deepFrozen(value) {
  const copy = structuredClone(value)
  const freeze = (object) => {
    if (object && typeof object === 'object') {
      for (const key of Object.keys(object)) freeze(object[key])
      Object.freeze(object)
    }
    return object
  }
  return freeze(copy)
}
