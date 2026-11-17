import { z } from 'zod'
import { EFFORT_ID, foldRouter, INITIAL_ROUTER_STATE, ROUTER_LEVELS } from './state.js'

// Observe-only audit of the lead's `subagent` requests while Router is on. It
// folds session events the Host already records into counters: nothing here
// runs when a tool is called, reaches the prompt or the Client, or blocks
// anything. It measures route and effort fidelity, never the level.

/** Verdicts, in the order `/router status` lists them. */
export const AUDIT_VERDICTS = Object.freeze([
  'inherit', 'match', 'retry', 'effort_mismatch', 'effort_omitted', 'unlisted_closed', 'unlisted_open', 'no_shortlist', 'malformed',
])

/** Longest provider or model id kept in state; a longer one is cut to this length. */
export const ROUTE_TEXT_MAX = 200

// The Advisor's reserved roles, as the Advisor reserves them: the bare role or `<role>-...`.
const ADVISOR_ROLES = Object.freeze(['advisor-verifier', 'advisor-planner', 'advisor-consult'])

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
// Own properties only: nothing inherited is ever read as an argument.
const own = (record, key) => (Object.hasOwn(record, key) ? record[key] : undefined)
const isText = (value) => typeof value === 'string' && value !== ''
const cut = (text) => (text.length > ROUTE_TEXT_MAX ? text.slice(0, ROUTE_TEXT_MAX) : text)
// The effort a shortlist line shows for an entry: only an id the grammar can carry (as routerPolicy prints it).
const shownEffort = (entry) => (typeof entry.effort === 'string' && EFFORT_ID.test(entry.effort) ? entry.effort : undefined)
const verdict = (name) => ({ verdict: name, effortMatch: null })

/** Whether a child name is reserved for an Advisor role, which Router never routes. */
export function isAdvisorReservedName(name) {
  return typeof name === 'string' && ADVISOR_ROLES.some((role) => name === role || name.startsWith(`${role}-`))
}

/** A fresh audit state: Router off, authorization not recorded, nothing observed. */
export function initAudit() {
  return {
    router: { ...INITIAL_ROUTER_STATE, selections: { ...INITIAL_ROUTER_STATE.selections } },
    authorized: null,
    counts: Object.fromEntries(AUDIT_VERDICTS.map((name) => [name, 0])),
    total: 0,
    lastEffortMatch: null,
  }
}

/**
 * The audit state schema. The embedded router state is validated by the
 * router's own state schema, passed in, so the two cannot drift apart; the
 * audit's stateVersion moves with the router's.
 */
export function auditStateSchema(routerStateSchema) {
  const count = z.number().int().nonnegative()
  const id = z.string().min(1)
  return z.object({
    router: routerStateSchema,
    authorized: z.array(z.object({ provider: id, model: id })).nullable(),
    counts: z.object(Object.fromEntries(AUDIT_VERDICTS.map((name) => [name, count]))),
    total: count,
    lastEffortMatch: z.object({
      provider: id.max(ROUTE_TEXT_MAX),
      model: id.max(ROUTE_TEXT_MAX),
      effort: z.string().regex(EFFORT_ID),
      turn: z.number().int(),
    }).nullable(),
  })
}

// The entries each level shows the lead (routerPolicy): authorized entries
// only, or every saved entry while authorization is not recorded yet. A level
// without any reads Inherit.
function shownLevels(selections, authorized) {
  return ROUTER_LEVELS.map((level) => {
    const entries = isRecord(selections) ? own(selections, level) : undefined
    if (!Array.isArray(entries)) return []
    return entries.filter((entry) => isRecord(entry) && (authorized === null || (Array.isArray(authorized)
      && authorized.some((route) => isRecord(route) && route.provider === entry.provider && route.model === entry.model))))
  })
}

/**
 * Classify one `subagent` request: the exact provider, model and
 * reasoning_effort (or its absence) of its parsed arguments against the union
 * of the entries every level shows. No level is guessed. Pure: reads only own
 * properties and copies only a matched route's ids (cut) and effort.
 * @param args - the parsed `arguments` value, whatever it is
 * @param context - `{ selections, authorized, previous, turn }`: the router
 *   selections at the call, the authorized routes (null while not recorded),
 *   the last effort match (or null) and the request's turn
 * @returns `{ verdict, effortMatch }`, effortMatch set only for a match with
 *   an effort and a turn number; null for an Advisor-reserved child
 */
