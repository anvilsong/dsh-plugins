import { randomUUID } from 'node:crypto'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

export const name = 'provider-login'
export const inject = ['authorization', 'userQuestions', 'commands', 'credentials']

const PROVIDER = /^[a-z0-9][a-z0-9-]*$/
const STATUS_PROVIDERS = new Set(['openai-codex', 'anthropic'])
const USAGE = 'Usage: /provider-login <provider> [oauth|api-key]. Example: /provider-login openai-codex'

function validate(provider, method) {
  if (!PROVIDER.test(provider) || !['oauth', 'api-key'].includes(method)) throw new Error(USAGE)
}

function createQueue() {
  const values = []
  const waiters = []
  let closed = false
  let failure
  const wake = () => {
    const current = waiters.splice(0)
    for (const waiter of current) {
      if (failure !== undefined) waiter.reject(failure)
      else if (values.length > 0) waiter.resolve({ value: values.shift(), done: false })
      else if (closed) waiter.resolve({ value: undefined, done: true })
      else waiters.push(waiter)
    }
  }
  return {
    push(value) { values.push(value); wake() },
    close() { closed = true; wake() },
    fail(error) { failure = error; wake() },
    async *iterate() {
      while (true) {
        if (failure !== undefined) throw failure
        if (values.length > 0) { yield values.shift(); continue }
        if (closed) return
        const next = await new Promise((resolve, reject) => waiters.push({ resolve, reject }))
        if (next.done) return
        yield next.value
      }
    },
  }
}

/** A two-way Remote stream for provider OAuth and interactive-key flows. */
export class ProviderLoginService extends TypertRemoteService {
  static provide = 'providerLogin'

  constructor(ctx) {
    super(ctx)
    Remote({ mode: 'stream' })(this.begin, {
      name: 'begin',
      addInitializer: (fn) => fn.call(this),
    })
    Remote(this.status, {
      name: 'status',
      addInitializer: (fn) => fn.call(this),
    })
  }

  async status(request) {
    const provider = request?.provider
    if (!STATUS_PROVIDERS.has(provider)) {
      throw new Error('provider-login: status supports only openai-codex and anthropic')
    }
    const record = await this.ctx.credentials.readRecord(`llm-pi-ai/${provider}`)
    return { configured: record !== undefined }
  }

  begin(request, signal) {
    validate(request.provider, request.method ?? 'oauth')
    return this.run(request, signal)
  }

  async *run(request, signal) {
    const queue = createQueue()
    const pending = new Map()
    const uplink = this.ctx.invocation?.uplink?.()
    if (!uplink) throw new Error('provider-login: Remote uplink is required')

    const input = (async () => {
      try {
        for await (const item of uplink) {
          if (item?.type !== 'answer') continue
          const waiter = pending.get(item.id)
          if (!waiter) continue
          pending.delete(item.id)
          waiter.resolve(item.answer)
        }
      } catch (error) {
        queue.fail(error)
      }
    })()

    const authorization = this.ctx.authorization.begin({
      key: `llm-pi-ai/${request.provider}`,
      method: request.method ?? 'oauth',
      signal,
      interaction: {
        notify: (notice) => queue.push({ type: 'notice', notice }),
        prompt: (prompt) => {
          const id = randomUUID()
          queue.push({ type: 'prompt', id, prompt })
          return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject })
            signal?.addEventListener('abort', () => {
              pending.delete(id)
              reject(signal.reason ?? new Error('provider-login: aborted'))
            }, { once: true })
          })
        },
      },
    }).then((outcome) => {
      queue.push({ type: 'settled', status: outcome.status })
      queue.close()
    }, (error) => {
      queue.fail(error)
    })

    try {
      yield* queue.iterate()
      await authorization
    } finally {
      await uplink.return?.()
      await input
      for (const waiter of pending.values()) waiter.reject(new Error('provider-login: stream closed'))
      pending.clear()
      queue.close()
    }
  }
}

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
  new ProviderLoginService(ctx)
  ctx.commands.register({
      name: 'provider-login',
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
