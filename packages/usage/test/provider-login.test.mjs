import assert from 'node:assert/strict'
import test from 'node:test'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { mountProviderLogin, ProviderLoginService } from '../src/providers/login.js'

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

function questionError(code, message = `user question ${code}`) {
  const error = new Error(message)
  error.name = 'UserQuestionError'
  error.code = code
  return error
}

function track(promise) {
  const state = { settled: false }
  promise.then(() => { state.settled = true }, () => { state.settled = true })
  return state
}

/**
 * Command harness whose fakes follow the host rules the command meets:
 * - the session throws on a user/message append without a surfaceOp marker,
 *   like dsh-session Session.append (surface.ts:315-318);
 * - authorization.begin mirrors dsh-authorization (src/index.ts:283-447): it
 *   swallows a notify that throws, links the request signal to the flow's
 *   signal, and settles as cancelled once that signal aborts;
 * - userQuestions.ask rejects with ASK_ABORTED when its signal aborts, like
 *   the Web answerer (dsh-client-ui-user-questions contract/slots.ts:187-199).
 * @param run - the scripted flow, given { method, signal, notify, prompt }.
 */
function harness(run = async () => {}) {
  let command
  let onAsk = () => {}
  const appends = []
  const swallowed = []
  const begins = []
  const asks = []
  const flowPrompts = []
  const ctx = {
    reflect: { provide() {} },
    commands: { register(value) { command = value } },
    authorization: {
      async begin(request) {
        begins.push(request)
        if (request.signal?.aborted) return { status: 'cancelled' }
        const controller = new AbortController()
        const withdraw = () => controller.abort(request.signal.reason)
        request.signal?.addEventListener('abort', withdraw, { once: true })
        const withdrawn = new Promise((resolve) => {
          controller.signal.addEventListener('abort', () => resolve('withdrawn'), { once: true })
        })
        const running = run({
          method: request.method,
          signal: controller.signal,
          notify(notice) {
            try { request.interaction.notify(notice) } catch (error) { swallowed.push(error) }
          },
          prompt(prompt) {
            const answer = request.interaction.prompt(prompt)
            flowPrompts.push(track(answer))
            return answer
          },
        })
        try {
          if (await Promise.race([running.then(() => 'ran'), withdrawn]) === 'withdrawn') {
            running.catch(() => {})
            return { status: 'cancelled' }
          }
          return { status: 'authorized' }
        } catch (error) {
          if (controller.signal.aborted) return { status: 'cancelled' }
          throw error
        } finally {
          request.signal?.removeEventListener('abort', withdraw)
        }
      },
    },
    userQuestions: {
      ask(request) {
        const item = request.questions[0]
        const entry = { request, text: item.question, options: item.options ?? [], settled: false, aborted: false }
        entry.promise = new Promise((resolve, reject) => {
          const finish = (settleWith) => (value, extra) => {
            if (entry.settled) return
            entry.settled = true
            request.signal?.removeEventListener('abort', onAbort)
            settleWith(value, extra)
          }
          const onAbort = finish(() => { entry.aborted = true; reject(questionError('ASK_ABORTED')) })
          entry.answer = finish((answer) => resolve({ answers: [{ id: item.id, selected: [], ...answer }] }))
          entry.reject = finish((code, message) => reject(questionError(code, message)))
          if (request.signal?.aborted) onAbort()
          else request.signal?.addEventListener('abort', onAbort, { once: true })
        })
        asks.push(entry)
        onAsk(entry)
        return entry.promise
      },
    },
    inject(names, callback) {
      if (names.includes('commands')) callback({ commands: { register(value) { command = value } } })
    },
  }
  const agent = {
    session: {
      append(type) {
        appends.push(type)
        throw new Error(`session event "${type}" is surface-eligible and requires a surfaceOp marker`)
      },
    },
  }
  return {
    ctx, agent, appends, swallowed, begins, asks, flowPrompts,
    command: () => command,
    set onAsk(value) { onAsk = value },
    run(rawInput, extra = {}) {
      if (command === undefined) mountProviderLogin(ctx)
      return command.handler({ agent, rawInput, ...extra })
    },
  }
}

