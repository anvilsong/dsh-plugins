export const STALE_PENDING_MS = 5 * 60_000

/** The one command name the fold reads; an exact match, never a prefix. */
export const COMMAND_NAME = 'explain-style'

/** The Explainer state of a Session with no command yet: the style is off. */
export const INITIAL_EXPLAINER_STATE = Object.freeze({
  on: false,
  pending: null,
  failure: null,
})

/**
 * `on`, `off` or `status` (the argument `status`, or none at all), any case
 * and spaces trimmed; anything else, the old `explainer` included, is null.
 * The command handler and the fold parse with this one function, so what the
 * handler accepts is what the fold stores.
 */
export function parseExplainerArg(args) {
  if (args === undefined || args === null) return 'status'
  if (typeof args !== 'string') return null
  const arg = args.trim().toLowerCase()
  if (arg === '' || arg === 'status') return 'status'
  if (arg === 'on') return 'on'
  return arg === 'off' ? 'off' : null
}

/**
 * Fold command events into the per-session switch. A change is staged on
 * `command/run` and applied on the matching successful `command/done`; a
 * failed command only records the failure. Pure: no clock is read.
 */
export function foldExplainer(state, event) {
  const { commandId } = event.data ?? {}
  if (typeof commandId !== 'string') return state

  if (event.type === 'command/run' && event.data.name === COMMAND_NAME) {
    const arg = parseExplainerArg(event.data.args)
    if (arg === null || arg === 'status') return state
    const startedAt = event.time ?? 0
    if (state.pending && state.pending.commandId !== commandId && startedAt - state.pending.startedAt < STALE_PENDING_MS) {
      return state
    }
    return { ...state, pending: { arg, commandId, startedAt } }
  }

  if (event.type === 'command/done' && state.pending?.commandId === commandId) {
    const { arg } = state.pending
    if (event.data.kind === 'success') return { on: arg === 'on', pending: null, failure: null }
    return {
      ...state,
      pending: null,
      failure: {
        count: (state.failure?.count ?? 0) + 1,
        text: typeof event.data.text === 'string' ? event.data.text : '',
        arg,
      },
    }
  }

  return state
}

/** The pending command, or null when none is pending or it has expired. */
export function pendingExplainer(state, now = Date.now()) {
  if (state.pending === null) return null
  return now - state.pending.startedAt < STALE_PENDING_MS ? state.pending : null
}

/** The wire value: pure, so a client compares `pendingSince` with its own clock. */
export function viewExplainer(state) {
  return {
    on: state.on,
    pending: state.pending !== null,
    pendingSince: state.pending?.startedAt ?? null,
    failure: state.failure,
  }
}
