import { randomUUID } from 'node:crypto'

export const name = 'provider-login'
export const inject = ['authorization', 'userQuestions', 'commands']

const PROVIDER = /^[a-z0-9][a-z0-9-]*$/
const USAGE = 'Usage: /login <provider> [oauth|api-key]. Example: /login openai-codex'

function notify(agent, notice) {
  const parts = [notice.message]
  if (notice.url) parts.push(`Open: ${notice.url}`)
  if (notice.code) parts.push(`Code: ${notice.code}`)
  agent.session.append('user/message', {
    id: randomUUID(),
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: parts.join('\n\n') }],
  })
}

async function prompt(ctx, agent, request) {
  const id = 'provider-login'
  const result = await ctx.userQuestions.ask({
    agent,
    signal: request.signal,
    questions: [{
      id,
      header: 'Provider sign-in',
      question: request.message,
      options: request.kind === 'select'
        ? request.options.map((option) => ({
            label: option.label,
            ...option.description === undefined ? {} : { description: option.description },
          }))
        : [],
    }],
  })
  const answer = result.answers.find((item) => item.id === id)
  return answer?.custom ?? answer?.selected?.[0] ?? ''
}

export function apply(ctx) {
  ctx.commands.register({
      name: 'login',
      definitionId: 'dsh-plugin-provider-login',
      description: 'Start a provider OAuth or interactive-key sign-in flow.',
      source: { kind: 'user' },
      input: { hint: '<provider> [oauth|api-key]' },
      async handler({ agent, rawInput }) {
        const [provider, method = 'oauth', ...rest] = rawInput.trim().split(/\s+/)
        if (!provider || !PROVIDER.test(provider) || rest.length > 0 || !['oauth', 'api-key'].includes(method)) {
          return { kind: 'error', text: USAGE }
        }
        const outcome = await ctx.authorization.begin({
          key: `llm-pi-ai/${provider}`,
          method,
          interaction: {
            notify: (notice) => notify(agent, notice),
            prompt: (request) => prompt(ctx, agent, request),
          },
        })
        return {
          kind: outcome.status === 'authorized' ? 'success' : 'error',
          text: outcome.status === 'authorized'
            ? `${provider}: authorized. The next model request can use this provider.`
            : `${provider}: sign-in cancelled.`,
        }
      },
  })
}
