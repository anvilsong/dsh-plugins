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
import {
  effortReset,
  foldAdvisor,
  inheritWithEffort,
  INITIAL_ADVISOR_STATE,
  parseModelSetting,
  pendingAdvisor,
  routeLabel,
  viewAdvisor,
} from './state.js'
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
  return `Advisor mode is on for this session, but advisor runs are unavailable: ${refusal} Until then the host refuses every advisor-planner, advisor-consult, and advisor-verifier child, so no advisor run can be recorded or verified. Do not start them; continue as yourself. If the user asks about the advisor, pass on that message.`
}

/** Lead policy while Advisor is on but no data directory is configured. */
export const UNCONFIGURED_POLICY = unavailablePolicy(DATA_DIR_NOT_CONFIGURED)

const routeFields = { provider: z.string().min(1), model: z.string().min(1) }
/** An authorized route, as the routes projection keeps it: provider and model only. */
const routeSchema = z.object(routeFields)
/** A saved Advisor or Verifier model: a route and its optional effort id (zod drops undeclared keys). */
const settingRouteSchema = z.object({ ...routeFields, effort: z.string().min(1).optional() })
const commandFields = { commandId: z.string(), startedAt: z.number() }
const targetSchema = z.enum(['advisor', 'verifierModel', 'advisorModel'])
const failureSchema = z.object({
  count: z.number().int().nonnegative(),
  text: z.string(),
  target: targetSchema,
}).nullable()
const stateSchema = z.object({
  active: z.boolean(),
  verifierModel: settingRouteSchema.nullable(),
  advisorModel: settingRouteSchema.nullable(),
  pending: z.discriminatedUnion('target', [
    z.object({ target: z.literal('advisor'), active: z.boolean(), ...commandFields }),
    z.object({ target: z.literal('verifierModel'), route: settingRouteSchema.nullable(), ...commandFields }),
    z.object({ target: z.literal('advisorModel'), route: settingRouteSchema.nullable(), ...commandFields }),
  ]).nullable(),
  lastRun: z.object({ commandId: z.string(), target: targetSchema }).nullable(),
  failure: failureSchema,
})
const viewSchema = z.object({
  active: z.boolean(),
  verifierModel: settingRouteSchema.nullable(),
  advisorModel: settingRouteSchema.nullable(),
  pending: z.boolean(),
  pendingTarget: targetSchema.nullable(),
  pendingSince: z.number().nullable(),
  failure: failureSchema,
})
const routeListSchema = z.array(routeSchema).nullable()

const modelLabel = routeLabel

/** A message for any thrown value; never throws (getters, revoked proxies, null-prototype objects). */
function describe(error) {
  try {
    return error instanceof Error ? String(error.message) : String(error)
  } catch {
    return 'an unreadable error'
  }
}

/** Whether a thrown value is the llm's refusal of an effort the model does not advertise; never throws. */
function isUnsupportedEffort(error) {
  try {
    return error?.code === 'UNSUPPORTED_REASONING_EFFORT'
  } catch {
    return false
  }
}

/**
 * Bound of an effort check: while `/advisor model … effort=<id>` waits for
 * it, its pending marker refuses every other /advisor command.
 */
const EFFORT_CHECK_MS = 10_000
const EFFORT_TIMEOUT = `the check timed out after ${EFFORT_CHECK_MS / 1000} s`

/**
 * One EFFORT_CHECK_MS deadline: the signal passed to the llm calls, a promise
 * that rejects when the deadline passes, and clear(), which the caller runs
 * in a finally block.
 */
function effortDeadline() {
  const controller = new AbortController()
  let timer
  const expired = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(EFFORT_TIMEOUT)
      // Reject before aborting: a call that rejects from its abort listener
      // must not win the race with its own reason.
      reject(error)
      controller.abort(error)
    }, EFFORT_CHECK_MS)
  })
  expired.catch(() => {}) // observed by the races below; never unhandled
  return { signal: controller.signal, expired, clear: () => clearTimeout(timer) }
}