const waitForAbort = (signal) => new Promise((_, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true })
})

test('registers /provider-login and runs the provider OAuth flow', async () => {
  const h = harness(async (session) => {
    session.notify({ message: 'Continue in your browser', url: 'https://example.com/auth' })
    const code = await session.prompt({ kind: 'text', message: 'Paste the code' })
    assert.equal(code, 'test-code')
  })
  h.onAsk = (entry) => entry.answer({ custom: 'test-code' })
  mountProviderLogin(h.ctx)
  assert.equal(h.command().name, 'provider-login')
  const result = await h.command().handler({ agent: h.agent, rawInput: 'openai-codex' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /authorized/)
  assert.equal(h.begins.length, 1)
  assert.equal(h.begins[0].key, 'llm-pi-ai/openai-codex')
  assert.equal(h.begins[0].method, 'oauth')
  assert.equal(h.asks.length, 1)
  // The notice reaches the user inside the prompt's question, above the prompt
  // message. Nothing is appended to the session: a real Session rejects it.
  assert.equal(h.asks[0].text, 'Continue in your browser\nOpen: https://example.com/auth\n\nPaste the code')
  assert.deepEqual(h.appends, [])
  assert.deepEqual(h.swallowed, [])
  assert.ok(h.begins[0].signal instanceof AbortSignal)
})

test('a notice with no prompt after it is its own question offering only Cancel sign-in, closed when the flow settles', { timeout: 2000 }, async () => {
  let finish
  const polled = new Promise((resolve) => { finish = resolve })
  const h = harness(async (session) => {
    session.notify({ message: 'Enter this code on the verification page.', url: 'https://example.com/device', code: 'ABCD-1234' })
    await polled
  })
  const running = h.run('openai-codex')
  await settle()
  assert.equal(h.asks.length, 1)
  assert.equal(h.asks[0].text, 'Enter this code on the verification page.\nOpen: https://example.com/device\nCode: ABCD-1234')
  assert.deepEqual(h.asks[0].options, [{ label: 'Cancel sign-in' }])
  assert.equal(h.asks[0].settled, false)
  finish()
  const result = await running
  assert.equal(result.kind, 'success')
  assert.equal(h.asks[0].aborted, true)
  assert.equal(h.asks.length, 1)
  assert.deepEqual(h.appends, [])
})

test('a later prompt replaces the notice question and repeats the notice text', { timeout: 2000 }, async () => {
  let next
  const gate = new Promise((resolve) => { next = resolve })
  const h = harness(async (session) => {
    session.notify({ message: 'Open this page to continue signing in.', url: 'https://example.com/auth' })
    await gate
    assert.equal(await session.prompt({ kind: 'text', message: 'Paste the code' }), 'test-code')
  })
  h.onAsk = (entry) => { if (entry.options.length === 0) entry.answer({ custom: 'test-code' }) }
  const running = h.run('anthropic')
  await settle()
  assert.equal(h.asks.length, 1)
  next()
  const result = await running
  assert.equal(result.kind, 'success')
  assert.equal(h.asks.length, 2)
  assert.equal(h.asks[0].aborted, true)
  assert.equal(h.asks[1].text, 'Open this page to continue signing in.\nOpen: https://example.com/auth\n\nPaste the code')
})

test('a prompt withdrawn by its own signal does not cancel the sign-in', { timeout: 2000 }, async () => {
  let callback
  const h = harness(async (session) => {
    session.notify({ message: 'Complete login in your browser.', url: 'https://example.com/auth' })
    const manual = new AbortController()
    const typed = session.prompt({ kind: 'text', message: 'Or paste the code here:', signal: manual.signal }).catch(() => 'withdrawn')
    await new Promise((resolve) => { callback = resolve })
    manual.abort(new Error('the browser callback won'))
    assert.equal(await typed, 'withdrawn')
    session.notify({ message: 'Exchanging authorization code for tokens...' })
    await new Promise((resolve) => { callback = resolve })
  })
  const running = h.run('anthropic')
  await settle()
  assert.equal(h.asks.length, 1)
  assert.equal(h.asks[0].text, 'Complete login in your browser.\nOpen: https://example.com/auth\n\nOr paste the code here:')
  callback()
  await settle()
  assert.equal(h.asks[0].aborted, true)
  assert.equal(h.asks.length, 2)
  assert.equal(h.asks[1].text, 'Exchanging authorization code for tokens...')
  assert.deepEqual(h.asks[1].options, [{ label: 'Cancel sign-in' }])
  callback()
  const result = await running
  assert.equal(result.kind, 'success')
  assert.equal(h.asks[1].aborted, true)
})

test('choosing Cancel sign-in cancels the flow and leaves no question or prompt pending', { timeout: 2000 }, async () => {
  const h = harness(async (session) => {
    session.notify({ message: 'Waiting for the browser', url: 'https://example.com/auth' })
    await waitForAbort(session.signal)
  })
  h.onAsk = (entry) => entry.answer({ selected: ['Cancel sign-in'] })
  const result = await h.run('openai-codex')
  assert.deepEqual(result, { kind: 'error', text: 'openai-codex: sign-in cancelled.' })
  assert.equal(h.asks.length, 1)
  assert.equal(h.begins[0].signal.aborted, true)
  assert.ok(h.asks.every((entry) => entry.settled))
  await settle()
  assert.equal(h.asks.length, 1)
})

test('a dismissed prompt question cancels the sign-in and settles the prompt it answered', { timeout: 2000 }, async () => {
  const h = harness(async (session) => {
    session.notify({ message: 'Continue in your browser', url: 'https://example.com/auth' })
    await session.prompt({ kind: 'text', message: 'Paste the code' })
  })
  h.onAsk = (entry) => entry.reject('ASK_CANCELLED')
  const result = await h.run('anthropic')
  assert.deepEqual(result, { kind: 'error', text: 'anthropic: sign-in cancelled.' })
  assert.equal(h.begins[0].signal.aborted, true)
  assert.equal(h.flowPrompts.length, 1)
  assert.ok(h.flowPrompts.every((prompt) => prompt.settled))
  assert.ok(h.asks.every((entry) => entry.settled))
})

test('the command signal withdraws the sign-in', { timeout: 2000 }, async () => {
  const h = harness(async (session) => {
    session.notify({ message: 'Waiting for the browser' })
    await waitForAbort(session.signal)
  })
  const command = new AbortController()
  const running = h.run('openai-codex', { signal: command.signal })
  await settle()
  command.abort()
  assert.deepEqual(await running, { kind: 'error', text: 'openai-codex: sign-in cancelled.' })
  assert.ok(h.asks.every((entry) => entry.settled))
})

test('the api-key method is refused, names Settings → Models, and starts no flow', async () => {
  const h = harness(async () => { throw new Error('the flow must not run') })
  const result = await h.run('anthropic api-key')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /^anthropic: /)
  assert.match(result.text, /Settings → Models/)
  assert.equal(h.begins.length, 0)
  assert.equal(h.asks.length, 0)
})

