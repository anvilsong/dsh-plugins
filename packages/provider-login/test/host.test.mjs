import assert from 'node:assert/strict'
import test from 'node:test'
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