/**
 * Check a stored or requested effort with the spawn's own preflight,
 * llm.resolveCallConfig, before `deadline` passes. Never throws.
 * @returns {Promise<{ ok: true } | { unsupported: true, efforts: object[] | undefined } | { reason: string }>}
 *   `efforts`: what the model advertises, from a best-effort resolveModelInfo
 *   under the same deadline (undefined when that list is unavailable);
 *   `reason`: why the effort could not be checked.
 */
async function checkEffort(llm, route, deadline) {
  const { provider, model, effort } = route
  try {
    await Promise.race([llm.resolveCallConfig({ provider, model, reasoningEffort: effort }, deadline.signal), deadline.expired])
    return { ok: true }
  } catch (error) {
    // Once the deadline has passed, any rejection is the timeout.
    if (deadline.signal.aborted) return { reason: EFFORT_TIMEOUT }
    // Credentials, provider setup and other failures are not an unsupported effort.
    if (!isUnsupportedEffort(error)) return { reason: describe(error) }
  }
  try {
    const info = await Promise.race([llm.resolveModelInfo(provider, model, deadline.signal), deadline.expired])
    if (info === null || typeof info !== 'object') return { unsupported: true, efforts: undefined }
    // No reasoning entry: the model advertises no efforts at all.
    const efforts = info.reasoning === undefined ? [] : info.reasoning?.efforts
    return { unsupported: true, efforts: Array.isArray(efforts) ? efforts : undefined }
  } catch {
    return { unsupported: true, efforts: undefined }
  }
}