test('a secret prompt during OAuth cancels the flow with the same text and never reaches a question', { timeout: 2000 }, async () => {
  const refused = await harness().run('anthropic api-key')
  const h = harness(async (session) => {
    await session.prompt({ kind: 'secret', message: 'Paste your API key' })
  })
  h.onAsk = (entry) => entry.answer({ custom: 'sk-must-never-be-asked' })
  const result = await h.run('anthropic')
  assert.deepEqual(result, { kind: 'error', text: refused.text })
  assert.equal(h.asks.length, 0)
  assert.equal(h.begins[0].signal.aborted, true)
  assert.ok(h.flowPrompts.every((prompt) => prompt.settled))
})

test('a select prompt answers with the chosen option id, not its label', async () => {
  const h = harness(async (session) => {
    const method = await session.prompt({
      kind: 'select',
      message: 'Select Anthropic login method:',
      options: [
        { id: 'browser', label: 'Browser login (default)' },
        { id: 'copy_code', label: 'Copy code login (headless)' },
      ],
    })
    assert.equal(method, 'copy_code')
  })
  h.onAsk = (entry) => entry.answer({ selected: ['Copy code login (headless)'] })
  const result = await h.run('anthropic')
  assert.equal(result.kind, 'success')
  assert.deepEqual(h.asks[0].options.map((option) => option.label), ['Browser login (default)', 'Copy code login (headless)'])
})

