/** The initial Ultracode and AgentTeam state for a Session with no toggle yet. */
export const INITIAL_ULTRACODE_STATE = Object.freeze({
  active: false,
  pending: null,
  commandId: null,
  teamEnabled: false,
  teamBeforeOn: null,
  teamChangedByUs: false,
})

/**
 * Fold command and Team lifecycle events into durable per-session state.
 *
 * Only successful `/ultracode on|off` commands change `active`. An error leaves
 * the last good mode alone. Team changes record whether this plugin enabled
 * AgentTeam, so off can restore the user's previous selection instead of
 * blindly disabling it.
 */
export function foldUltracode(state, event) {
  if (event.type === 'team/mode') {
    const enabled = event.data.enabled === true
    if (enabled) {
      return {
        ...state,
        teamEnabled: true,
        teamBeforeOn: state.pending === true ? state.teamEnabled : state.teamBeforeOn,
        teamChangedByUs: state.pending === true ? true : state.teamChangedByUs,
      }
    }
    return { ...state, teamEnabled: false, teamChangedByUs: false }
  }

  if (event.type === 'command/run' && event.data.name === 'ultracode') {
    const arg = typeof event.data.args === 'string' ? event.data.args.trim().toLowerCase() : ''
    if (arg !== 'on' && arg !== 'off') return state
    return {
      ...state,
      pending: arg === 'on',
      commandId: event.data.commandId,
      teamBeforeOn: arg === 'on' ? state.teamEnabled : state.teamBeforeOn,
    }
  }

  if (event.type === 'command/done' && event.data.commandId === state.commandId) {
    return {
      ...state,
      active: event.data.kind === 'success' ? state.pending : state.active,
      pending: null,
      commandId: null,
    }
  }

  return state
}

/** The wire value consumed by the composer switch and status command. */
export function viewUltracode(state) {
  return {
    active: state.active,
    pending: state.pending !== null && state.pending !== state.active,
    teamEnabled: state.teamEnabled,
  }
}
