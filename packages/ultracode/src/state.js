/** The initial Ultracode state for a Session with no toggle yet. */
export const INITIAL_ULTRACODE_STATE = Object.freeze({
  active: false,
  pending: null,
  commandId: null,
})

/**
 * Fold command lifecycle events into a durable per-session mode.
 *
 * Only successful `/ultracode on|off` commands change `active`. An error leaves
 * the last good state alone. `pending` lets the UI distinguish a selection
 * that has not settled yet, and `commandId` pairs run with done.
 */
export function foldUltracode(state, event) {
  if (event.type === 'command/run' && event.data.name === 'ultracode') {
    const arg = typeof event.data.args === 'string' ? event.data.args.trim().toLowerCase() : ''
    if (arg !== 'on' && arg !== 'off') return state
    return {
      ...state,
      pending: arg === 'on',
      commandId: event.data.commandId,
    }
  }

  if (event.type === 'command/done' && event.data.commandId === state.commandId) {
    return {
      active: event.data.kind === 'success' ? state.pending : state.active,
      pending: null,
      commandId: null,
    }
  }

  return state
}

/** The wire value consumed by the composer switch. */
export function viewUltracode(state) {
  return {
    active: state.active,
    pending: state.pending !== null && state.pending !== state.active,
  }
}
