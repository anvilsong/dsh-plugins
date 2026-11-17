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

// The effort is the last whitespace-separated token of the setting: a model id
// may itself contain whitespace, so the token is anchored at the end. The
// keyword is lowercase and case-sensitive.
const EFFORT_TOKEN = /^(.*\S)\s+effort=(\S*)$/

/** The trimmed setting split into its head and the effort token's value (undefined without a token). */
function splitEffort(value) {
  const setting = value.trim()
  const token = EFFORT_TOKEN.exec(setting)
  return token === null ? { head: setting, effort: undefined } : { head: token[1], effort: token[2] }
}

/**
 * Parse `inherit|<provider>/<model> [effort=<id>]`: null is Inherit,
 * undefined is invalid. The effort id is kept verbatim (no names, no case
 * folding); an empty one, or one with Inherit, is invalid. Without the token
 * the route has no effort key: the model's own default effort applies. The
 * fold and the command handler both parse with this function, so what the
 * handler checks is what the fold stores.
 */
export function parseModelSetting(value) {
  if (typeof value !== 'string') return undefined
  const { head, effort } = splitEffort(value)
  if (head.toLowerCase() === 'inherit') return effort === undefined ? null : undefined
  const route = parseRoute(head)
  if (route === undefined || effort === undefined) return route
  return effort === '' ? undefined : { ...route, effort }
}

/** Whether parseModelSetting refuses a setting because Inherit came with an effort token. */
export function inheritWithEffort(value) {
  if (typeof value !== 'string') return false
  const { head, effort } = splitEffort(value)
  return effort !== undefined && head.toLowerCase() === 'inherit'
}

/** `Inherit`, `<provider>/<model>`, or `<provider>/<model> effort=<id>`; parseModelSetting reads it back. */
export function routeLabel(route) {
  if (route === null || route === undefined) return 'Inherit'
  const label = `${route.provider}/${route.model}`
  return route.effort === undefined ? label : `${label} effort=${route.effort}`
}

/**
 * The spawn arguments a saved route requires of a subagent call: undefined
 * for Inherit (provider, model and reasoning_effort are all omitted), else its
 * exact provider and model, plus reasoning_effort only when an effort is
 * stored. The lead's policy (spawnPolicy) and both delegation guards are
 * built from it, so the prompt and the guards cannot disagree.
 */
export function spawnArgs(route) {
  if (route === null || route === undefined) return undefined
  return route.effort === undefined
    ? { provider: route.provider, model: route.model }
    : { provider: route.provider, model: route.model, reasoning_effort: route.effort }
}

/**
 * The command that keeps a route's model and drops its effort.
 * @param {'model' | 'verifier-model'} command
 */
export function effortReset(command, route) {
  return `/advisor ${command} ${route.provider}/${route.model}`
}

/**
 * The lead's instruction for the spawn arguments of a saved route, stated
 * from spawnArgs(route). The no-effort sentences are the ones used before
 * efforts existed.
 * @param {{ children?: string, command: 'model' | 'verifier-model' }} options
 *   `children`: the roles the instruction is for (omitted when the policy has
 *   one role); `command`: the setting, for the reset command.
 */
export function spawnPolicy(route, { children, command }) {
  const args = spawnArgs(route)
  if (args === undefined) {
    const omit = children === undefined ? 'Omit' : `For ${children}, omit`
    return `${omit} provider, model, reasoning_effort, and agent_preset so configured child defaults and compatible parent values apply.`
  }
  const to = children === undefined ? 'to subagent' : `to subagent for ${children}`
  if (args.reasoning_effort === undefined) {
    return `Pass exactly this provider and model ${to}, omit reasoning_effort and agent_preset so the selected model's default effort applies, and do not fall back to another route if spawning fails.`
  }
  return `Pass exactly this provider and model ${to}, pass reasoning_effort "${args.reasoning_effort}", omit agent_preset, and do not fall back to another route if spawning fails. If the spawn is rejected for the effort, report it and do not retry without it; the user can reset the effort with ${effortReset(command, route)}.`
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
