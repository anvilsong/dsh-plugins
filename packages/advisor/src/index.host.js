import { z } from 'zod'
import { createLedger, resolveDataDir } from './ledger.js'
import {
  ADVISOR_WORKFLOW,
  advisorModelPolicy,
  advisorWorkflow,
  DATA_DIR_NOT_CONFIGURED,
  dataDirUnusable,
  installPlannerBoundary,
} from './planner.js'
import { foldAdvisor, INITIAL_ADVISOR_STATE, parseModelSetting, routeLabel, viewAdvisor } from './state.js'
import { installVerifierBoundary, VERIFIER_WORKFLOW, verifierModelPolicy } from './verifier.js'

export const name = 'advisor'
export const inject = ['systemPrompt', 'sessionProjections']

/** The workflow with placeholder paths; the lead's prompt names the resolved dataDir. */
export const POLICY = ADVISOR_WORKFLOW

/**
 * Lead policy while Advisor is on but its data directory cannot record runs.
 * @param {string} refusal DATA_DIR_NOT_CONFIGURED or dataDirUnusable(problem)
 */
export function unavailablePolicy(refusal) {
  return `Advisor mode is on for this session, but advisor runs are unavailable: ${refusal} Until then the host refuses every advisor-planner, advisor-consult, and advisor-verifier child, so no advisor run can be recorded or verified. Do not start them, and never run consult.py or load the advisor skill as a substitute; continue as yourself. If the user asks about the advisor, pass on that message.`
}

/** Lead policy while Advisor is on but no data directory is configured. */
export const UNCONFIGURED_POLICY = unavailablePolicy(DATA_DIR_NOT_CONFIGURED)

const routeSchema = z.object({ provider: z.string().min(1), model: z.string().min(1) })
const commandFields = { commandId: z.string(), startedAt: z.number() }
const targetSchema = z.enum(['advisor', 'verifierModel', 'advisorModel'])
const failureSchema = z.object({
  count: z.number().int().nonnegative(),
  text: z.string(),
  target: targetSchema,
}).nullable()
const stateSchema = z.object({
  active: z.boolean(),
  verifierModel: routeSchema.nullable(),
  advisorModel: routeSchema.nullable(),
  pending: z.discriminatedUnion('target', [
    z.object({ target: z.literal('advisor'), active: z.boolean(), ...commandFields }),
    z.object({ target: z.literal('verifierModel'), route: routeSchema.nullable(), ...commandFields }),
    z.object({ target: z.literal('advisorModel'), route: routeSchema.nullable(), ...commandFields }),
  ]).nullable(),
  lastRun: z.object({ commandId: z.string(), target: targetSchema }).nullable(),
  failure: failureSchema,
})
const viewSchema = z.object({
  active: z.boolean(),
  verifierModel: routeSchema.nullable(),
  advisorModel: routeSchema.nullable(),
  pending: z.boolean(),
  pendingTarget: targetSchema.nullable(),
  pendingSince: z.number().nullable(),
  failure: failureSchema,
})
const routeListSchema = z.array(routeSchema).nullable()

const modelLabel = routeLabel

const describe = (error) => (error instanceof Error ? error.message : String(error))

/** The DSH home from the launcher's profile data; optional, so it is not injected. */
function profileHome(ctx) {
  try {
    const home = ctx.get?.('profileContext')?.home
    return typeof home === 'string' ? home : undefined
  } catch {
    return undefined
  }
}

/**
 * Open the plugin-owned ledger once: config.dataDir, else <DSH home>/advisor.
 * A missing or invalid directory yields no ledger, so the planner boundary
 * refuses every advisor child. There is no environment fallback. A folder
 * that cannot take writes is reported here and refused until it can.
 */
function openLedger(ctx, config) {
  let ledger
  try {
    ledger = createLedger(resolveDataDir(config, { home: profileHome(ctx) }))
  } catch (error) {
    const problem = describe(error)
    ctx.logger?.warn?.(`advisor: ${problem}. Advisor children are refused until dataDir is set in the advisor plugin config.`)
    return { ledger: undefined, problem }
  }
  const unusable = ledger.writableProblem()
  if (unusable !== undefined) ctx.logger?.warn?.(`advisor: ${dataDirUnusable(unusable)} Advisor children are refused until then.`)
  return { ledger, problem: undefined }
}