test('Remote stream carries notices, prompts, answers, and outcome', async () => {
  const answers = []
  const wake = []
  let finished = false
  const uplink = {
    async *[Symbol.asyncIterator]() {
      while (!finished) {
        if (answers.length > 0) { yield answers.shift(); continue }
        await new Promise((resolve) => wake.push(resolve))
      }
    },
    async return() { finished = true; wake.splice(0).forEach((resolve) => resolve()) },
  }
  const ctx = {
    reflect: { provide() {} },
    invocation: { uplink: () => uplink },
    authorization: {
      async begin(request) {
        request.interaction.notify({ message: 'Continue', url: 'https://example.com' })
        const code = await request.interaction.prompt({ kind: 'text', message: 'Code?' })
        assert.equal(code, 'test-code')
        return { status: 'authorized' }
      },
    },
  }
  const service = new ProviderLoginService(ctx)
  const iterator = service.begin({ provider: 'openai-codex', method: 'oauth' })[Symbol.asyncIterator]()
  const notice = await iterator.next()
  assert.equal(notice.value.type, 'notice')
  const prompt = await iterator.next()
  assert.equal(prompt.value.type, 'prompt')
  answers.push({ type: 'answer', id: prompt.value.id, answer: 'test-code' })
  wake.splice(0).forEach((resolve) => resolve())
  const settled = await iterator.next()
  assert.deepEqual(settled.value, { type: 'settled', status: 'authorized' })
  assert.equal((await iterator.next()).done, true)
})

test('rejects invalid provider arguments', async () => {
  const h = harness()
  mountProviderLogin(h.ctx)
  const result = await h.command().handler({ agent: h.agent, rawInput: '' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Usage: \/provider-login/)
  assert.equal(h.begins.length, 0)
})

function statusHarness() {
  const records = new Map()
  const reads = []
  const service = new ProviderLoginService({
    reflect: { provide() {} },
    credentials: {
      async readRecord(key) {
        reads.push(key)
        return records.get(key)
      },
    },
  })
  return { service, records, reads }
}

for (const provider of ['openai-codex', 'anthropic']) {
  test(`${provider} status reports only whether its credential record exists`, async () => {
    const h = statusHarness()
    const key = `llm-pi-ai/${provider}`
    assert.deepEqual(await h.service.status({ provider }), { configured: false })
    h.records.set(key, { secret: 'not returned' })
    assert.deepEqual(await h.service.status({ provider }), { configured: true })
    assert.deepEqual(h.reads, [key, key])
  })
}

test('status has direct Remote metadata and rejects unsupported providers', async () => {
  const h = statusHarness()
  const marker = remoteMethods(h.service).find((method) => method.method === 'status')
  assert.deepEqual(marker, { method: 'status', invocation: { kind: 'direct' } })
  await assert.rejects(h.service.status({ provider: 'openai' }), /supports only openai-codex and anthropic/)
  assert.deepEqual(h.reads, [])
})

// ---------------------------------------------------------------------------
// Follow-up F: typed text never leaves the command, ask failures are not "cancelled"
// ---------------------------------------------------------------------------

const SECRET = 'sk-ant-api03-SECRET'
const METHOD_OPTIONS = [
  { id: 'browser', label: 'Browser login (default)' },
  { id: 'copy_code', label: 'Copy code login (headless)' },
]
/** The flow of pi-ai's Anthropic provider: it throws on a method it does not know and echoes it. */
const anthropicMethodFlow = async (session) => {
  const method = await session.prompt({ kind: 'select', message: 'Select Anthropic login method:', options: METHOD_OPTIONS })
  if (!['browser', 'copy_code'].includes(method)) throw new Error(`Unknown Anthropic login method: ${method}`)
}

/** Run the command while recording everything the seams and the console saw. */
async function runObserved(h, rawInput) {
  const seen = []
  const levels = ['log', 'info', 'warn', 'error', 'debug']
  const originals = levels.map((level) => console[level])
  for (const level of levels) console[level] = (...args) => { seen.push(args.map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : String(arg))).join(' ')) }
  let outcome
  try {
    outcome = { value: await h.run(rawInput) }
  } catch (error) {
    outcome = { error }
  } finally {
    levels.forEach((level, index) => { console[level] = originals[index] })
  }
  const everything = [
    JSON.stringify(outcome.value ?? null),
    outcome.error ? `${outcome.error.name}: ${outcome.error.message}\n${outcome.error.stack}\n${String(outcome.error.cause ?? '')}` : '',
    ...h.asks.map((entry) => entry.text),
    ...h.asks.flatMap((entry) => entry.options.map((option) => JSON.stringify(option))),
    ...h.appends,
    ...h.swallowed.map((error) => error.message),
    ...seen,
  ].join('\n')
  return { ...outcome, everything }
}

