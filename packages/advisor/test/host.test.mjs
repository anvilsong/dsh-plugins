import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply, POLICY } from '../src/index.host.js'

function harness() {
  let definition
  let section
  let command
  let state = { active: false, pending: null }
  const ctx = {
    sessionProjections: { async register(value) { definition = value; return { stateOf: () => state } } },
    systemPrompt: { getSectionOrder: () => 500, section(value) { section = value } },
    inject(names, callback) {
      if (names.includes('commands')) callback({ commands: { register(value) { command = value } } })
    },
  }
  return { ctx, agent: { session: {} }, get: () => ({ definition, section, command, state }), setState: (next) => { state = next } }
}

test('registers projection, prompt, and command', async () => {
  const { ctx, get } = harness()
  await apply(ctx)
  const { definition, section, command } = get()
  assert.equal(definition.key, 'advisor')
  assert.equal(definition.stateVersion, 1)
  assert.equal(section.name, 'advisor:policy')
  assert.equal(command.name, 'advisor')
})

test('policy requires ledger proof and forbids direct subagent substitutes', () => {
  assert.match(POLICY, /reload the advisor skill/)
  assert.match(POLICY, /ledger consult_id/)
  assert.match(POLICY, /Do not call subagent_claude_code or subagent_codex/)
  assert.match(POLICY, /sanitized briefings/)
  assert.match(POLICY, /normally at most three per task/)
})

test('status reports recent ledger entries', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'advisor-ledger-'))
  const file = path.join(dir, 'sessions.jsonl')
  process.env.ADVISOR_LEDGER = file
  try {
    await writeFile(file, JSON.stringify({ consult_id: 'abc123', advisor: 'fable', status: 'ok', topic: 'review' }) + '\n')
    const { ctx, get, agent } = harness()
    await apply(ctx)
    const result = await get().command.handler({ agent, rawInput: 'status' })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /Advisor is off/)
    assert.match(result.text, /abc123 fable ok review/)
  } finally {
    delete process.env.ADVISOR_LEDGER
    await rm(dir, { recursive: true, force: true })
  }
})

test('on and off return success and reject overlapping updates', async () => {
  const { ctx, get, agent } = harness()
  await apply(ctx)
  const command = get().command
  assert.equal((await command.handler({ agent, rawInput: 'on' })).kind, 'success')
  assert.equal((await command.handler({ agent, rawInput: 'off' })).kind, 'success')
  get().state.pending = { arg: true, commandId: 'old', startedAt: Date.now() }
  const result = await command.handler({ agent, rawInput: 'off', commandId: 'new' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /already updating/)
})
