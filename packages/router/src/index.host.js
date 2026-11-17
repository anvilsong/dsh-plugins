import { z } from 'zod'
import { EFFORT_ID, foldRouter, INITIAL_ROUTER_STATE, parseLevelSetting, pendingRouter, ROUTER_LEVELS, viewRouter } from './state.js'

export const name = 'router'
export const inject = ['systemPrompt', 'sessionProjections']

export const POLICY = `Manual intelligent routing is active for this session. Route ordinary fresh in-process subagent work deliberately, without inventing model benchmarks, prices, or capability claims.
- Ordinary is the default bucket. Mechanical requires all three criteria: fully specified work, no judgment, and a deterministically checkable result. Hard judgment requires a verification/judgment stage or high ambiguity combined with costly-to-undo output. Never relabel substantive work Mechanical to save cost, and doubt never resolves downward.
- Inherit by default. A configured shortlist applies only when it is non-null. Leave inheritance for a named non-cost reason—a capability, tool, context window, provider feature, or explicit user preference—or for high-confidence Mechanical work. Never choose a cheaper route for substantive work because it appears small, simple, or cheap.
- Before the first ordinary fresh in-process subagent call in a turn, call list_subagent_models to inspect this Session's exact authorized routes. Only use literal provider/model IDs it returns. If discovery fails, returns no models, or a preferred route is absent—even when the user named it—state "router: inherit — route discovery unavailable or unauthorized" and omit provider, model, and reasoning_effort.
- When a level has a shortlist, choose any route in it that fits the named task-fit reason and pass exactly that provider/model. A shortlist is an unordered set, not a ranking, price list, or benchmark claim. If there is no clear advantage, inherit instead of forcing a selection. An explicit-route spawn failure is visible; never silently fall back to another model.
- Effort belongs to the shortlist entry. Pass exactly the chosen entry's effort as reasoning_effort together with its provider and model: an entry listed as "<provider>/<model> (effort <id>)" passes reasoning_effort "<id>", and an entry without an effort omits reasoning_effort so the model's own default effort applies. Never choose another effort. If the spawn is rejected for the effort, say so and retry once on the same route without reasoning_effort.
- State one auditable line before delegation: "router: <level> → <provider>/<model> because <criterion>; effort: <id|default>". For inheritance, use "router: inherit — no clear route advantage" and omit provider, model, and reasoning_effort.
- Do not retry a failed worker on a different model or change its route mid-run. This discovery and router-line policy applies only to ordinary fresh in-process subagent work. Other delegation backends keep configured behavior: do not query routes for them, invent route fields, or emit router lines for them.
- Advisor-reserved children (advisor-verifier-*, advisor-planner-*, and advisor-consult-*) are exempt: never route them or apply any shortlist, including Hard. They use the advisor plugin's own Inherit or explicit Advisor-model and verifier-model selections, never this plugin's route choices. Workers created from an accepted plan are ordinary work and are routed by their confirmed level.
- This version is lead-only. Do not spawn a classifier or send task summaries to a separate routing model. The lead states and applies the route directly; the Host does not spawn workers automatically.`

const LEVEL_USAGE = 'Usage: /router level <mechanical|ordinary|hard> inherit|<provider>/<model>[ effort=<id>][,<provider>/<model>[ effort=<id>]...]'