/** The advertised efforts as `id (name)`, for a refused or no longer offered effort; never throws. */
function advertisedEfforts(route, efforts) {
  const unavailable = 'The list of advertised efforts is unavailable.'
  if (efforts === undefined) return unavailable
  try {
    const listed = efforts.flatMap((effort) => {
      const id = effort?.id
      if (typeof id !== 'string' || id === '') return []
      const name = effort.name
      return [typeof name === 'string' && name !== '' ? `${id} (${name})` : id]
    })
    if (listed.length === 0) return `${route.provider}/${route.model} advertises no reasoning efforts.`
    return `Advertised efforts: ${listed.join(', ')}.`
  } catch {
    return unavailable
  }
}

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
    // 7: saved routes may carry an effort; older cached state is rebuilt from the log.
    stateVersion: 7,
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

  // Optional and bound late, as the task board is: without the
  // working-directory service the verifier boundary stays installed and
  // denies every verifier, because its workspace root is unknown.
  let workingDirectory
  ctx.inject(['workingDirectory'], (directoryCtx) => {
    directoryCtx.effect(() => {
      workingDirectory = directoryCtx.workingDirectory
      return () => { workingDirectory = undefined }
    }, 'advisor: verifier working directory')
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
      {
        workspaceOf: (agent) => {
          try {
            return workingDirectory?.get(agent.session)
          } catch {
            return undefined
          }
        },
        ledger,
      },
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

  /** The llm service, read at call time: optional, so neither injected nor cached. */
  const llmService = () => {
    try {
      return ctx.get?.('llm')
    } catch {
      return undefined
    }
  }

  /**
   * Notes for stored efforts that the spawn preflight no longer accepts, one
   * line each; '' when none, or when that cannot be checked now (best effort:
   * the llm is unavailable, fails, or misses the shared deadline). A stale
   * effort is reported, never cleared. Never throws, so status always answers.
   */
  const effortNotes = async (state) => {
    try {
      const stored = [['Advisor model', 'model', state.advisorModel], ['Verifier model', 'verifier-model', state.verifierModel]]
        .filter(([, , route]) => typeof route?.effort === 'string')
      if (stored.length === 0) return ''
      const llm = llmService()
      if (typeof llm?.resolveCallConfig !== 'function') return ''
      const deadline = effortDeadline()
      try {
        const results = await Promise.all(stored.map(async ([noun, command, route]) => ({ noun, command, route, result: await checkEffort(llm, route, deadline) })))
        return results.filter(({ result }) => result.unsupported === true)
          .map(({ noun, command, route, result }) => `${noun} effort ${route.effort} is no longer offered by ${route.provider}/${route.model}; spawns on it fail until you reset it with ${effortReset(command, route)}. ${advertisedEfforts(route, result.efforts)}\n`)
          .join('')
      } finally {
        deadline.clear()
      }
    } catch {
      return ''
    }
  }

  ctx.inject(['commands'], (commandCtx) => {
    const USAGE = 'Usage: /advisor [on|off|status|model inherit|model <provider>/<model> [effort=<id>]|verifier-model inherit|verifier-model <provider>/<model> [effort=<id>]]'
    /**
     * Why a requested effort cannot be set now, or undefined when the spawn
     * preflight accepts it. Only called with an effort, after the route is
     * authorized; bounded by EFFORT_CHECK_MS so the pending marker is not
     * left blocking. Never throws: whatever goes wrong refuses the setting.
     */
    const effortRefusal = async (route, noun) => {
      const unchecked = (reason) => `${noun} effort ${route.effort} for ${route.provider}/${route.model} could not be checked: ${reason}; nothing was changed.`
      try {
        const llm = llmService()
        if (typeof llm?.resolveCallConfig !== 'function') return unchecked('the llm service is unavailable')
        const deadline = effortDeadline()
        let result
        try {
          result = await checkEffort(llm, route, deadline)
        } finally {
          deadline.clear()
        }
        if (result.ok === true) return undefined
        if (result.unsupported === true) {
          return `${noun} effort ${route.effort} is not offered by ${route.provider}/${route.model}; nothing was changed. ${advertisedEfforts(route, result.efforts)}`
        }
        return unchecked(result.reason)
      } catch (error) {
        return unchecked(describe(error))
      }
    }
    const setRoute = async (agent, raw, prefix, noun) => {
      const setting = raw.slice(prefix.length).trim()
      const route = parseModelSetting(setting)
      if (route === undefined) {
        const usage = `Usage: /advisor ${prefix.trim()} inherit|<provider>/<model> [effort=<id>]`
        return { kind: 'error', text: inheritWithEffort(setting) ? `${usage}; Inherit takes no effort.` : usage }
      }
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
        // The fold stores exactly this parsed route on success, so the id is
        // checked verbatim; a refusal stores nothing.
        if (route.effort !== undefined) {
          const refusal = await effortRefusal(route, noun)
          if (refusal !== undefined) return { kind: 'error', text: refusal }
        }
      }
      return {
        kind: 'success',
        text: route === null
          ? `${noun} set to Inherit for this session. Normal subagent defaults apply when Advisor is on.`
          : `${noun} set to ${routeLabel(route)} for this session. It is used when Advisor is on.`,
      }
    }
    commandCtx.commands.register({
      definitionId: 'dsh-plugin-advisor',
      name: 'advisor',
      description: 'Toggle the in-process advisor and read-only verification, and choose their models, for this session',
      input: { hint: '[on|off|status|model inherit|provider/model [effort=id]|verifier-model inherit|provider/model [effort=id]]' },
      handler: async ({ agent, rawInput, commandId }) => {
        const raw = rawInput.trim()
        const arg = raw.toLowerCase()
        const state = projection.stateOf(agent.session)
        const pending = pendingAdvisor(state)
        if (arg === 'status') {
          const runs = ledger === undefined ? undefined : await ledger.recentLedger()
          if (pending !== null) return { kind: 'success', text: `Advisor is updating (${pending.target}) for this session.` }
          const unusable = ledger?.writableProblem()
          const data = ledger === undefined
            ? `${DATA_DIR_NOT_CONFIGURED}\nReason: ${problem}. Advisor runs are refused until it is set.`
            : `Data directory: ${ledger.dir}\n`
              + (unusable === undefined ? '' : `${dataDirUnusable(unusable)} Advisor runs are refused until then.\n`)
              + `Recent advisor runs:\n${runs}`
          const notes = await effortNotes(state)
          return {
            kind: 'success',
            text: `${state.active ? 'Advisor is on; verification is automatic' : 'Advisor is off; verification is disabled'} for this session.\n`
              + `Advisor model: ${modelLabel(state.advisorModel ?? null)}. Verifier model: ${modelLabel(state.verifierModel)}. Both apply when Advisor is on.\n`
              + notes
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
        if (pending !== null && pending.commandId !== commandId) {
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
