// Fake engine classes and a fake host loader set for the entry tests.
//
// The engines extend the real cordis Service (the repository's
// node_modules/@deepseek-ai/cordis 4.1.0) and register `sessionQuery` exactly
// like SessionQueryEngine of rc.3 does (`super(ctx, 'sessionQuery')`), with the
// same `inject` list. No host package is imported. Every step is recorded in a
// shared journal so a test can tell which engine was tried, which config it
// received, whether it started and whether it was disposed.

import { Service } from '@deepseek-ai/cordis'

/** @returns {{ attempts: string[], constructed: string[], configs: {role: string, config: unknown}[], inits: string[], disposed: string[], searches: {role: string, request: unknown}[] }} */
export function createJournal() {
  return { attempts: [], constructed: [], configs: [], inits: [], disposed: [], searches: [] }
}

const CLASS_NAMES = { patched: 'FakePatchedEngine', shipped: 'FakeShippedEngine', other: 'FakeOtherRowEngine' }

/**
 * A fake engine class.
 * @param {'patched'|'shipped'|'other'} role
 * @param {ReturnType<typeof createJournal>} journal
 * @param {{ throwBeforeSuper?: boolean, throwAfterSuper?: boolean, initError?: Error, searchError?: Error }} [behavior]
 */
export function makeEngine(role, journal, behavior = {}) {
  const className = CLASS_NAMES[role] ?? `Fake${role}Engine`
  const holder = {
    [className]: class extends Service {
      static inject = ['sessions']

      constructor(ctx, config) {
        journal.attempts.push(role)
        if (behavior.throwBeforeSuper) throw new Error(`${className}: constructor failed before super`)
        super(ctx, 'sessionQuery')
        journal.constructed.push(role)
        journal.configs.push({ role, config })
        ctx.effect(() => () => { journal.disposed.push(role) }, `${className} dispose`)
        if (behavior.throwAfterSuper) throw new Error(`${className}: constructor failed after super`)
      }

      async [Service.init]() {
        journal.inits.push(role)
        if (behavior.initError) throw behavior.initError
      }

      async searchSessions(request) {
        journal.searches.push({ role, request })
        if (behavior.searchError) throw behavior.searchError
        return { items: [], engine: role }
      }
    },
  }
  return holder[className]
}

/** sha256 values the guard pins (rc.3 sources, docs/spike/guard-inputs.txt). */
export const RC3_SOURCES = Object.freeze({
  'src/index.ts': '72868e4ae967fee94967df5939ee092a582249ff7b37afc4fe0cf7660d48b8d3',
  'src/query.ts': 'b29363581b715a1eb50509d7c5ff039d7d4004926160cd88ffcbadaa44ca1c48',
  'src/schema.ts': '2cc4c7c8e50409847599a048922d55ef4ffbd1ac2309502f3a5a06420bc1a28f',
})

/**
 * The loader set the entry's apply() takes as its third argument in tests.
 * @param {{ Patched?: Function, Shipped?: Function, patchedModule?: object, shippedModule?: object,
 *   patchedError?: Error, shippedError?: Error, sources?: unknown, sourcesError?: Error,
 *   patchedGate?: Promise<void> }} options
 */
export function makeHost(options = {}) {
  const calls = { loadPatched: 0, loadShipped: 0, readShippedSources: 0 }
  const host = {
    async loadPatched() {
      calls.loadPatched++
      if (options.patchedGate) await options.patchedGate
      if (options.patchedError) throw options.patchedError
      return options.patchedModule ?? { default: options.Patched }
    },
    async loadShipped() {
      calls.loadShipped++
      if (options.shippedError) throw options.shippedError
      return options.shippedModule ?? { default: options.Shipped }
    },
    readShippedSources() {
      calls.readShippedSources++
      if (options.sourcesError) throw options.sourcesError
      return 'sources' in options ? options.sources : { ...RC3_SOURCES }
    },
  }
  return { host, calls }
}

/** An error shaped like a failed bare import. */
export function moduleNotFound(specifier) {
  const error = new Error(`Cannot find package '${specifier}' imported from /fake/src/index.host.js`)
  error.code = 'ERR_MODULE_NOT_FOUND'
  return error
}
