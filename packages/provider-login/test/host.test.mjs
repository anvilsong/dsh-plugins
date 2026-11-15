import assert from 'node:assert/strict'
import test from 'node:test'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { apply, ProviderLoginService } from '../src/index.host.js'

function harness() {
  let command
  const notices = []
  const questions = []
  const begins = []
  const ctx = {
    reflect: { provide() {} },
    commands: { register(value) { command = value } },
    authorization: {
      async begin(request) {
        begins.push(request)
        request.interaction.notify({ message: 'Continue in your browser', url: 'https://example.com/auth' })
        const code = await request.interaction.prompt({ kind: 'text', message: 'Paste the code' })
        assert.equal(code, 'test-code')
        return { status: 'authorized' }
      },
    },
    userQuestions: {
      async ask(request) {
        questions.push(request)
        return { answers: [{ id: 'provider-login', selected: [], custom: 'test-code' }] }
      },
    },
    inject(names, callback) {
      if (names.includes('commands')) callback({ commands: { register(value) { command = value } } })
    },
  }
  const agent = {
    session: { append(type, data) { notices.push({ type, data }) } },
  }
  return { ctx, agent, command: () => command, notices, questions, begins }
}

test('registers /provider-login and runs the provider OAuth flow', async () => {
  const h = harness()
  apply(h.ctx)
  assert.equal(h.command().name, 'provider-login')
  const result = await h.command().handler({ agent: h.agent, rawInput: 'openai-codex' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /authorized/)
  assert.equal(h.begins.length, 1)
  assert.equal(h.begins[0].key, 'llm-pi-ai/openai-codex')
  assert.equal(h.begins[0].method, 'oauth')
  assert.equal(h.questions.length, 1)
  assert.equal(h.questions[0].questions[0].question, 'Paste the code')
  assert.equal(h.notices.length, 1)
  assert.match(h.notices[0].data.content[0].text, /https:\/\/example.com\/auth/)
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
  apply(h.ctx)
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
