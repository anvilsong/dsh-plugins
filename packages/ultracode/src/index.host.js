import { z } from 'zod'
import { foldUltracode, INITIAL_ULTRACODE_STATE, viewUltracode, isDelegationTool, MAX_SPAWN_ATTEMPTS } from './state.js'

export const name = 'ultracode'

export const inject = ['systemPrompt', 'sessionProjections', 'tools']

export const POLICY = `Exhaustive mode is active for this session. Optimize for exhaustive correctness, not speed or token cost.

- Fan-out: For independent pieces whose results you only need returned, use available workflow or subagent orchestration. Run one well-scoped fan-out per phase and synthesize the results yourself.
- Durable roles: If team collaboration is enabled in this session, use it for roles that must persist across phases. Give each member a stable name and a distinct role, reuse existing members rather than creating duplicates, and track their work on the shared task board rather than in your own notes. If team collaboration is not enabled, do not simulate it; use ordinary subagents and continue.
- Coordination: Coordinate members through messages and the task board. Do not rely on interrupting running members.
- Verification: Have every material finding checked by an agent that did not produce it, instructed to refute it. Report only what survives, and label anything unverified.
- Effort: Do not narrow scope, skip verification, or reduce reasoning effort to finish sooner. Solo only on conversational turns or trivial mechanical edits.
- Budget: Host delegation limits are hard limits. On exhaustion, report what is unverified rather than quietly reducing rigor.`

const stateSchema = z.object({
  active: z.boolean(),
  pending: z.object({
    arg: z.boolean(),
    commandId: z.string(),
    startedAt: z.number(),
  }).nullable(),
  run: z.object({
    turn: z.number(),
    startedAt: z.number(),
    endedAt: z.number().nullable(),
    spawnAttempts: z.number(),
    stop: z.string().nullable(),
  }).nullable(),
})

const viewSchema = z.object({
  active: z.boolean(),
  pending: z.boolean(),
  run: z.object({
    turn: z.number(),
    startedAt: z.number(),
    endedAt: z.number().nullable(),
    spawnAttempts: z.number(),
    stop: z.string().nullable(),
  }).nullable(),
})

export async function apply(ctx) {
  const projection = await ctx.sessionProjections.register({
    key: 'ultracode',
    stateVersion: 4,
    stateSchema,
    init: () => ({ ...INITIAL_ULTRACODE_STATE }),
    apply: foldUltracode,
    wire: {
      viewSchema,
      view: viewUltracode,
    },
  })

  ctx.tools.guard((execution) => {
    if (!execution.agent || !isDelegationTool(execution.name)) return undefined
    const state = projection.stateOf(execution.agent.session)
    if (!state.active || !state.run || state.run.endedAt !== null) return undefined
    if (state.run.spawnAttempts < MAX_SPAWN_ATTEMPTS) return undefined
    return {
      reason: 'ultracode_budget_exhausted:spawns',
      info: {
        name: 'ultracode',
        code: 'ultracode_budget_exhausted',
        reason: 'spawns',
      },
    }
  })

  ctx.systemPrompt.section({
    name: 'ultracode:policy',
    order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY'),
    text: (context) => {
      if (context.agent === undefined) return ''
      return projection.stateOf(context.agent.session).active ? POLICY : ''
    },
  })

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: 'dsh-plugin-ultracode',
      name: 'ultracode',
      description: 'Toggle exhaustive multi-agent mode',
      input: { hint: '[on|off|status]' },
      handler: async ({ agent, rawInput, commandId }) => {
        const arg = rawInput.trim().toLowerCase()
        const state = projection.stateOf(agent.session)
        if (arg === 'status') {
          const run = state.run
          const runText = run
            ? ` ${run.endedAt === null ? 'Current' : 'Last'} run: ${run.spawnAttempts}/${MAX_SPAWN_ATTEMPTS} spawns · stop: ${run.stop ?? 'none'}.`
            : ''
          return {
            kind: 'success',
            text: `${state.active ? 'Ultracode is on' : 'Ultracode is off'} for this session.${runText}`,
          }
        }
        if (arg !== '' && arg !== 'on' && arg !== 'off') {
          return { kind: 'error', text: 'Usage: /ultracode [on|off|status]' }
        }
        if (state.pending && state.pending.commandId !== commandId) {
          return { kind: 'error', text: 'Ultracode is already updating. Try again after it finishes.' }
        }
        const active = arg === '' ? !state.active : arg === 'on'
        return {
          kind: 'success',
          text: active
            ? 'Ultracode on. The next model request will use exhaustive orchestration.'
            : 'Ultracode off. The next model request will use the normal workflow.',
        }
      },
    })
  })
}