test('text typed into Other on a select question is a decline: no flow, error, result or log ever holds it', { timeout: 2000 }, async () => {
  const h = harness(anthropicMethodFlow)
  h.onAsk = (entry) => entry.answer({ custom: SECRET })
  const observed = await runObserved(h, 'anthropic')
  assert.equal(observed.error, undefined, `the command must not throw: ${observed.error?.message}`)
  assert.deepEqual(observed.value, { kind: 'error', text: 'anthropic: sign-in cancelled.' })
  assert.ok(!observed.everything.includes(SECRET), 'the typed text appears nowhere')
  assert.equal(h.begins[0].signal.aborted, true)
  assert.ok(h.flowPrompts.every((prompt) => prompt.settled))
})

test('text typed into Other that names an option id or label still chooses that option', { timeout: 2000 }, async () => {
  for (const custom of ['copy_code', 'Copy code login (headless)']) {
    const chosen = []
    const h = harness(async (session) => {
      chosen.push(await session.prompt({ kind: 'select', message: 'Select Anthropic login method:', options: METHOD_OPTIONS }))
    })
    h.onAsk = (entry) => entry.answer({ custom })
    const result = await h.run('anthropic')
    assert.equal(result.kind, 'success')
    assert.deepEqual(chosen, ['copy_code'])
  }
})

test('an error the flow throws after a text answer never carries that answer out of the command', { timeout: 2000 }, async () => {
  const h = harness(async (session) => {
    const code = await session.prompt({ kind: 'text', message: 'Paste the code' })
    throw new Error(`Token exchange failed for code ${code} (HTTP 400)`)
  })
  h.onAsk = (entry) => entry.answer({ custom: SECRET })
  const observed = await runObserved(h, 'anthropic')
  assert.ok(observed.error, 'a failing flow still fails the command')
  assert.match(observed.error.message, /Token exchange failed for code .* \(HTTP 400\)/)
  assert.ok(!observed.everything.includes(SECRET), 'the typed text appears nowhere')
})

test('an error the flow throws without any typed answer is rethrown unchanged', { timeout: 2000 }, async () => {
  const failure = new Error('The token endpoint is down.')
  const h = harness(async () => { throw failure })
  await assert.rejects(h.run('anthropic'), (error) => error === failure)
})

for (const [code, expected] of [
  ['NO_PROVIDER', /no question UI/],
  ['CALLER_NOT_LIVE', /root conversation/],
  ['DELEGATED_CALLER', /root conversation/],
]) {
  test(`a question that cannot be shown (${code}) is an error with its cause, not "sign-in cancelled"`, { timeout: 2000 }, async () => {
    const h = harness(async (session) => {
      session.notify({ message: 'Continue in your browser', url: 'https://example.com/auth' })
      await session.prompt({ kind: 'text', message: 'Paste the code' })
    })
    h.onAsk = (entry) => entry.reject(code, `raw host text ${SECRET}`)
    const observed = await runObserved(h, 'anthropic')
    assert.equal(observed.error, undefined)
    assert.equal(observed.value.kind, 'error')
    assert.match(observed.value.text, /^anthropic: /)
    assert.match(observed.value.text, expected)
    assert.match(observed.value.text, /Settings → Models/)
    assert.doesNotMatch(observed.value.text, /cancelled/)
    assert.ok(!observed.everything.includes(SECRET), 'the host text is not copied')
    assert.equal(h.begins[0].signal.aborted, true)
    assert.ok(h.flowPrompts.every((prompt) => prompt.settled))
  })
}