export function classifyDelegation(args, { selections, authorized = null, previous = null, turn = null } = {}) {
  if (!isRecord(args)) return verdict('malformed')
  if (isAdvisorReservedName(own(args, 'name'))) return null
  const provider = own(args, 'provider')
  const model = own(args, 'model')
  const effort = own(args, 'reasoning_effort')
  if (provider === undefined && model === undefined && effort === undefined) return verdict('inherit')
  // As the subagent tool requires: provider and model together and non-empty, an effort only with both.
  if (!isText(provider) || !isText(model) || (effort !== undefined && !isText(effort))) return verdict('malformed')
  const levels = shownLevels(selections, authorized)
  const entries = levels.flat().filter((entry) => entry.provider === provider && entry.model === model)
  if (entries.length === 0) {
    if (levels.every((level) => level.length === 0)) return verdict('no_shortlist')
    return verdict(levels.every((level) => level.length > 0) ? 'unlisted_closed' : 'unlisted_open')
  }
  if (effort === undefined) {
    if (entries.some((entry) => shownEffort(entry) === undefined)) return verdict('match')
    // The one retry the policy prescribes after a spawn rejected for its effort.
    const retry = Number.isSafeInteger(turn) && isRecord(previous) && previous.turn === turn
      && previous.provider === cut(provider) && previous.model === cut(model)
    return verdict(retry ? 'retry' : 'effort_omitted')
  }
  if (!entries.some((entry) => shownEffort(entry) === effort)) return verdict('effort_mismatch')
  const effortMatch = Number.isSafeInteger(turn) && EFFORT_ID.test(effort)
    ? { provider: cut(provider), model: cut(model), effort, turn }
    : null
  return { verdict: 'match', effortMatch }
}

// The model's raw `arguments` JSON text; anything else reads as no object.
function parseArguments(text) {
  if (typeof text !== 'string') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function foldCommand(state, event) {
  // Each field is read once, so foldRouter sees exactly what is checked here,
  // and always a usable time: foldRouter reads the clock for a run without
  // one, while the audit folds it as time 0, so every replay agrees.
  const time = event.time
  const copy = { ...event, time: Number.isFinite(time) ? time : 0 }
  if (!isRecord(copy.data)) return state
  copy.data = { ...copy.data }
  // foldRouter keeps a run's commandId as given: fold only what the router state schema can hold.
  if (copy.type === 'command/run' && copy.data.name === 'router' && typeof copy.data.commandId !== 'string') return state
  const router = foldRouter(state.router, copy)
  return router === state.router ? state : { ...state, router }
}

// Like routerModelRoutes: the first policy event only, provider and model only.
function foldPolicy(state, event) {
  if (state.authorized !== null) return state
  const models = event.data?.allowedModels
  if (!Array.isArray(models)) return state
  const authorized = []
  for (const route of models) {
    if (!isRecord(route)) continue
    const provider = own(route, 'provider')
    const model = own(route, 'model')
    if (isText(provider) && isText(model)) authorized.push({ provider, model })
  }
  return { ...state, authorized }
}

// One audited request: a `subagent` call while Router is on, other than an Advisor-reserved child.
function foldCall(state, event) {
  const data = event.data
  if (!isRecord(data) || data.name !== 'subagent' || state.router.mode !== 'manual') return state
  const result = classifyDelegation(parseArguments(data.arguments), {
    selections: state.router.selections,
    authorized: state.authorized,
    previous: state.lastEffortMatch,
    turn: data.turn,
  })
  if (result === null) return state
  return {
    ...state,
    counts: { ...state.counts, [result.verdict]: state.counts[result.verdict] + 1 },
    total: state.total + 1,
    lastEffortMatch: result.effortMatch,
  }
}

/**
 * The `routerAudit` fold. It embeds the router state machine (foldRouter over
 * command/run and command/done, so each call meets the mode and shortlists in
 * force at its event), the session's authorized routes, and one count per
 * audited request. Every other event, and any event it cannot read, returns
 * the same state: it never throws and never reads a clock.
 */
export function foldAudit(state, event) {
  try {
    switch (event?.type) {
      case 'command/run':
      case 'command/done':
        return foldCommand(state, event)
      case 'subagent/model-selection-policy':
        return foldPolicy(state, event)
      case 'tool/call':
        return foldCall(state, event)
      default:
        return state
    }
  } catch {
    return state
  }
}

/**
 * The one `/router status` line, or '' when nothing was observed. Reads
 * defensively: a read that throws, a value that is no audit state (the unit
 * may be unavailable), or one that throws while it is read gives ''.
 * @param read - () => the session's audit state
 */
export function auditStatusLine(read) {
  try {
    const audit = read()
    const total = audit?.total
    if (!Number.isSafeInteger(total) || total <= 0) return ''
    const counts = audit.counts
    if (!isRecord(counts)) return ''
    const parts = AUDIT_VERDICTS.flatMap((name) => {
      const count = own(counts, name)
      return Number.isSafeInteger(count) && count > 0 ? [`${name} ${count}`] : []
    })
    if (parts.length === 0) return ''
    return `Observed subagent requests while Router was on: ${total} (${parts.join(', ')}). Observe only; nothing is blocked.`
  } catch {
    // Status keeps its text whatever the value does.
    return ''
  }
}