// routerModelRoutes keeps the plain authorized-route list.
const routeSchema = z.object({ provider: z.string().min(1), model: z.string().min(1) })
const routeListSchema = z.array(routeSchema).nullable()
// A shortlist entry: a route plus, optionally, the effort to pass with it.
const entrySchema = z.object({ provider: z.string().min(1), model: z.string().min(1), effort: z.string().regex(EFFORT_ID).optional() })
const entryListSchema = z.array(entrySchema).nullable()
const selectionSchema = z.object({
  mechanical: entryListSchema,
  ordinary: entryListSchema,
  hard: entryListSchema,
})
const commandFields = { commandId: z.string(), startedAt: z.number() }
const failureSchema = z.object({
  count: z.number().int().nonnegative(),
  text: z.string(),
  target: z.enum(['mode', 'level']),
  level: z.enum(ROUTER_LEVELS).nullable(),
}).nullable()
const stateSchema = z.object({
  mode: z.enum(['off', 'manual']),
  selections: selectionSchema,
  pending: z.discriminatedUnion('target', [
    z.object({ target: z.literal('mode'), arg: z.enum(['off', 'manual']), ...commandFields }),
    z.object({ target: z.literal('level'), level: z.enum(ROUTER_LEVELS), routes: entryListSchema, ...commandFields }),
  ]).nullable(),
  lastRun: z.object({ commandId: z.string(), target: z.enum(['mode', 'level']), level: z.enum(ROUTER_LEVELS).nullable() }).nullable(),
  failure: failureSchema,
})
const viewSchema = z.object({
  mode: z.enum(['off', 'manual']),
  pending: z.boolean(),
  pendingTarget: z.enum(['mode', 'level']).nullable(),
  pendingLevel: z.enum(ROUTER_LEVELS).nullable(),
  pendingSince: z.number().nullable(),
  selections: selectionSchema,
  failure: failureSchema,
})

function routeLabel(route) {
  return `${route.provider}/${route.model}`
}

// Only an id the grammar can carry is ever shown or passed on.
const effortOf = (route) => typeof route.effort === 'string' && EFFORT_ID.test(route.effort) ? route.effort : undefined

/** An entry as a command states it: `<provider>/<model>[ effort=<id>]`. */
function entryText(route) {
  const effort = effortOf(route)
  return effort === undefined ? routeLabel(route) : `${routeLabel(route)} effort=${effort}`
}

/** An entry on the lead's shortlist line: `<provider>/<model>[ (effort <id>)]`. */
function entryLine(route) {
  const effort = effortOf(route)
  return effort === undefined ? routeLabel(route) : `${routeLabel(route)} (effort ${effort})`
}

function selectionLabel(routes) {
  return routes === null ? 'Inherit' : routes.map(entryText).join(', ')
}

function isAuthorized(route, authorizedRoutes) {
  return Array.isArray(authorizedRoutes) && authorizedRoutes.some(
    (candidate) => candidate.provider === route.provider && candidate.model === route.model,
  )
}

// Unavailable entries are left out with their efforts; a level whose saved
// entries are all unavailable inherits.
export function routerPolicy(state, authorizedRoutes) {
  const lines = ROUTER_LEVELS.map((level) => {
    const selected = state.selections[level]
    if (selected === null) return `- ${level}: Inherit`
    const authorized = selected.filter((route) => isAuthorized(route, authorizedRoutes))
    return `- ${level}: ${authorized.length > 0 ? authorized.map(entryLine).join(', ') : 'Inherit (saved routes unavailable)'}`
  })
  return `${POLICY}\nSession shortlists (empty means Inherit):\n${lines.join('\n')}`
}

function statusLine(state, level, authorizedRoutes) {
  const routes = state.selections[level]
  if (routes === null) return `${level}: Inherit`
  return `${level}: ${routes.map((route) => `${entryText(route)}${isAuthorized(route, authorizedRoutes) ? '' : ' (unavailable)'}`).join(', ')}`
}