test('an unknown failure of the question names its code only when it is a plain code, and never copies the text', { timeout: 2000 }, async () => {
  const known = harness(async (session) => { await session.prompt({ kind: 'text', message: 'Paste the code' }) })
  known.onAsk = (entry) => entry.reject('BAD_INTENT', `detail ${SECRET}`)
  const withCode = await runObserved(known, 'anthropic')
  assert.match(withCode.value.text, /BAD_INTENT/)
  assert.doesNotMatch(withCode.value.text, /cancelled/)
  assert.ok(!withCode.everything.includes(SECRET))

  const odd = harness(async (session) => { await session.prompt({ kind: 'text', message: 'Paste the code' }) })
  odd.onAsk = (entry) => entry.reject(`not a code ${SECRET}`, `detail ${SECRET}`)
  const withoutCode = await runObserved(odd, 'anthropic')
  assert.equal(withoutCode.value.kind, 'error')
  assert.doesNotMatch(withoutCode.value.text, /cancelled/)
  assert.ok(!withoutCode.everything.includes(SECRET))
})

test('the waiting question failing to show is an error with its cause too', { timeout: 2000 }, async () => {
  const h = harness(async (session) => {
    session.notify({ message: 'Waiting for the browser', url: 'https://example.com/auth' })
    await waitForAbort(session.signal)
  })
  h.onAsk = (entry) => entry.reject('NO_PROVIDER', `raw ${SECRET}`)
  const observed = await runObserved(h, 'openai-codex')
  assert.equal(observed.value.kind, 'error')
  assert.match(observed.value.text, /no question UI/)
  assert.doesNotMatch(observed.value.text, /cancelled/)
  assert.ok(!observed.everything.includes(SECRET))
})

test('dismissing or aborting a question stays a plain cancellation', { timeout: 2000 }, async () => {
  for (const code of ['ASK_CANCELLED', 'ASK_ABORTED']) {
    const h = harness(async (session) => { await session.prompt({ kind: 'text', message: 'Paste the code' }) })
    h.onAsk = (entry) => entry.reject(code)
    assert.deepEqual(await h.run('anthropic'), { kind: 'error', text: 'anthropic: sign-in cancelled.' }, code)
  }
})

test('a prompt closes the waiting question before it asks its own', { timeout: 2000 }, async () => {
  let next
  const gate = new Promise((resolve) => { next = resolve })
  const h = harness(async (session) => {
    session.notify({ message: 'Open this page to continue signing in.', url: 'https://example.com/auth' })
    await gate
    await session.prompt({ kind: 'text', message: 'Paste the code' })
  })
  const waitingStateAtPrompt = []
  h.onAsk = (entry) => {
    if (entry.options.length === 0) {
      waitingStateAtPrompt.push(h.asks[0].settled)
      entry.answer({ custom: 'code' })
    }
  }
  const running = h.run('anthropic')
  await settle()
  next()
  assert.equal((await running).kind, 'success')
  assert.deepEqual(waitingStateAtPrompt, [true], 'the waiting question was already closed when the prompt was asked')
})

test('the Remote stream rejects a malformed request with text that fits the card, not the command', () => {
  const service = new ProviderLoginService({ reflect: { provide() {} } })
  for (const request of [{ provider: 'Bad Name', method: 'oauth' }, { provider: 'anthropic', method: 'device' }]) {
    assert.throws(() => service.begin(request), (error) => {
      assert.doesNotMatch(error.message, /\/provider-login/, 'the slash command is not the caller')
      assert.match(error.message, /oauth/)
      assert.match(error.message, /api-key/)
      return true
    })
  }
})
