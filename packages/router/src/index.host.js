import { z } from 'zod'
import { foldRouter, INITIAL_ROUTER_STATE, pendingRouter, ROUTER_LEVELS, viewRouter } from './state.js'

export const name = 'router'
export const inject = ['systemPrompt', 'sessionProjections']

export const POLICY = `Manual intelligent routing is active for this session. Route ordinary fresh in-process subagent work deliberately, without inventing model benchmarks, prices, or capability claims.
- Ordinary is the default bucket. Mechanical requires all three criteria: fully specified work, no judgment, and a deterministically checkable result. Hard judgment requires a verification/judgment stage or high ambiguity combined with costly-to-undo output. Never relabel substantive work Mechanical to save cost, and doubt never resolves downward.
- Inherit by default. A configured shortlist applies only when it is non-null. Leave inheritance for a named non-cost reason—a capability, tool, context window, provider feature, or explicit user preference—or for high-confidence Mechanical work. Never choose a cheaper route for substantive work because it appears small, simple, or cheap.
- Before the first ordinary fresh in-process subagent call in a turn, call list_subagent_models to inspect this Session's exact authorized routes. Only use literal provider/model IDs it returns. If discovery fails, returns no models, or a preferred route is absent—even when the user named it—state "router: inherit — route discovery unavailable or unauthorized" and omit provider, model, and reasoning_effort.
- When a level has a shortlist, choose any route in it that fits the named task-fit reason and pass exactly that provider/model. A shortlist is an unordered set, not a ranking, price list, or benchmark claim. If there is no clear advantage, inherit instead of forcing a selection. An explicit-route spawn failure is visible; never silently fall back to another model.
- Effort is decided separately from model: Mechanical uses low only when advertised, Ordinary omits effort for the route default, and Hard judgment uses the highest advertised effort only when useful. If the exact route does not advertise the desired effort, omit reasoning_effort.
- State one auditable line before delegation: "router: <level> → <provider>/<model> because <criterion>; effort: <low|default|highest-advertised>". For inheritance, use "router: inherit — no clear route advantage" and omit provider, model, and reasoning_effort.
- Do not retry a failed worker on a different model or change its route mid-run. This discovery and router-line policy applies only to ordinary fresh in-process subagent work. Other delegation backends keep configured behavior: do not query routes for them, invent route fields, or emit router lines for them.
- Advisor-reserved children (advisor-verifier-*, advisor-planner-*, and advisor-consult-*) are exempt: never route them or apply any shortlist, including Hard. They use the advisor plugin's own Inherit or explicit Advisor-model and verifier-model selections, never this plugin's route choices. Workers created from an accepted plan are ordinary work and are routed by their confirmed level.
- This version is lead-only. Do not spawn a classifier or send task summaries to a separate routing model. The lead states and applies the route directly; the Host does not spawn workers automatically.`

const routeSchema = z.object({ provider: z.string().min(1), model: z.string().min(1) })
const routeListSchema = z.array(routeSchema).nullable()
const selectionSchema = z.object({
  mechanical: routeListSchema,
  ordinary: routeListSchema,
  hard: routeListSchema,
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
    z.object({ target: z.literal('level'), level: z.enum(ROUTER_LEVELS), routes: routeListSchema, ...commandFields }),
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

function selectionLabel(routes) {
  return routes === null ? 'Inherit' : routes.map(routeLabel).join(', ')
}

function parseRoute(value) {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return undefined
  const provider = value.slice(0, slash)
  const model = value.slice(slash + 1)
  if (provider.trim() !== provider || model.trim() !== model) return undefined
  return { provider, model }
}

function parseLevelSelection(raw) {
  const rest = raw.slice('level '.length).trim()
  const level = rest.split(/\s+/)[0]
  if (!ROUTER_LEVELS.includes(level)) return undefined
  const selection = rest.slice(level.length).trim()
  if (selection === '') return undefined
  if (selection.toLowerCase() === 'inherit') return { level, routes: null }
  const parts = selection.split(',').map((part) => part.trim())
  if (parts.some((part) => part === '')) return undefined
  const routes = []
  for (const part of parts) {
    const route = parseRoute(part)
    if (route === undefined) return undefined
    routes.push(route)
  }
  return { level, routes }
}

export function routerPolicy(state, authorizedRoutes) {
  const lines = ROUTER_LEVELS.map((level) => {
    const selected = state.selections[level]
    if (selected === null) return `- ${level}: Inherit`
    const authorized = selected.filter((route) => authorizedRoutes?.some(
      (candidate) => candidate.provider === route.provider && candidate.model === route.model,
    ))
    return `- ${level}: ${authorized.length > 0 ? authorized.map(routeLabel).join(', ') : 'Inherit (saved routes unavailable)'}`
  })
  return `${POLICY}\nSession shortlists (empty means Inherit):\n${lines.join('\n')}`
}

export async function apply(ctx) {
  const projection = await ctx.sessionProjections.register({
    key: 'router',
    stateVersion: 3,
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
      input: { hint: '[on|off|manual|status|level mechanical|ordinary|hard inherit|level level provider/model,...]' },
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
          const selections = ROUTER_LEVELS.map((level) => `${level}: ${selectionLabel(state.selections[level])}`).join('\n')
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
          const parsed = parseLevelSelection(raw)
          if (parsed === undefined) {
            return { kind: 'error', text: 'Usage: /router level <mechanical|ordinary|hard> inherit|<provider>/<model>[,<provider>/<model>...]' }
          }
          if (parsed.routes !== null) {
            if (parsed.routes.length > 4) return { kind: 'error', text: 'Each level accepts at most four models.' }
            const authorizedRoutes = modelRoutes.stateOf(agent.session)
            if (!Array.isArray(authorizedRoutes)) {
              return { kind: 'error', text: 'No explicit subagent routes are authorized for this session. Use inherit for every level.' }
            }
            const selectedKeys = new Set(parsed.routes.map(routeLabel))
            if (selectedKeys.size !== parsed.routes.length) {
              return { kind: 'error', text: 'Duplicate routes are not allowed in one level.' }
            }
            const unauthorized = parsed.routes.find((route) => !authorizedRoutes.some(
              (candidate) => candidate.provider === route.provider && candidate.model === route.model,
            ))
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
