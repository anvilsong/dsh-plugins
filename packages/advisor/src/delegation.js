// Delegation tools for the lead, mounted only when they are missing.
//
// The four shipped Agent presets do not all expose the same tools. Standard,
// cordis and ptc declare a delegation group; minimal does not. The Advisor
// needs subagent, wait_agent, list_agents and send_message (and, for the
// router's discovery step, list_subagent_models). This module mounts the host's
// existing tool-subagent and tool-subagent-control packages on a root Agent's
// own scope while Advisor is on, and disposes those mounts on off, agent
// disposal and plugin unload. It never replaces an existing definition, and it
// never mounts for a non-root Agent (in particular not for an advisor child).
//
// This is lifecycle plumbing, not a new tool and not a relaxation of a guard:
// the child guard still allows only glob, grep, read and its submit tool.
// Scoped registrations stay visible when a global restriction hides tools, so
// an Agent that deliberately restricted delegation must not turn Advisor on
// expecting the restriction to remain; turning Advisor off removes the mounts.
//
// Host package exports (read in the app archive):
// - dsh-tool-subagent/src/index.ts:37-38: { name, inject: ['tools', 'subagents',
//   'systemPrompt', 'sessionProjections'] }; apply(ctx, config) at :149-160;
//   config at :82-102 includes provider, toolName, modelSelection,
//   modelDiscovery and agentPreset/allowedAgentPresets.
// - dsh-tool-subagent-control/src/index.ts:20-21: { name, inject: ['tools',
//   'subagents', 'agents', 'systemPrompt'] }; apply at :39-42 registers
//   list_agents and wait_agent; :43-84 registers send_message and the identity
//   context; interrupt:false omits interrupt_agent.
// - agents service list(): live agents in registration order; agent/created is
//   serial after factory setup; sessionProjections.onChanged gives the active
//   value of the advisor view for each Session.

export const SUBAGENT_PACKAGE = '@deepseek-ai/dsh-tool-subagent'
export const CONTROL_PACKAGE = '@deepseek-ai/dsh-tool-subagent-control'

const CONTROL_TOOLS = Object.freeze(['wait_agent', 'list_agents', 'send_message'])
const MAX_REASON = 240

