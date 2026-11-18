// S1 spike reporter, mounted only by a scratch profile patch. It injects
// sessionQuery, names the row whose fiber provides it in this scope, runs one
// search when asked, and on request writes a snapshot of every Loader entry.
// Records go to $SPIKE_REPORT as JSON lines.

import { appendFileSync, existsSync, rmSync } from 'node:fs'

const ISOLATE = Symbol.for('cordis.isolate')
const STATES = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING']

function report(record) {
  const file = process.env.SPIKE_REPORT
  if (!file) return
  appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), pid: process.pid, ...record }) + '\n')
}

function provider(ctx) {
  const impl = ctx.reflect._getImpl('sessionQuery', false)
  if (!impl) return null
  return {
    ctor: impl.value?.constructor?.name ?? null,
    row: impl.ctx?.fiber?.entry?.options?.id ?? null,
    fiberState: STATES[impl.ctx?.fiber?.state] ?? impl.ctx?.fiber?.state,
    scope: impl.isolate?.description ?? null,
  }
}

function snapshot(ctx) {
  const loader = ctx.get('loader')
  const rows = []
  for (const entry of loader?.entries() ?? []) {
    const id = entry.options?.id
    if (!/session|spike/.test(String(id)) && !/session-query|spike/.test(String(entry.options?.name))) continue
    const fiber = entry.fiber
    rows.push({
      id: entry.id,
      name: entry.options?.name,
      disabled: entry.disabled,
      state: fiber ? STATES[fiber.state] ?? fiber.state : 'NO-FIBER',
      error: fiber?._error ? String(fiber._error?.message ?? fiber._error).split('\n')[0] : undefined,
      childEngines: fiber ? [...(fiber.ctx?.registry?.values?.() ?? [])].length : undefined,
    })
  }
  return rows
}

export const name = 'session-search-spike-reporter'

export function apply(ctx, config = {}) {
  const where = config.where ?? 'unknown'
  const scope = ctx[ISOLATE]?.sessionQuery?.description ?? null
  ctx.inject(['sessionQuery'], (inner) => {
    const found = provider(inner)
    report({ event: 'sessionQuery-up', where, scope, provider: found })
    if (config.search) {
      Promise.resolve()
        .then(() => inner.sessionQuery.searchSessions({ query: 'spike probe' }))
        .then(page => report({ event: 'search-ok', where, provider: found, items: page?.items?.length ?? page?.hits?.length ?? null }),
          error => report({ event: 'search-error', where, provider: found, code: error?.code, message: String(error?.message ?? error).split('\n')[0] }))
    }
    inner.effect(() => () => report({ event: 'sessionQuery-down', where, provider: found }), 'spike reporter down')
  })
  report({ event: 'reporter-apply', where, scope, provider: provider(ctx) })
  if (config.snapshots) {
    const trigger = process.env.SPIKE_SNAPSHOT_TRIGGER
    const timer = setInterval(() => {
      if (!trigger || !existsSync(trigger)) return
      rmSync(trigger, { force: true })
      report({ event: 'snapshot', where, provider: provider(ctx), rows: snapshot(ctx) })
    }, 500)
    ctx.effect(() => () => clearInterval(timer), 'spike reporter snapshots')
    setTimeout(() => report({ event: 'snapshot', where, auto: 'after-8s', provider: provider(ctx), rows: snapshot(ctx) }), 8000)
  }
  ctx.effect(() => () => report({ event: 'reporter-dispose', where }), 'spike reporter dispose')
}
