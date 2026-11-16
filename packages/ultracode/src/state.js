export const STALE_PENDING_MS = 5 * 60_000
export const MAX_SPAWN_ATTEMPTS = 24

const DELEGATION_TOOLS = new Set([
  'subagent',
  'subagent_fork',
  'subagent_codex',
  'subagent_claude_code',
  'spawn_teammate',
])

/** The initial Ultracode state for a Session with no command yet. */
export const INITIAL_ULTRACODE_STATE = Object.freeze({
  active: false,
  pending: null,
  run: null,
})

function commandArg(event) {
  const arg = typeof event.data.args === 'string' ? event.data.args.trim().toLowerCase() : ''
  return arg === 'on' ? true : arg === 'off' ? false : null
}

function contentText(event) {
  const content = event.data.message?.content
  return Array.isArray(content) ? content.map((block) => block.text ?? '').join('\n') : ''
}

export function isDelegationTool(name) {
  return DELEGATION_TOOLS.has(name)
}

/** Fold command, turn, and delegation events into durable per-session state. */
export function foldUltracode(state, event) {
  if (event.type === 'turn/start') {
    if (!state.active || state.run?.endedAt === null) return state
    return {
      ...state,
      run: {
        turn: event.data.turn,
        startedAt: event.time ?? Date.now(),
        endedAt: null,
        spawnAttempts: 0,
        stop: null,
      },
    }
  }

  if (event.type === 'turn/end' && state.run?.turn === event.data.turn) {
    return { ...state, run: { ...state.run, endedAt: event.time ?? Date.now() } }
  }

  if (event.type === 'tool/call' && state.run?.endedAt === null && isDelegationTool(event.data.name)) {
    return {
      ...state,
      run: { ...state.run, spawnAttempts: state.run.spawnAttempts + 1 },
    }
  }

  if (event.type === 'tool/result' && state.run?.endedAt === null && isDelegationTool(event.data.name)) {
    const text = contentText(event)
    if (!text.includes('ultracode_budget_exhausted:spawns')) return state
    return { ...state, run: { ...state.run, stop: 'ultracode_budget_exhausted:spawns' } }
  }

  if (event.type === 'command/run' && event.data.name === 'ultracode') {
    const arg = commandArg(event)
    if (arg === null) return state
    if (state.pending) {
      const age = (event.time ?? Date.now()) - state.pending.startedAt
      if (state.pending.commandId !== event.data.commandId && age < STALE_PENDING_MS) return state
    }
    return {
      ...state,
      pending: {
        arg,
        commandId: event.data.commandId,
        startedAt: event.time ?? Date.now(),
      },
    }
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

/** The wire value consumed by the model-option switch and status command. */
export function viewUltracode(state) {
  return {
    active: state.active,
    pending: state.pending !== null && state.pending.arg !== state.active,
    run: state.run,
  }
}