function describe(error) {
  try {
    const text = error instanceof Error ? String(error.message) : String(error)
    return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}…` : text
  } catch {
    return 'an unreadable error'
  }
}

/** Load one host plugin package once, with a reason instead of a throw. */
export async function loadHostPlugin(specifier, load = (name) => import(name)) {
  try {
    const module = await load(specifier)
    if (typeof module?.apply !== 'function') return { reason: `${specifier} has no apply function` }
    const name = typeof module.name === 'string' && module.name !== '' ? module.name : specifier
    return { plugin: Object.freeze({ name, inject: module.inject, apply: module.apply }) }
  } catch (error) {
    return { reason: `${specifier} did not load: ${describe(error)}` }
  }
}

/** Load the two delegation packages once at apply, never in a start listener. */
export function startDelegationLoad(load) {
  const ready = Promise.all([
    loadHostPlugin(SUBAGENT_PACKAGE, load),
    loadHostPlugin(CONTROL_PACKAGE, load),
  ]).then(([subagent, control]) => ({ subagent, control }), (error) => ({ reason: describe(error) }))
  return () => ready
}

function missing(agent, name) {
  try {
    return agent.ctx.tools.get(name, agent) === undefined
  } catch {
    return false
  }
}

async function mountOne(agent, plugin, config) {
  let fiber
  try {
    fiber = agent.ctx.plugin(plugin, config)
    await fiber
  } catch (error) {
    if (fiber !== undefined) {
      try { await fiber.dispose() } catch { /* the failed fiber may be gone */ }
    }
    throw error
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    try {
      const result = fiber.dispose()
      if (typeof result?.catch === 'function') result.catch(() => {})
    } catch { /* already disposed */ }
  }
}

/**
 * Install the per-Agent lifecycle for missing delegation tools.
 * @param {object} ctx host context with agents, subagents, tools and projections
 * @param {{ projection: { stateOf(session: object): { active: boolean } },
 *   delegation: () => Promise<object>, logger?: object }} options
 * @returns {() => void} disposes every live mount
 */
export function installDelegationSupport(ctx, { projection, delegation, logger }) {
  const byAgent = new Map()
  const pending = new Map()
  const dead = new Set()
  const log = (level, text) => {
    try { logger?.[level]?.(`advisor: ${text}`) } catch { /* diagnostics are optional */ }
  }
  const rootOf = (agent) => {
    try {
      const root = ctx.subagents.rootOf(agent)
      return root?.id === agent.id ? root : undefined
    } catch {
      return undefined
    }
  }
  const disposeAgent = (agent) => {
    dead.add(agent.id)
    const held = byAgent.get(agent.id)
    if (held === undefined) return
    byAgent.delete(agent.id)
    for (const dispose of held) {
      try { dispose() } catch { /* a failed disposer must not stop the others */ }
    }
  }
  const mountFor = async (agent) => {
    const root = rootOf(agent)
    if (root === undefined) return
    const isActive = () => {
      try { return projection.stateOf(root.session).active === true } catch { return false }
    }
    if (!isActive()) {
      disposeAgent(agent)
      return
    }
    // An on event after an off must not cancel a mount already in flight; a
    // final off or a disposed Agent wins at settlement below.
    dead.delete(agent.id)
    if (byAgent.has(agent.id)) return
    if (pending.has(agent.id)) return pending.get(agent.id)
    const work = (async () => {
      // A missing discovery tool alone never justifies a second subagent tool:
      // the host package provides both, and duplicate names are not allowed.
      const needSubagent = missing(agent, 'subagent')
      const needControl = CONTROL_TOOLS.some((name) => missing(agent, name))
      if (!needSubagent && !needControl) return []
      const loaded = await delegation()
      const held = []
      if (needSubagent && loaded.subagent?.plugin !== undefined) {
        try {
          held.push(await mountOne(agent, loaded.subagent.plugin, {
            provider: 'spawn',
            toolName: 'subagent',
            modelSelection: true,
            modelDiscovery: true,
          }))
          log('info', `subagent tool mounted for the root Agent on ${root.session.id}`)
        } catch (error) {
          log('warn', `could not mount the subagent tool on ${root.session.id}: ${describe(error)}`)
        }
      } else if (needSubagent) {
        log('warn', `subagent tool unavailable on ${root.session.id}: ${loaded.subagent?.reason ?? 'the package is still loading'}`)
      }
      if (needControl && loaded.control?.plugin !== undefined) {
        try {
          held.push(await mountOne(agent, loaded.control.plugin, { interrupt: false }))
          log('info', `subagent control tools mounted for the root Agent on ${root.session.id}`)
        } catch (error) {
          log('warn', `could not mount subagent control tools on ${root.session.id}: ${describe(error)}`)
        }
      } else if (needControl) {
        log('warn', `subagent control tools unavailable on ${root.session.id}: ${loaded.control?.reason ?? 'the package is still loading'}`)
      }
      return held
    })()
    pending.set(agent.id, work)
    try {
      const held = await work
      if (dead.has(agent.id) || !isActive()) {
        for (const dispose of held) {
          try { dispose() } catch { /* a cancelled mount must still release */ }
        }
      } else if (held.length > 0) {
        byAgent.set(agent.id, held)
      }
    } finally {
      pending.delete(agent.id)
    }
  }
  const reconcile = (agent) => mountFor(agent).catch((error) => {
    log('warn', `delegation support failed for an Agent: ${describe(error)}`)
  })
  const created = ctx.on?.('agent/created', ({ agent }) => reconcile(agent)) ?? (() => {})
  const disposed = ctx.on?.('agent/disposed', ({ agent }) => disposeAgent(agent)) ?? (() => {})
  const changed = ctx.sessionProjections?.onChanged?.((session, key, value) => {
    if (key !== 'advisor') return
    for (const agent of ctx.agents.list()) {
      const root = rootOf(agent)
      if (root !== undefined && root.session.id === session.id) {
        if (value.active === true) void reconcile(agent)
        else disposeAgent(agent)
      }
    }
  }) ?? (() => {})
  for (const agent of ctx.agents.list?.() ?? []) void reconcile(agent)
  return () => {
    try { created() } catch { /* already disposed */ }
    try { disposed() } catch { /* already disposed */ }
    try { changed() } catch { /* already disposed */ }
    for (const agent of ctx.agents.list?.() ?? []) disposeAgent(agent)
    byAgent.clear()
  }
}
