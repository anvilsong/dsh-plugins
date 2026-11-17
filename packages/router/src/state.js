export const STALE_PENDING_MS = 5 * 60_000
export const ROUTER_LEVELS = Object.freeze(['mechanical', 'ordinary', 'hard'])
// A shortlist entry's effort id, kept verbatim: what a command token, the
// lead's shortlist line and a menu chip can carry unchanged (no whitespace,
// commas, quotes or brackets). Ids are not checked against the model.
export const EFFORT_ID = /^[A-Za-z0-9._-]{1,32}$/

export const INITIAL_ROUTER_STATE = Object.freeze({
  mode: 'off',
  selections: Object.freeze({ mechanical: null, ordinary: null, hard: null }),
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

const EFFORT_KEYWORD = 'effort='
// Any spelling of the keyword marks an effort token, so a misspelled one is
// malformed rather than read as part of a model id; only lowercase is valid.
const isEffortToken = (token) => token.slice(0, EFFORT_KEYWORD.length).toLowerCase() === EFFORT_KEYWORD

/**
 * Split one trimmed entry into its route text and its effort id: effort null
 * without a token; undefined for a malformed entry. The token is the entry's
 * last whitespace-separated token and may appear once, so a model id may
 * still contain inner spaces.
 */
function splitEffort(entry) {
  const tokens = entry.split(/\s+/)
  const marked = tokens.filter(isEffortToken)
  if (marked.length === 0) return { head: entry, effort: null }
  const last = tokens[tokens.length - 1]
  if (marked.length > 1 || !last.startsWith(EFFORT_KEYWORD)) return undefined
  const effort = last.slice(EFFORT_KEYWORD.length)
  if (!EFFORT_ID.test(effort)) return undefined
  return { head: entry.slice(0, entry.length - last.length).trim(), effort }
}

/** One entry, `<provider>/<model>[ effort=<id>]`: `{ provider, model, effort? }` or undefined. */
function parseEntry(text) {
  if (text === '') return undefined
  const split = splitEffort(text)
  if (split === undefined) return undefined
  const route = parseRoute(split.head)
  if (route === undefined) return undefined
  return split.effort === null ? route : { ...route, effort: split.effort }
}

/**
 * Parse the text after `level `: `<level> inherit|<provider>/<model>[
 * effort=<id>][,<provider>/<model>[ effort=<id>]...]`. Returns `{ level,
 * routes }` (routes null for Inherit) or undefined when invalid. Every
 * command states the whole level: an entry without a token has no effort key
 * (its model's own default), and nothing is kept from the saved level.
 * Inherit takes no token; there is no level-wide or effort-only form.
 * Duplicates are the handler's check. The command handler and the fold both
 * parse with this function, so what the handler accepts is what the fold
 * stores.
 */
export function parseLevelSetting(value) {
  if (typeof value !== 'string') return undefined
  const rest = value.trim()
  const level = rest.split(/\s+/)[0]
  if (!ROUTER_LEVELS.includes(level)) return undefined
  const selection = rest.slice(level.length).trim()
  if (selection === '') return undefined
  if (selection.toLowerCase() === 'inherit') return { level, routes: null }
  const routes = []
  for (const part of selection.split(',')) {
    const route = parseEntry(part.trim())
    if (route === undefined) return undefined
    routes.push(route)
  }
  return { level, routes }
}

function commandArg(state, args) {
  const raw = typeof args === 'string' ? args.trim() : ''
  const arg = raw.toLowerCase()
  if (arg === '') return { target: 'mode', arg: state.mode === 'manual' ? 'off' : 'manual' }
  if (arg === 'on' || arg === 'manual') return { target: 'mode', arg: 'manual' }
  if (arg === 'off') return { target: 'mode', arg: 'off' }
  if (arg.startsWith('level ')) {
    const parsed = parseLevelSetting(raw.slice('level '.length))
    return parsed === undefined ? null : { target: 'level', ...parsed }
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
      // The entries land together with their efforts: the level is replaced.
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
