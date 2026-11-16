export const STALE_PENDING_MS = 5 * 60_000

export const INITIAL_ADVISOR_STATE = Object.freeze({ active: false, pending: null })

function commandArg(event) {
  const arg = typeof event.data.args === 'string' ? event.data.args.trim().toLowerCase() : ''
  return arg === 'on' ? true : arg === 'off' ? false : null
}

export function foldAdvisor(state, event) {
  if (event.type === 'command/run' && event.data.name === 'advisor') {
    const arg = commandArg(event)
    if (arg === null) return state
    if (state.pending) {
      const age = (event.time ?? Date.now()) - state.pending.startedAt
      if (state.pending.commandId !== event.data.commandId && age < STALE_PENDING_MS) return state
    }
    return { ...state, pending: { arg, commandId: event.data.commandId, startedAt: event.time ?? Date.now() } }
  }
  if (event.type === 'command/done' && state.pending?.commandId === event.data.commandId) {
    return {
      ...state,
      active: event.data.kind === 'success' ? state.pending.arg : state.active,
      pending: null,
    }
  }
  return state
}

export function viewAdvisor(state) {
  return { active: state.active, pending: state.pending !== null && state.pending.arg !== state.active }
}
