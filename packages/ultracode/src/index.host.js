import { z } from 'zod'
import { foldUltracode, INITIAL_ULTRACODE_STATE, viewUltracode } from './state.js'

export const name = 'ultracode'

export const inject = ['systemPrompt', 'sessionProjections', 'agentTeams']

export const POLICY = `Exhaustive mode is active for this session. Optimize for exhaustive correctness, not speed or token cost.

- Fan-out: For independent pieces whose results you only need returned, use available workflow or subagent orchestration. Run one well-scoped fan-out per phase and synthesize the results yourself.
- Durable roles: If team collaboration is enabled in this session, use it for roles that must persist across phases. Give each member a stable name and a distinct role, reuse existing members rather than creating duplicates, and track their work on the shared task board rather than in your own notes. If team collaboration is not enabled, do not simulate it; use ordinary subagents and continue.
- Coordination: Coordinate members through messages and the task board. Do not rely on interrupting running members.
- Verification: Have every material finding checked by an agent that did not produce it, instructed to refute it. Report only what survives, and label anything unverified.
- Effort: Do not narrow scope, skip verification, or reduce reasoning effort to finish sooner. Solo only on conversational turns or trivial mechanical edits.`

const stateSchema = z.object({
  active: z.boolean(),
  pending: z.boolean().nullable(),
  commandId: z.string().nullable(),
  teamEnabled: z.boolean(),
  teamBeforeOn: z.boolean().nullable(),
  teamChangedByUs: z.boolean(),
})

const viewSchema = z.object({
  active: z.boolean(),
  pending: z.boolean(),
  teamEnabled: z.boolean(),
})

export async function apply(ctx) {
  const projection = await ctx.sessionProjections.register({
    key: 'ultracode',
    stateVersion: 1,
    stateSchema,
    init: () => ({ ...INITIAL_ULTRACODE_STATE }),
    apply: foldUltracode,
    wire: {
      viewSchema,
      view: viewUltracode,
    },
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
      handler: async ({ agent, rawInput }) => {
        const arg = rawInput.trim().toLowerCase()
        const state = projection.stateOf(agent.session)
        if (arg === 'status') {
          return {
            kind: 'success',
            text: `${state.active ? 'Ultracode is on' : 'Ultracode is off'} for this session. AgentTeam is ${state.teamEnabled ? 'on' : 'off'}.`,
          }
        }
        if (arg !== '' && arg !== 'on' && arg !== 'off') {
          return { kind: 'error', text: 'Usage: /ultracode [on|off|status]' }
        }
        const active = arg === '' ? !state.active : arg === 'on'
        if (active && !state.active && !state.teamEnabled) {
          await ctx.agentTeams.setEnabled(agent, true)
        }
        if (!active && state.active && state.teamChangedByUs && state.teamEnabled) {
          await ctx.agentTeams.setEnabled(agent, false)
        }
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
