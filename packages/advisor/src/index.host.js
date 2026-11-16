import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { foldAdvisor, INITIAL_ADVISOR_STATE, viewAdvisor } from './state.js'

export const name = 'advisor'
export const inject = ['systemPrompt', 'sessionProjections']

export const POLICY = `Advisor mode is active for this session. Use the advisor skill at major planning, design, and substantial review steps.
- Before every consult, reload the advisor skill and follow it. Do not consult from memory of the procedure.
- Do not consult for trivia, lookups, single-file or mechanical edits, or decisions the user already made.
- Send focused, sanitized briefings with minimal excerpts. Never send credentials, secrets, or whole sensitive files.
- Keep consults bounded: normally at most three per task. The advisor is advisory and never blocks work.
- The advisor has no tools and cannot write code. Do not call subagent_claude_code or subagent_codex as a substitute.
- A verdict exists only with its ledger consult_id. Never claim or summarize an advisor verdict without that ID. After context summarization, re-read the ledger before relying on a prior verdict.`

const stateSchema = z.object({
  active: z.boolean(),
  pending: z.object({ arg: z.boolean(), commandId: z.string(), startedAt: z.number() }).nullable(),
})
const viewSchema = z.object({ active: z.boolean(), pending: z.boolean() })

function ledgerPath() {
  return process.env.ADVISOR_LEDGER ?? path.join(os.homedir(), '.local/state/advisor/sessions.jsonl')
}

async function recentLedger() {
  try {
    const text = await fs.readFile(ledgerPath(), 'utf8')
    const entries = text.split('\n').filter(Boolean).map((line) => {
      try {
        const entry = JSON.parse(line)
        if (entry.status === 'started') return null
        return `${entry.consult_id ?? 'unknown'} ${entry.advisor ?? 'unknown'} ${entry.status ?? 'unknown'} ${entry.topic ?? 'unset'}`
      } catch {
        return null
      }
    }).filter(Boolean).slice(-3)
    return entries.length ? entries.join('\n') : 'No consults recorded.'
  } catch {
    return 'No consults recorded.'
  }
}

export async function apply(ctx) {
  const projection = await ctx.sessionProjections.register({
    key: 'advisor',
    stateVersion: 1,
    stateSchema,
    init: () => ({ ...INITIAL_ADVISOR_STATE }),
    apply: foldAdvisor,
    wire: { viewSchema, view: viewAdvisor },
  })

  ctx.systemPrompt.section({
    name: 'advisor:policy',
    order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY'),
    text: (context) => {
      if (context.agent === undefined) return ''
      return projection.stateOf(context.agent.session).active ? POLICY : ''
    },
  })

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: 'dsh-plugin-advisor',
      name: 'advisor',
      description: 'Toggle advisor consultations for this session',
      input: { hint: '[on|off|status]' },
      handler: async ({ agent, rawInput, commandId }) => {
        const arg = rawInput.trim().toLowerCase()
        const state = projection.stateOf(agent.session)
        if (arg === 'status') {
          const ledger = await recentLedger()
          return {
            kind: 'success',
            text: `${state.active ? 'Advisor is on' : 'Advisor is off'} for this session.\nRecent consults:\n${ledger}`,
          }
        }
        if (arg !== '' && arg !== 'on' && arg !== 'off') {
          return { kind: 'error', text: 'Usage: /advisor [on|off|status]' }
        }
        if (state.pending && state.pending.commandId !== commandId) {
          return { kind: 'error', text: 'Advisor is already updating. Try again after it finishes.' }
        }
        const active = arg === '' ? !state.active : arg === 'on'
        return {
          kind: 'success',
          text: active
            ? 'Advisor on. Major planning and review steps will use the advisor skill.'
            : 'Advisor off. The normal workflow will continue without advisor consults.',
        }
      },
    })
  })
}
