export const STALE_PENDING_MS = 5 * 60_000

export const INITIAL_ADVISOR_STATE = Object.freeze({
  active: false,
  verifierModel: null,
  advisorModel: null,
  pending: null,
  lastRun: null,
  failure: null,
})

export function parseRoute(value) {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return undefined
  const provider = value.slice(0, slash)
  const model = value.slice(slash + 1)
  if (provider.trim() !== provider || model.trim() !== model) return undefined
  return { provider, model }
}

/** Parse `inherit|<provider>/<model>`: null is Inherit, undefined is invalid. */
export function parseModelSetting(value) {
  if (value.toLowerCase() === 'inherit') return null
  return parseRoute(value)
}

export function routeLabel(route) {
  return route === null || route === undefined ? 'Inherit' : `${route.provider}/${route.model}`
}

function commandRequest(state, args) {
  const raw = typeof args === 'string' ? args.trim() : ''
  const arg = raw.toLowerCase()
  if (arg === '' || arg === 'on' || arg === 'off') {
    return { target: 'advisor', active: arg === '' ? !state.active : arg === 'on' }
  }
  for (const [prefix, target] of [['verifier-model ', 'verifierModel'], ['model ', 'advisorModel']]) {
    if (!arg.startsWith(prefix)) continue
    const route = parseModelSetting(raw.slice(prefix.length).trim())
    return route === undefined ? null : { target, route }
  }
  return null
}

function withFailure(state, target, event) {
  return {
    ...state,
    failure: {
      count: (state.failure?.count ?? 0) + 1,
      text: typeof event.data.text === 'string' ? event.data.text : '',
      target,
    },
  }
}

export function foldAdvisor(state, event) {
  if (event.type === 'command/run' && event.data.name === 'advisor') {
    const request = commandRequest(state, event.data.args)
    if (request === null) return state
    const lastRun = { commandId: event.data.commandId, target: request.target }
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
  if (event.type === 'command/done' && state.pending?.commandId !== event.data.commandId
    && state.lastRun?.commandId === event.data.commandId) {
    return event.data.kind === 'success' ? state : withFailure(state, state.lastRun.target, event)
  }
  // `!= null`: a state from an older projection may have no pending marker at all.
  if (event.type === 'command/done' && state.pending != null && state.pending.commandId === event.data.commandId) {
    const pending = state.pending
    const next = { ...state, pending: null }
    if (event.data.kind !== 'success') return withFailure(next, pending.target, event)
    if (pending.target === 'verifierModel') return { ...next, verifierModel: pending.route }
    if (pending.target === 'advisorModel') return { ...next, advisorModel: pending.route }
    return { ...next, active: pending.active }
  }
  return state
}

// Pure: a marker older than STALE_PENDING_MS is stale, as the fold already
// treats it (a new command takes it over).
export function pendingAdvisor(state, now = Date.now()) {
  if (state.pending === null || state.pending === undefined) return null
  return now - state.pending.startedAt < STALE_PENDING_MS ? state.pending : null
}

export function viewAdvisor(state) {
  return {
    active: state.active,
    verifierModel: state.verifierModel ?? null,
    advisorModel: state.advisorModel ?? null,
    pending: state.pending != null,
    pendingTarget: state.pending?.target ?? null,
    pendingSince: state.pending?.startedAt ?? null,
    failure: state.failure ?? null,
  }
}
