import { z } from 'zod'
import { COMMAND_NAME, foldExplainer, INITIAL_EXPLAINER_STATE, parseExplainerArg, pendingExplainer, viewExplainer } from './state.js'

export const name = 'explainer'

export const inject = ['systemPrompt', 'sessionProjections']

export const POLICY = `Explainer style is active for this session. When the user asks you to explain something, or wants to understand, compare or walk through it, use the lowest form that serves. Keep a short answer short: this style never makes an answer longer, and it overrides the page rules below.\n- Short prose: for a definition, a procedure or a warning of about three paragraphs or fewer. Keep sentences to 20 words for procedures and 25 for descriptions. Use active voice, one instruction per sentence, one term per concept used the same way each time, no phrasal verbs or idioms, and a numbered list for steps. These limits apply to this form only.\n- Text diagram: when the point is structure, flow, state, dependencies or sequence, draw it with plain text or box-drawing characters in the chat. Never paste Mermaid or SVG source into the chat.\n- One-file HTML page: when the topic has more than about five interacting parts, or the user would want to explore or compare it, offer it in one line (for example: Want this as an interactive HTML page?). Build it without asking only when the user asked for a page, a visual or an interactive explanation. It is one self-contained file with inline CSS and JavaScript and no build step, written to ~/explainers/YYYY-MM-DD-<slug>/index.html and never into the project repository. Open it with the system opener if one exists, give its path, and confirm that the file exists. If you cannot write the file, say so and give the explanation in the chat instead.\n- Video: never make one on your own. If the user asks for one, state the cost and confirm first.\nThis style applies to explanations only, not to code edits, tool output, status reports, plans, reviews or final reports. Section rules from other active modes still apply to every final answer.`

const USAGE = 'Usage: /output-style explainer|off|status'

const failureSchema = z.object({
  count: z.number().int().nonnegative(),
  text: z.string(),
  arg: z.enum(['on', 'off']),
}).nullable()
const stateSchema = z.object({
  on: z.boolean(),
  pending: z.object({
    arg: z.enum(['on', 'off']),
    commandId: z.string(),
    startedAt: z.number(),
  }).nullable(),
  failure: failureSchema,
})
const viewSchema = z.object({
  on: z.boolean(),
  pending: z.boolean(),
  pendingSince: z.number().nullable(),
  failure: failureSchema,
})

export async function apply(ctx) {
  const projection = await ctx.sessionProjections.register({
    key: 'explainer',
    stateVersion: 1,
    stateSchema,
    init: () => ({ ...INITIAL_EXPLAINER_STATE }),
    apply: foldExplainer,
    wire: { viewSchema, view: viewExplainer },
  })

  // Present only while the switch is on; empty text adds nothing.
  ctx.systemPrompt.section({
    name: 'explainer:policy',
    order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY'),
    text: (context) => {
      if (context.agent === undefined) return ''
      return projection.stateOf(context.agent.session).on ? POLICY : ''
    },
  })

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: 'dsh-plugin-explainer',
      name: COMMAND_NAME,
      description: 'Set the output style for this session',
      input: { hint: '[explainer|off|status]' },
      handler: async ({ agent, rawInput, commandId }) => {
        // The fold parses the same text with the same function.
        const arg = parseExplainerArg(rawInput)
        if (arg === null) return { kind: 'error', text: USAGE }
        const state = projection.stateOf(agent.session)
        const pending = pendingExplainer(state)
        if (arg === 'status') {
          return {
            kind: 'success',
            text: pending
              ? `Output style is updating to ${pending.arg === 'on' ? 'explainer' : 'off'} for this session.`
              : `Output style: ${state.on ? 'explainer' : 'off'}.`,
          }
        }
        if (pending && pending.commandId !== commandId) {
          return { kind: 'error', text: 'Output style is already updating. Try again after it finishes.' }
        }
        return {
          kind: 'success',
          text: `Output style set to ${arg === 'on' ? 'explainer' : 'off'}.`,
        }
      },
    })
  })
}
