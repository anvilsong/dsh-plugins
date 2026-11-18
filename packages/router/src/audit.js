import { z } from 'zod'
import { EFFORT_ID, foldRouter, INITIAL_ROUTER_STATE, ROUTER_LEVELS } from './state.js'

// Observe-only audit of the lead's `subagent` requests while Router is on. It
// folds session events the Host already records into counters: nothing here
// runs when a tool is called, reaches the prompt or the Client, or blocks
// anything. It measures route and effort fidelity, never the level: the
// per-level counts say which level's shortlist shows the route that ran, not
// whether that level was the right one.

/** Verdicts, in the order `/router status` lists them. */
export const AUDIT_VERDICTS = Object.freeze([
  'inherit', 'match', 'retry', 'effort_mismatch', 'effort_omitted', 'unlisted_closed', 'unlisted_open', 'no_shortlist', 'malformed',
])

/** Per-level counts, in the order `/router status` lists them: each level, then a route several levels show. */
export const AUDIT_LEVELS = Object.freeze([...ROUTER_LEVELS, 'shared'])

// The verdicts of a request whose route some level shows: exactly these are attributed to a level.
const SHOWN_ROUTE = new Set(['match', 'retry', 'effort_mismatch', 'effort_omitted'])

// The tool that lists the session's authorized routes: the discovery the policy asks for first in a turn.
const DISCOVERY_TOOL = 'list_subagent_models'

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
const isCount = (value) => Number.isSafeInteger(value) && value >= 0
// A turn number as kept in state: -0 as 0, so a JSON round trip keeps it.
const plainTurn = (turn) => (turn === 0 ? 0 : turn)

/** Whether a child name is reserved for an Advisor role, which Router never routes. */
export function isAdvisorReservedName(name) {
  return typeof name === 'string' && ADVISOR_ROLES.some((role) => name === role || name.startsWith(`${role}-`))
}

/**
 * A fresh audit state: Router off, authorization not recorded, nothing
 * observed. `levels`, `reserved` and `discovery` are the v2 counts;
 * `listTurn` (the turn of the latest list_subagent_models call) and
 * `lastRequestTurn` (the turn of the latest counted request) are the only
 * bookkeeping discovery needs.
 */
export function initAudit() {
  return {
    router: { ...INITIAL_ROUTER_STATE, selections: { ...INITIAL_ROUTER_STATE.selections } },
    authorized: null,
    counts: Object.fromEntries(AUDIT_VERDICTS.map((name) => [name, 0])),
    total: 0,
    lastEffortMatch: null,
    levels: Object.fromEntries(AUDIT_LEVELS.map((name) => [name, 0])),
    reserved: 0,
    discovery: { turns: 0, listed: 0 },
    listTurn: null,
    lastRequestTurn: null,
  }
}

/**
 * The audit state schema. The embedded router state is validated by the
 * router's own state schema, passed in, so the two cannot drift apart; the
 * audit's stateVersion moves with the router's. Every v2 field is required,
 * so a cached v1 state would fail it; the version bump makes the Host refold
 * the log instead.
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
    levels: z.object(Object.fromEntries(AUDIT_LEVELS.map((name) => [name, count]))),
    reserved: count,
    discovery: z.object({ turns: count, listed: count }),
    // Finite numbers only (z.number refuses Infinity and NaN), as the fold keeps them.
    listTurn: z.number().nullable(),
    lastRequestTurn: z.number().nullable(),
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

/**
 * The level whose shortlist shows a request's route: its exact provider and
 * model (its effort is ignored) against the entries each level shows, as
 * classifyDelegation reads them. It says which level's shortlist the route
 * that ran is on, not whether that level was right. The fold attributes only
 * requests whose verdict says some level shows the route (never inherit or
 * malformed). Pure: reads only own properties.
 * @param args - the parsed `arguments` value, whatever it is
 * @param context - `{ selections, authorized }` as for classifyDelegation
 * @returns the one level that shows the route, 'shared' when several do, or
 *   null when none does or the arguments name no route
 */
