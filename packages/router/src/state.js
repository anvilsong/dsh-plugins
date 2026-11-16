export const STALE_PENDING_MS = 5 * 60_000
export const ROUTER_LEVELS = Object.freeze(['mechanical', 'ordinary', 'hard'])

export const INITIAL_ROUTER_STATE = Object.freeze({
  mode: 'off',
  selections: Object.freeze({ mechanical: null, ordinary: null, hard: null }),
  pending: null,
  lastRun: null,
  failure: null,
})

function routeFrom(value) {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return undefined
  const provider = value.slice(0, slash)
  const model = value.slice(slash + 1)
  if (provider.trim() !== provider || model.trim() !== model) return undefined
  return { provider, model }
}

function commandArg(state, args) {
  const raw = typeof args === 'string' ? args.trim() : ''
  const arg = raw.toLowerCase()
  if (arg === '') return { target: 'mode', arg: state.mode === 'manual' ? 'off' : 'manual' }
  if (arg === 'on' || arg === 'manual') return { target: 'mode', arg: 'manual' }
  if (arg === 'off') return { target: 'mode', arg: 'off' }
  if (arg.startsWith('level ')) {
    const rest = raw.slice('level '.length).trim()
    const level = rest.split(/\s+/)[0]
    if (!ROUTER_LEVELS.includes(level)) return null
    const selection = rest.slice(level.length).trim()
    if (selection === '') return null
    if (selection.toLowerCase() === 'inherit') return { target: 'level', level, routes: null }
    const parts = selection.split(',').map((part) => part.trim())
    if (parts.some((part) => part === '')) return null
    const routes = []
    for (const part of parts) {
      const route = routeFrom(part)
      if (route === undefined) return null
      routes.push(route)
    }
    return { target: 'level', level, routes }
  }
  return null
}

function withFailure(state, run, event) {
  return {
    ...state,
    failure: {
      count: (state.failure?.count ?? 0) + 1,
      text: typeof event.data.text === 'string' ? event.data.text : '',
      target: run.target,
      level: run.level ?? null,
    },
  }
}

export function foldRouter(state, event) {
  if (event.type === 'command/run' && event.data.name === 'router') {
    const request = commandArg(state, event.data.args)
    if (request === null) return state
    const lastRun = { commandId: event.data.commandId, target: request.target, level: request.level ?? null }
    if (state.pending) {
      const age = (event.time ?? Date.now()) - state.pending.startedAt
      if (state.pending.commandId !== event.data.commandId && age < STALE_PENDING_MS) return { ...state, lastRun }
    }
    return {
      ...state,
      lastRun,
      pending: { ...request, commandId: event.data.commandId, startedAt: event.time ?? Date.now() },
    }
  }
  // Every command's done event arrives here. Match only a record that exists:
  // a done event without a commandId must not match a missing one.
  if (event.type === 'command/done' && state.pending?.commandId !== event.data.commandId
    && state.lastRun != null && state.lastRun.commandId === event.data.commandId) {
    // A router command the fold did not admit (another update was pending)
    // still reports its failure so the Client can explain the rejection.
    return event.data.kind === 'success' ? state : withFailure(state, state.lastRun, event)
  }
  if (event.type === 'command/done' && state.pending != null && state.pending.commandId === event.data.commandId) {
    const pending = state.pending
    const next = { ...state, pending: null }
    if (event.data.kind !== 'success') return withFailure(next, { target: pending.target, level: pending.level ?? null }, event)
    if (pending.target === 'level') {
      if (!ROUTER_LEVELS.includes(pending.level)) return next
      return {
        ...next,
        selections: {
          ...next.selections,
          [pending.level]: pending.routes !== null && pending.routes.length > 0 ? pending.routes : null,
        },
      }
    }
    return { ...next, mode: pending.arg }
  }
  return state
}

export function pendingRouter(state, now = Date.now()) {
  if (state.pending === null) return null
  return now - state.pending.startedAt < STALE_PENDING_MS ? state.pending : null
}

// Pure: the Client compares pendingSince with its clock, because a view is
// recomputed only when the state changes, not when time passes.
export function viewRouter(state) {
  const pending = state.pending ?? null
  return {
    mode: state.mode,
    pending: pending !== null,
    pendingTarget: pending?.target ?? null,
    pendingLevel: pending?.level ?? null,
    pendingSince: pending?.startedAt ?? null,
    selections: state.selections,
    failure: state.failure ?? null,
  }
}