export async function apply(ctx, config = {}) {
  const { ledger, problem } = openLedger(ctx, config)
  const workflow = ledger === undefined
    ? undefined
    : advisorWorkflow({ ledgerPath: ledger.ledgerPath, repliesDir: ledger.repliesDir })
  /** The refusal while runs cannot be recorded (re-probed on every call), else undefined. */
  const dataDirProblem = () => {
    if (ledger === undefined) return DATA_DIR_NOT_CONFIGURED
    const unusable = ledger.writableProblem()
    return unusable === undefined ? undefined : dataDirUnusable(unusable)
  }
  /** The same with its reason for the user; dataDirUnusable() already names the probe's reason. */
  const dataDirNotice = () => (ledger === undefined ? `${DATA_DIR_NOT_CONFIGURED} Reason: ${problem}.` : dataDirProblem())

  const projection = await ctx.sessionProjections.register({
    key: 'advisor',
    stateVersion: 6,
    stateSchema,
    init: () => ({ ...INITIAL_ADVISOR_STATE }),
    apply: foldAdvisor,
    wire: { viewSchema, view: viewAdvisor },
  })
  const modelRoutes = await ctx.sessionProjections.register({
    key: 'advisorModelRoutes',
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
    name: 'advisor:policy',
    order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY'),
    text: (context) => {
      if (context.agent === undefined) return ''
      const state = projection.stateOf(context.agent.session)
      if (!state.active) return ''
      const refusal = dataDirProblem()
      if (refusal !== undefined) return unavailablePolicy(refusal)
      return `${workflow}\n${advisorModelPolicy(state.advisorModel ?? null)}\n${VERIFIER_WORKFLOW}\n${verifierModelPolicy(state.verifierModel)}`
    },
  })

  ctx.inject(['agents', 'subagents', 'tools'], (verifierCtx) => {
    const stateFor = (agent) => {
      if (agent === undefined) return undefined
      try {
        return projection.stateOf(verifierCtx.subagents.rootOf(agent).session)
      } catch {
        return undefined
      }
    }
    verifierCtx.effect(() => installVerifierBoundary(
      verifierCtx,
      (agent) => stateFor(agent)?.active === true,
      (agent) => stateFor(agent)?.verifierModel ?? null,
      dataDirProblem,
    ), 'advisor: verifier boundary')
  })

  // Optional: without the task board, planner delegations are refused.
  let teams
  ctx.inject(['agentTeams'], (teamsCtx) => {
    teamsCtx.effect(() => {
      teams = teamsCtx.agentTeams
      return () => { teams = undefined }
    }, 'advisor: task board')
  })

  ctx.inject(['agents', 'subagents', 'tools', 'workingDirectory'], (plannerCtx) => {
    const rootSession = (agent) => {
      try {
        return plannerCtx.subagents.rootOf(agent).session
      } catch {
        return undefined
      }
    }
    plannerCtx.effect(() => installPlannerBoundary(plannerCtx, {
      settingsFor: (agent) => {
        const session = agent === undefined ? undefined : rootSession(agent)
        return session === undefined ? undefined : projection.stateOf(session)
      },
      routesFor: (agent) => {
        const session = rootSession(agent)
        return session === undefined ? null : modelRoutes.stateOf(session)
      },
      teamsEnabled: (agent) => {
        try {
          return teams?.isEnabled(agent) === true
        } catch {
          return false
        }
      },
      workspaceOf: (agent) => {
        try {
          return plannerCtx.workingDirectory.get(agent.session)
        } catch {
          return undefined
        }
      },
      ledger,
    }), 'advisor: child boundary')
  })

  ctx.inject(['commands'], (commandCtx) => {
    const USAGE = 'Usage: /advisor [on|off|status|model inherit|model <provider>/<model>|verifier-model inherit|verifier-model <provider>/<model>]'
    const setRoute = (agent, raw, prefix, noun) => {
      const route = parseModelSetting(raw.slice(prefix.length).trim())
      if (route === undefined) return { kind: 'error', text: `Usage: /advisor ${prefix.trim()} inherit|<provider>/<model>` }
      if (route !== null) {
        const routes = modelRoutes.stateOf(agent.session)
        const authorized = Array.isArray(routes)
          && routes.some((candidate) => candidate.provider === route.provider && candidate.model === route.model)
        if (!authorized) {
          return {
            kind: 'error',
            text: `${noun} route ${route.provider}/${route.model} is not authorized for this session. Choose an available subagent model or Inherit.`,
          }
        }
      }
      return {
        kind: 'success',
        text: route === null
          ? `${noun} set to Inherit for this session. Normal subagent defaults apply when Advisor is on.`
          : `${noun} set to ${route.provider}/${route.model} for this session. It is used when Advisor is on.`,
      }
    }
    commandCtx.commands.register({
      definitionId: 'dsh-plugin-advisor',
      name: 'advisor',
      description: 'Toggle the in-process advisor and read-only verification, and choose their models, for this session',
      input: { hint: '[on|off|status|model inherit|provider/model|verifier-model inherit|provider/model]' },
      handler: async ({ agent, rawInput, commandId }) => {
        const raw = rawInput.trim()
        const arg = raw.toLowerCase()
        const state = projection.stateOf(agent.session)
        if (arg === 'status') {
          const runs = ledger === undefined ? undefined : await ledger.recentLedger()
          if (state.pending) return { kind: 'success', text: `Advisor is updating (${state.pending.target}) for this session.` }
          const unusable = ledger?.writableProblem()
          const data = ledger === undefined
            ? `${DATA_DIR_NOT_CONFIGURED}\nReason: ${problem}. Advisor runs are refused until it is set.`
            : `Data directory: ${ledger.dir}\n`
              + (unusable === undefined ? '' : `${dataDirUnusable(unusable)} Advisor runs are refused until then.\n`)
              + `Recent advisor runs:\n${runs}`
          return {
            kind: 'success',
            text: `${state.active ? 'Advisor is on; verification is automatic' : 'Advisor is off; verification is disabled'} for this session.\n`
              + `Advisor model: ${modelLabel(state.advisorModel ?? null)}. Verifier model: ${modelLabel(state.verifierModel)}. Both apply when Advisor is on.\n`
              + data,
          }
        }
        if (arg === 'model') return { kind: 'success', text: `Advisor model: ${modelLabel(state.advisorModel ?? null)} for this session.` }
        if (arg === 'verifier-model') {
          return { kind: 'success', text: `Verifier model: ${modelLabel(state.verifierModel)} for this session.` }
        }
        if (arg === 'planner' || arg.startsWith('planner ')) {
          return { kind: 'error', text: 'The planner setting is now the Advisor model, used for plans and advice. Use /advisor model inherit|<provider>/<model>.' }
        }
        if (arg === 'verifier' || arg === 'verifier on' || arg === 'verifier off' || arg === 'verifier status') {
          return {
            kind: 'error',
            text: 'The separate verifier switch was removed. Advisor on enables verification automatically. Use /advisor verifier-model to choose a model.',
          }
        }
        if (state.pending && state.pending.commandId !== commandId) {
          return { kind: 'error', text: 'Advisor is already updating. Try again after it finishes.' }
        }
        if (arg.startsWith('verifier-model ')) return setRoute(agent, raw, 'verifier-model ', 'Verifier model')
        if (arg.startsWith('model ')) return setRoute(agent, raw, 'model ', 'Advisor model')
        if (arg !== '' && arg !== 'on' && arg !== 'off') return { kind: 'error', text: USAGE }
        const active = arg === '' ? !state.active : arg === 'on'
        const refusal = active ? dataDirNotice() : undefined
        return {
          kind: 'success',
          text: active
            ? `Advisor on. The in-process advisor and read-only verification are enabled.${refusal === undefined ? '' : `\n${refusal} Until then advisor runs and verification are refused.`}`
            : 'Advisor off. Advisor runs and verification stop; model preferences are retained.',
        }
      },
    })
  })
}
