import { randomUUID } from 'node:crypto'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

const PROVIDER = /^[a-z0-9][a-z0-9-]*$/
const STATUS_PROVIDERS = new Set(['openai-codex', 'anthropic'])
const USAGE = 'Usage: /provider-login <provider>. Runs OAuth only; the sign-in link appears in a question. '
  + 'There is no api-key method: enter API keys in Settings → Models. Example: /provider-login openai-codex'
/** Error text of the card's Remote stream for a malformed request, kept as it was. */
const REQUEST_USAGE = 'Usage: /provider-login <provider> [oauth|api-key]. Example: /provider-login openai-codex'

function validate(provider, method) {
  if (!PROVIDER.test(provider) || !['oauth', 'api-key'].includes(method)) throw new Error(REQUEST_USAGE)
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

const QUESTION_ID = 'provider-login'
const HEADER = 'Provider sign-in'
const CANCEL = 'Cancel sign-in'

const cancelled = (provider) => `${provider}: sign-in cancelled.`
/** A userQuestions answer is clear text (no masking option exists), so keys are entered in Settings. */
const refusal = (provider) => `${provider}: /provider-login runs OAuth only, and a question cannot mask a typed secret. `
  + 'Enter API keys in Settings → Models.'

/** One notice as question text: its message, then the page and code it names. */
function noticeText(notice) {
  const lines = [notice.message]
  if (notice.url) lines.push(`Open: ${notice.url}`)
  if (notice.code) lines.push(`Code: ${notice.code}`)
  return lines.join('\n')
}

/** The flow's answer to one prompt: the typed text or the chosen option's id; undefined for a skip. */
function answerOf(request, result) {
  const answer = result?.answers?.find((item) => item.id === QUESTION_ID)
  const custom = answer?.custom ?? ''
  if (request.kind !== 'select') return custom === '' ? undefined : custom
  const label = answer?.selected?.[0]
  const chosen = request.options.find((option) => custom === ''
    ? option.label === label
    : option.label === custom || option.id === custom)
  return chosen?.id ?? (custom === '' ? undefined : custom)
}

/**
 * Run one OAuth sign-in for the command. The command appends nothing to the
 * session: every notice reaches the user inside a userQuestions question,
 * above the message of the prompt that follows it or, while the flow waits
 * with no prompt, in a question of its own that offers only Cancel sign-in.
 * That question closes when a prompt or a newer notice replaces it and when
 * the flow settles. A secret prompt, or any kind other than text and select,
 * cancels the sign-in and is never asked.
 * @param ctx - plugin context with authorization and userQuestions.
 * @param agent - the agent whose UI ran the command.
 * @param provider - provider id from the command line.
 * @param commandSignal - the command's own cancellation signal, if any.
 * @returns the command result.
 */
async function signIn(ctx, agent, provider, commandSignal) {
  const controller = new AbortController()
  const flow = controller.signal
  let text = cancelled(provider)
  const stop = (reason = cancelled(provider)) => {
    if (flow.aborted) return
    text = reason
    controller.abort(new Error(`provider-login: ${reason}`))
  }
  const withdraw = () => stop()
  commandSignal?.addEventListener('abort', withdraw, { once: true })
  if (commandSignal?.aborted) stop()

  const notices = []
  let prompts = 0
  let waiting
  let timer
  const ask = (question, options, signal) => ctx.userQuestions.ask({
    agent,
    signal,
    questions: [{ id: QUESTION_ID, header: HEADER, question, options }],
  })
  const closeWaiting = () => {
    clearTimeout(timer)
    timer = undefined
    waiting?.abort()
    waiting = undefined
  }
  const showWaiting = () => {
    timer = undefined
    if (flow.aborted || prompts > 0 || notices.length === 0) return
    const own = new AbortController()
    waiting = own
    // Any answer or failure of this question, other than its own withdrawal, cancels the sign-in.
    const settled = () => { if (!own.signal.aborted) stop() }
    new Promise((resolve) => { resolve(ask(notices.join('\n\n'), [{ label: CANCEL }], AbortSignal.any([own.signal, flow]))) })
      .then(settled, settled)
  }
  // One task later, so a prompt raised right after its notice carries that
  // notice instead of replacing a question that was shown for an instant.
  const schedule = () => {
    closeWaiting()
    if (!flow.aborted && prompts === 0 && notices.length > 0) timer = setTimeout(showWaiting, 0)
  }

  const interaction = {
    notify(notice) {
      if (flow.aborted) return
      notices.push(noticeText(notice))
      if (prompts === 0) schedule()
    },
    async prompt(request) {
      if (flow.aborted) throw flow.reason
      if (request.kind !== 'text' && request.kind !== 'select') {
        stop(refusal(provider))
        throw flow.reason
      }
      closeWaiting()
      const shown = notices.length
      const options = request.kind === 'select'
        ? request.options.map((option) => ({
            label: option.label,
            ...option.description === undefined ? {} : { description: option.description },
          }))
        : []
      const signal = request.signal === undefined ? flow : AbortSignal.any([request.signal, flow])
      prompts += 1
      let result
      try {
        result = await ask([...notices, request.message].join('\n\n'), options, signal)
      } catch (error) {
        // A flow withdrawing its own prompt (a browser callback won the race) keeps running.
        if (!request.signal?.aborted) stop()
        throw error
      } finally {
        prompts -= 1
        notices.splice(0, shown)
        schedule()
      }
      const answer = answerOf(request, result)
      if (answer === undefined) {
        stop()
        throw flow.reason
      }
      return answer
    },
  }

  try {
    const outcome = await ctx.authorization.begin({
      key: `llm-pi-ai/${provider}`,
      method: 'oauth',
      signal: flow,
      interaction,
    })
    return outcome.status === 'authorized'
      ? { kind: 'success', text: `${provider}: authorized. The next model request can use this provider.` }
      : { kind: 'error', text }
  } catch (error) {
    if (flow.aborted) return { kind: 'error', text }
    throw error
  } finally {
    commandSignal?.removeEventListener('abort', withdraw)
    closeWaiting()
    // Closes any question still open; the outcome above is already decided.
    controller.abort()
  }
}

export function mountProviderLogin(ctx) {
  new ProviderLoginService(ctx)
  ctx.commands.register({
      name: 'provider-login',
      definitionId: 'dsh-plugin-provider-login',
      description: 'Sign in to a provider with OAuth; the sign-in link appears in a question.',
      source: { kind: 'user' },
      input: { hint: '<provider> [oauth]' },
      async handler({ agent, rawInput, signal }) {
        const [provider, method = 'oauth', ...rest] = rawInput.trim().split(/\s+/)
        if (!provider || !PROVIDER.test(provider) || rest.length > 0 || !['oauth', 'api-key'].includes(method)) {
          return { kind: 'error', text: USAGE }
        }
        if (method === 'api-key') return { kind: 'error', text: refusal(provider) }
        return signIn(ctx, agent, provider, signal)
      },
  })
}