export function attributeLevel(args, { selections, authorized = null } = {}) {
  if (!isRecord(args)) return null
  const provider = own(args, 'provider')
  const model = own(args, 'model')
  if (!isText(provider) || !isText(model)) return null
  const showing = shownLevels(selections, authorized).flatMap((entries, index) => (
    entries.some((entry) => entry.provider === provider && entry.model === model) ? [ROUTER_LEVELS[index]] : []
  ))
  if (showing.length === 0) return null
  return showing.length === 1 ? showing[0] : 'shared'
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

// A list_subagent_models call, whatever the mode and its arguments: only its
// turn is kept, and only a finite one (an unnumbered call keeps the latest
// numbered one). It counts later only for a turn with a counted request.
function foldListCall(state, turn) {
  if (!Number.isFinite(turn) || turn === state.listTurn) return state
  return { ...state, listTurn: plainTurn(turn) }
}

// Discovery, in O(1): a counted request opens its turn once, and the turn is
// listed when the latest list call was made in it, so before this first
// request; a later list call in the turn comes too late. A turn that is no
// finite number is skipped, never guessed.
function openTurn(state, turn) {
  if (!Number.isFinite(turn) || turn === state.lastRequestTurn) return null
  const { turns, listed } = state.discovery
  return {
    discovery: { turns: turns + 1, listed: state.listTurn === turn ? listed + 1 : listed },
    lastRequestTurn: plainTurn(turn),
  }
}

// One `subagent` call while Router is on: an Advisor-reserved child is only
// counted as reserved (never classified, attributed or part of discovery);
// any other is one audited request. Every field is read once.
function foldCall(state, event) {
  const data = event.data
  if (!isRecord(data)) return state
  const name = data.name
  const turn = data.turn
  if (name === DISCOVERY_TOOL) return foldListCall(state, turn)
  if (name !== 'subagent' || state.router.mode !== 'manual') return state
  const args = parseArguments(data.arguments)
  if (isRecord(args) && isAdvisorReservedName(own(args, 'name'))) return { ...state, reserved: state.reserved + 1 }
  const context = { selections: state.router.selections, authorized: state.authorized }
  const result = classifyDelegation(args, {
    ...context,
    previous: state.lastEffortMatch,
    turn,
  })
  if (result === null) return state
  const level = SHOWN_ROUTE.has(result.verdict) ? attributeLevel(args, context) : null
  return {
    ...state,
    counts: { ...state.counts, [result.verdict]: state.counts[result.verdict] + 1 },
    total: state.total + 1,
    lastEffortMatch: result.effortMatch,
    levels: level === null ? state.levels : { ...state.levels, [level]: state.levels[level] + 1 },
    ...openTurn(state, turn),
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

// The named own counts of a record, in order, or null when one is no count.
function countsOf(record, names) {
  if (!isRecord(record)) return null
  const values = names.map((name) => own(record, name))
  return values.every(isCount) ? values : null
}

/**
 * The `/router status` lines, or '' when nothing was observed: the v1 line
 * with the total and the non-zero verdicts (once a request was counted), then
 * the v2 line with the per-level counts, the Advisor-reserved count and
 * discovery (once a request or a reserved child was counted), one newline
 * apart. Reads defensively: a read that throws, a value that is no audit
 * state of this version (the unit may be unavailable), or one that throws
 * while it is read gives ''.
 * @param read - () => the session's audit state
 */
export function auditStatusLine(read) {
  try {
    const audit = read()
    if (!isRecord(audit)) return ''
    const total = audit.total
    const reserved = audit.reserved
    const levels = countsOf(audit.levels, AUDIT_LEVELS)
    const discovery = countsOf(audit.discovery, ['turns', 'listed'])
    if (!isCount(total) || !isCount(reserved) || levels === null || discovery === null) return ''
    const lines = []
    if (total > 0) {
      const counts = audit.counts
      if (!isRecord(counts)) return ''
      const parts = AUDIT_VERDICTS.flatMap((name) => {
        const count = own(counts, name)
        return Number.isSafeInteger(count) && count > 0 ? [`${name} ${count}`] : []
      })
      if (parts.length === 0) return ''
      lines.push(`Observed subagent requests while Router was on: ${total} (${parts.join(', ')}). Observe only; nothing is blocked.`)
    }
    if (total > 0 || reserved > 0) {
      const [turns, listed] = discovery
      const shown = AUDIT_LEVELS.map((name, index) => `${name} ${levels[index]}`).join(', ')
      lines.push(`Shortlist that ran (route shown by): ${shown}. Advisor-reserved subagent requests: ${reserved}. Listed models first in ${listed} of ${turns} turns with routed requests.`)
    }
    return lines.join('\n')
  } catch {
    // Status keeps its text whatever the value does.
    return ''
  }
}
