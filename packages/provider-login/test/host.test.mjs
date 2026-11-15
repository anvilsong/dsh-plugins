import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../src/index.host.js'

function harness() {
  let command
  const notices = []
  const questions = []
  const begins = []
  const ctx = {
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

test('registers /login and runs the provider OAuth flow', async () => {
  const h = harness()
  apply(h.ctx)
  assert.equal(h.command().name, 'login')
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

test('rejects invalid provider arguments', async () => {
  const h = harness()
  apply(h.ctx)
  const result = await h.command().handler({ agent: h.agent, rawInput: '' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Usage: \/login/)
  assert.equal(h.begins.length, 0)
})