export async function apply(ctx) {
  const projection = await ctx.sessionProjections.register({
    key: 'router',
    // 5: shortlist entries gained an optional effort (4 was an unreleased
    // per-level preference). Older cached state is rebuilt from the session
    // log, where commands without tokens give entries without efforts.
    stateVersion: 5,
    stateSchema,
    init: () => ({ ...INITIAL_ROUTER_STATE, selections: { ...INITIAL_ROUTER_STATE.selections } }),
    apply: foldRouter,
    wire: { viewSchema, view: viewRouter },
  })
  const modelRoutes = await ctx.sessionProjections.register({
    key: 'routerModelRoutes',
    stateVersion: 1,
    stateSchema: routeListSchema,
    init: () => null,
    apply: (routes, event) => {
      if (routes !== null || event.type !== 'subagent/model-selection-policy') return routes
      return event.data.allowedModels.map(({ provider, model }) => ({ provider, model }))
    },
    wire: { viewSchema: routeListSchema, view: (routes) => routes },
  })

  ctx.systemPrompt.section({
    name: 'router:policy',
    order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY'),
    text: (context) => {
      if (context.agent === undefined) return ''
      const state = projection.stateOf(context.agent.session)
      return state.mode === 'manual' ? routerPolicy(state, modelRoutes.stateOf(context.agent.session)) : ''
    },
  })

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: 'dsh-plugin-router',
      name: 'router',
      description: 'Toggle lead-controlled model routing for ordinary subagents',
      input: { hint: '[on|off|manual|status|level mechanical|ordinary|hard inherit|provider/model[ effort=<id>],...]' },
      handler: async ({ agent, rawInput, commandId }) => {
        const raw = rawInput.trim()
        const arg = raw.toLowerCase()
        const state = projection.stateOf(agent.session)
        const pending = pendingRouter(state)
        if (arg === 'status') {
          if (pending) {
            const suffix = pending.target === 'level' ? ` ${pending.level}` : ''
            return { kind: 'success', text: `Router is updating (${pending.target}${suffix}) for this session.` }
          }
          const authorizedRoutes = modelRoutes.stateOf(agent.session)
          const selections = ROUTER_LEVELS.map((level) => statusLine(state, level, authorizedRoutes)).join('\n')
          return {
            kind: 'success',
            text: state.mode === 'manual'
              ? `Manual router is on for this session. The lead selects authorized routes or inheritance for ordinary subagents.\n${selections}`
              : `Router is off for this session. Ordinary subagent model selection is unchanged. Preferences are retained:\n${selections}`,
          }
        }
        if (arg === 'auto') {
          return { kind: 'error', text: 'Jev auto mode is not included in this version. Use /router manual.' }
        }
        if (pending && pending.commandId !== commandId) {
          return { kind: 'error', text: 'Router is already updating. Try again after it finishes.' }
        }
        if (arg.startsWith('level ')) {
          // The fold parses the same text with the same function.
          const parsed = parseLevelSetting(raw.slice('level '.length))
          if (parsed === undefined) return { kind: 'error', text: LEVEL_USAGE }
          if (parsed.routes !== null) {
            if (parsed.routes.length > 4) return { kind: 'error', text: 'Each level accepts at most four models.' }
            const authorizedRoutes = modelRoutes.stateOf(agent.session)
            if (!Array.isArray(authorizedRoutes)) {
              return { kind: 'error', text: 'No explicit subagent routes are authorized for this session. Use inherit for every level.' }
            }
            // Keyed on provider/model: one entry, with one effort, per model.
            const selectedKeys = new Set(parsed.routes.map(routeLabel))
            if (selectedKeys.size !== parsed.routes.length) {
              return { kind: 'error', text: 'Duplicate routes are not allowed in one level.' }
            }
            const unauthorized = parsed.routes.find((route) => !isAuthorized(route, authorizedRoutes))
            if (unauthorized !== undefined) {
              return { kind: 'error', text: `Route ${routeLabel(unauthorized)} is not authorized for this session. Choose available subagent models or inherit.` }
            }
          }
          return {
            kind: 'success',
            text: `${parsed.level} models ${parsed.routes === null ? 'reset to Inherit' : `set to ${selectionLabel(parsed.routes)}`} for this session. This applies when Model router is on.`,
          }
        }
        if (arg !== '' && arg !== 'on' && arg !== 'manual' && arg !== 'off') {
          return { kind: 'error', text: 'Usage: /router [on|off|manual|status|level ...]' }
        }
        const mode = arg === 'off' || (arg === '' && state.mode === 'manual') ? 'off' : 'manual'
        return {
          kind: 'success',
          text: mode === 'manual'
            ? 'Manual router on. The lead will state an authorized route or inheritance reason before ordinary subagent delegations.'
            : 'Router off. Ordinary subagent model selection is unchanged. Level preferences are retained.',
        }
      },
    })
  })
}
