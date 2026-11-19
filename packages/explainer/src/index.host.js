import { z } from 'zod'
import { resolvePagesDir } from './pages-dir.js'
import { COMMAND_NAME, foldExplainer, INITIAL_EXPLAINER_STATE, parseExplainerArg, pendingExplainer, viewExplainer } from './state.js'

export const name = 'explainer'

export const inject = ['systemPrompt', 'sessionProjections']

const POLICY_HEAD = `Explainer style is active for this session. When the user asks you to explain something, or wants to understand, compare or walk through it, use the lowest form that serves. Keep a short answer short: this style never makes an answer longer, and it overrides the page rules below.\n- Short prose: for a definition, a procedure or a warning of about three paragraphs or fewer. Keep sentences to 20 words for procedures and 25 for descriptions. Use active voice, one instruction per sentence, one term per concept used the same way each time, no phrasal verbs or idioms, and a numbered list for steps. These limits apply to this form only.\n- Text diagram: when the point is structure, flow, state, dependencies or sequence, draw it with plain text or box-drawing characters in the chat. Never paste Mermaid or SVG source into the chat.\n`
const POLICY_TAIL = `\n- Video: never make one on your own. If the user asks for one, state the cost and confirm first.\nThis style applies to explanations only, not to code edits, tool output, status reports, plans, reviews or final reports. Section rules from other active modes still apply to every final answer.`

/** The page bullet without a folder: the agent offers no page and answers a request in the chat. */
const PAGES_UNAVAILABLE_BULLET = '- One-file HTML page: pages cannot be saved in this session because no usable folder is available. Do not offer one. If the user asks for a page, say that pages are unavailable here and give the explanation in the chat.'

/**
 * The style text, naming the folder for pages. The plugin writes no page and
 * adds no tool: the text only tells the agent where its own file tools may
 * write, and asks it to present the file. The folder sits inside one backtick
 * span, which the path rules make unbreakable (a backtick is refused).
 * @param {string | undefined} pagesDir the resolved folder, or undefined when no folder is usable
 */
export function policyFor(pagesDir) {
  if (pagesDir === undefined) return POLICY_HEAD + PAGES_UNAVAILABLE_BULLET + POLICY_TAIL
  if (typeof pagesDir !== 'string' || pagesDir === '') throw new TypeError('policyFor needs a folder string or undefined')
  const bullet = `- One-file HTML page: when the topic has more than about five interacting parts, or the user would want to explore or compare it, offer it in one line (for example: Want this as an interactive HTML page?). Build it without asking only when the user asked for a page, a visual or an interactive explanation. It is one self-contained file with inline CSS and JavaScript, no build step and nothing loaded from the network. Write it to \`${pagesDir}/YYYY-MM-DD-<slug>/index.html\`, where the slug uses only lowercase letters, digits and hyphens. Make a new folder each time, never overwrite or delete anything, and touch nothing else under the DSH home. Writing and checking files inside this folder is allowed even where other rules say not to touch the DSH home. Write the file yourself, and never hand the writing to another agent. Never write it into the project repository. Then confirm that the file exists and present it to the user as a deliverable when this session lets you; otherwise give the absolute path and say the file is on the host machine. Do not open it on the host machine unless the user asks. If you cannot write the file, say so and give the explanation in the chat instead. A page that should live inside this app, or that the user wants to keep or update, is not this form.`
  return POLICY_HEAD + bullet + POLICY_TAIL
}

// The placeholder text the tests pin; apply() builds the real text with the resolved folder.
export const POLICY = policyFor('<dataDir>')

/** The text while no folder is usable. */
export const PAGES_UNAVAILABLE_POLICY = policyFor(undefined)

const USAGE = 'Usage: /explain-style on|off|status'

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

/** The DSH home from the launcher's profile data; optional, so it is not injected. */
function profileHome(ctx) {
  try {
    const home = ctx.get?.('profileContext')?.home
    return typeof home === 'string' ? home : undefined
  } catch {
    return undefined
  }
}

/** One warning through the optional logger; never throws. */
function warn(ctx, text) {
  try {
    ctx.logger?.warn?.(text)
  } catch {
    // A broken logger must not stop the plugin.
  }
}

/**
 * The style text for this host, decided once: config.dataDir, else
 * <DSH home>/explainer. No usable folder gives the unavailable text and one
 * warning; there is no environment or other fallback, and nothing throws.
 */
function resolvedPolicy(ctx, config) {
  const hint = 'Pages are unavailable until a valid dataDir is set in the explainer plugin config.'
  try {
    const pagesDir = resolvePagesDir(config, { home: profileHome(ctx) })
    if (pagesDir !== undefined) return policyFor(pagesDir)
    warn(ctx, `explainer: no dataDir is configured and no absolute DSH home is known. ${hint}`)
  } catch (error) {
    let reason
    try {
      reason = error instanceof Error ? String(error.message) : String(error)
    } catch {
      reason = 'an unreadable error'
    }
    warn(ctx, `explainer: ${reason}. ${hint}`)
  }
  return PAGES_UNAVAILABLE_POLICY
}

export async function apply(ctx, config = {}) {
  const policy = resolvedPolicy(ctx, config)
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
      return projection.stateOf(context.agent.session).on ? policy : ''
    },
  })

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: 'dsh-plugin-explainer',
      name: COMMAND_NAME,
      description: 'Turn the explainer style on or off for this session',
      input: { hint: '[on|off|status]' },
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
              ? `Explainer style is updating to ${pending.arg}.`
              : `Explainer style: ${state.on ? 'on' : 'off'}.`,
          }
        }
        if (pending && pending.commandId !== commandId) {
          return { kind: 'error', text: 'Explainer style is already updating. Try again after it finishes.' }
        }
        return {
          kind: 'success',
          text: `Explainer style set to ${arg}.`,
        }
      },
    })
  })
}
