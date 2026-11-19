import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { z } from 'zod'
import * as host from '../src/index.host.js'
import { apply, POLICY } from '../src/index.host.js'
import { foldExplainer, INITIAL_EXPLAINER_STATE, STALE_PENDING_MS } from '../src/state.js'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const pkg = JSON.parse(read('../package.json'))

const EXPECTED_POLICY = "Explainer style is active for this session. When the user asks you to explain something, or wants to understand, compare or walk through it, use the lowest form that serves. Keep a short answer short: this style never makes an answer longer, and it overrides the page rules below.\n- Short prose: for a definition, a procedure or a warning of about three paragraphs or fewer. Keep sentences to 20 words for procedures and 25 for descriptions. Use active voice, one instruction per sentence, one term per concept used the same way each time, no phrasal verbs or idioms, and a numbered list for steps. These limits apply to this form only.\n- Text diagram: when the point is structure, flow, state, dependencies or sequence, draw it with plain text or box-drawing characters in the chat. Never paste Mermaid or SVG source into the chat.\n- One-file HTML page: when the topic has more than about five interacting parts, or the user would want to explore or compare it, offer it in one line (for example: Want this as an interactive HTML page?). Build it without asking only when the user asked for a page, a visual or an interactive explanation. It is one self-contained file with inline CSS and JavaScript and no build step, written to ~/explainers/YYYY-MM-DD-<slug>/index.html and never into the project repository. Open it with the system opener if one exists, give its path, and confirm that the file exists. If you cannot write the file, say so and give the explanation in the chat instead.\n- Video: never make one on your own. If the user asks for one, state the cost and confirm first.\nThis style applies to explanations only, not to code edits, tool output, status reports, plans, reviews or final reports. Section rules from other active modes still apply to every final answer."

// The fake host. The projection state is folded from the events the test feeds
// in, so the handler, the fold and the prompt section are exercised together.
function harness() {
  const registered = []
  const commands = []
  const sections = []
  let definition
  let state = INITIAL_EXPLAINER_STATE
  const ctx = {
    sessionProjections: {
      async register(value) {
        registered.push(value)
        definition = value
        return { stateOf: () => state }
      },
    },
    systemPrompt: {
      getSectionOrder: (name) => (name === 'PLAN_POLICY' ? 500 : undefined),
      section(value) { sections.push(value) },
    },
    inject(names, callback) {
      if (names.includes('commands')) callback({ commands: { register(value) { commands.push(value) } } })
    },
  }
  const agent = { session: {} }
  const feed = (...events) => { for (const event of events) state = definition.apply(state, event) }
  // Run a command through the registered handler, then log it as the host does.
  const dispatch = async (rawInput, commandId = `c${Math.random()}`, time = 1000) => {
    const command = commands[0]
    feed({ type: 'command/run', time, data: { name: 'output-style', args: rawInput, commandId } })
    const result = await command.handler({ agent, rawInput, commandId })
    feed({ type: 'command/done', data: { commandId, kind: result.kind, text: result.text } })
    return result
  }
  return {
    ctx, agent, registered, commands, sections, feed, dispatch,
    section: () => sections[0],
    setState: (next) => { state = next },
  }
}

test('apply registers one command, one projection and one prompt section', async () => {
  const h = harness()
  await apply(h.ctx)
  assert.equal(h.commands.length, 1)
  assert.equal(h.registered.length, 1)
  assert.equal(h.sections.length, 1)
})

test('the command has the right name, id, description and usage hint', async () => {
  const h = harness()
  await apply(h.ctx)
  const [command] = h.commands
  assert.equal(command.name, 'output-style')
  assert.equal(command.definitionId, 'dsh-plugin-explainer')
  assert.equal(typeof command.description, 'string')
  assert.deepEqual(command.input, { hint: '[explainer|off|status]' })
  assert.equal(typeof command.handler, 'function')
})

test('the entry exports name, inject and apply, and injects only what it uses', () => {
  assert.equal(host.name, 'explainer')
  assert.deepEqual(Array.from(host.inject), ['systemPrompt', 'sessionProjections'])
  assert.equal(typeof host.apply, 'function')
})

test('the projection has key explainer, version 1, a schema and a wire view', async () => {
  const h = harness()
  await apply(h.ctx)
  const [definition] = h.registered
  assert.equal(definition.key, 'explainer')
  assert.equal(definition.stateVersion, 1)
  assert.deepEqual(definition.init(), { on: false, pending: null, failure: null })
  assert.notEqual(definition.init(), definition.init())
  assert.equal(definition.apply, foldExplainer)
  assert.equal(definition.stateSchema.safeParse(definition.init()).success, true)
  assert.equal(definition.stateSchema.safeParse({ on: 'yes', pending: null, failure: null }).success, false)
  const folded = [
    { type: 'command/run', time: 1, data: { name: 'output-style', args: 'on', commandId: 'a' } },
  ].reduce(definition.apply, definition.init())
  assert.equal(definition.stateSchema.safeParse(folded).success, true)
  const failed = [
    { type: 'command/run', time: 1, data: { name: 'output-style', args: 'on', commandId: 'a' } },
    { type: 'command/done', data: { name: 'output-style', commandId: 'a', kind: 'error', text: 'x' } },
  ].reduce(definition.apply, definition.init())
  assert.equal(definition.stateSchema.safeParse(failed).success, true)
  assert.ok(definition.wire.viewSchema instanceof z.ZodType)
  assert.equal(definition.wire.viewSchema.safeParse(definition.wire.view(failed)).success, true)
})

test('the section has its own name and the router convention for order', async () => {
  const h = harness()
  await apply(h.ctx)
  assert.equal(h.section().name, 'explainer:policy')
  assert.equal(h.section().order, 500)
  assert.equal(typeof h.section().text, 'function')
})

test('a new session adds no section text', async () => {
  const h = harness()
  await apply(h.ctx)
  assert.equal(h.section().text({ agent: h.agent }), '')
})

test('the section holds exactly the policy while on and nothing after off', async () => {
  const h = harness()
  await apply(h.ctx)
  assert.equal((await h.dispatch('explainer')).kind, 'success')
  assert.equal(h.section().text({ agent: h.agent }), POLICY)
  assert.equal((await h.dispatch('off')).kind, 'success')
  assert.equal(h.section().text({ agent: h.agent }), '')
  assert.equal((await h.dispatch('explainer')).kind, 'success')
  assert.equal(h.section().text({ agent: h.agent }), POLICY)
})

test('a section is empty for a context without an agent, even while on', async () => {
  const h = harness()
  await apply(h.ctx)
  await h.dispatch('on')
  assert.equal(h.section().text({}), '')
})

test('a pending change does not add the section before it commits', async () => {
  const h = harness()
  await apply(h.ctx)
  h.feed({ type: 'command/run', time: 1, data: { name: 'output-style', args: 'on', commandId: 'p' } })
  assert.equal(h.section().text({ agent: h.agent }), '')
})

test('status, usage errors and a failed on leave the section off', async () => {
  const h = harness()
  await apply(h.ctx)
  await h.dispatch('status')
  await h.dispatch('')
  await h.dispatch('bogus')
  await h.dispatch('explainer now')
  const id = 'fail-1'
  h.feed({ type: 'command/run', time: 1, data: { name: 'output-style', args: 'on', commandId: id } })
  h.feed({ type: 'command/done', data: { commandId: id, kind: 'error', text: 'x' } })
  assert.equal(h.section().text({ agent: h.agent }), '')
})

test('a failed off keeps the section on', async () => {
  const h = harness()
  await apply(h.ctx)
  await h.dispatch('on')
  h.feed({ type: 'command/run', time: 5, data: { name: 'output-style', args: 'off', commandId: 'f' } })
  h.feed({ type: 'command/done', data: { commandId: 'f', kind: 'error', text: 'x' } })
  assert.equal(h.section().text({ agent: h.agent }), POLICY)
})

test('invalid arguments return the usage error and do not turn the style on', async () => {
  const h = harness()
  await apply(h.ctx)
  for (const arg of ['manual', 'toggle', 'on please', 'onn', 'level hard', 'explainer on', 'explainers', 'status now']) {
    const result = await h.dispatch(arg)
    assert.deepEqual(result, { kind: 'error', text: 'Usage: /output-style explainer|off|status' }, JSON.stringify(arg))
    assert.equal(h.section().text({ agent: h.agent }), '', JSON.stringify(arg))
  }
})

test('a bare call behaves like status, not like a usage error', async () => {
  const h = harness()
  await apply(h.ctx)
  for (const arg of ['', '   ']) {
    assert.deepEqual(await h.dispatch(arg), { kind: 'success', text: 'Output style: off.' }, JSON.stringify(arg))
  }
  assert.deepEqual(await h.commands[0].handler({ agent: h.agent, rawInput: undefined, commandId: 'u' }), { kind: 'success', text: 'Output style: off.' })
  await h.dispatch('explainer')
  assert.deepEqual(await h.dispatch(''), { kind: 'success', text: 'Output style: explainer.' })
  assert.equal(h.section().text({ agent: h.agent }), POLICY)
})

test('on is an alias of explainer', async () => {
  const h = harness()
  await apply(h.ctx)
  assert.deepEqual(await h.dispatch('on'), { kind: 'success', text: 'Output style set to explainer.' })
  assert.equal(h.section().text({ agent: h.agent }), POLICY)
})

test('the explainer argument turns the style on', async () => {
  const h = harness()
  await apply(h.ctx)
  assert.deepEqual(await h.dispatch('explainer'), { kind: 'success', text: 'Output style set to explainer.' })
  assert.equal(h.section().text({ agent: h.agent }), POLICY)
  assert.deepEqual(await h.dispatch('off'), { kind: 'success', text: 'Output style set to off.' })
  assert.equal(h.section().text({ agent: h.agent }), '')
})

test('events of any other command name never switch the section', async () => {
  const h = harness()
  await apply(h.ctx)
  for (const name of ['explainer', 'output-style-x', 'output_style', 'router']) {
    h.feed({ type: 'command/run', time: 1, data: { name, args: 'on', commandId: `o-${name}` } })
    h.feed({ type: 'command/done', data: { commandId: `o-${name}`, kind: 'success', text: '' } })
    assert.equal(h.section().text({ agent: h.agent }), '', name)
  }
})

test('arguments are case and space insensitive', async () => {
  const h = harness()
  await apply(h.ctx)
  assert.equal((await h.dispatch('  ON ')).kind, 'success')
  assert.equal(h.section().text({ agent: h.agent }), POLICY)
  assert.equal((await h.dispatch('Off')).kind, 'success')
  assert.equal(h.section().text({ agent: h.agent }), '')
})

test('on and off answer with success texts', async () => {
  const h = harness()
  await apply(h.ctx)
  assert.deepEqual(await h.dispatch('explainer'), { kind: 'success', text: 'Output style set to explainer.' })
  assert.deepEqual(await h.dispatch('explainer'), { kind: 'success', text: 'Output style set to explainer.' })
  assert.deepEqual(await h.dispatch('off'), { kind: 'success', text: 'Output style set to off.' })
})

test('status reports off, on, and off again', async () => {
  const h = harness()
  await apply(h.ctx)
  assert.deepEqual(await h.dispatch('status'), { kind: 'success', text: 'Output style: off.' })
  await h.dispatch('explainer')
  assert.deepEqual(await h.dispatch('status'), { kind: 'success', text: 'Output style: explainer.' })
  await h.dispatch('off')
  assert.deepEqual(await h.dispatch('status'), { kind: 'success', text: 'Output style: off.' })
})

test('status reports a pending update instead of the setting', async () => {
  const h = harness()
  await apply(h.ctx)
  h.setState({ on: false, pending: { arg: 'on', commandId: 'p', startedAt: Date.now() }, failure: null })
  const result = await h.commands[0].handler({ agent: h.agent, rawInput: 'status', commandId: 'q' })
  assert.deepEqual(result, { kind: 'success', text: 'Output style is updating to explainer for this session.' })
})

test('status ignores an expired pending update', async () => {
  const h = harness()
  await apply(h.ctx)
  h.setState({ on: true, pending: { arg: 'off', commandId: 'p', startedAt: 1 }, failure: null })
  const result = await h.commands[0].handler({ agent: h.agent, rawInput: 'status', commandId: 'q' })
  assert.equal(result.text, 'Output style: explainer.')
})

test('a different pending command rejects on and off but not its own', async () => {
  const h = harness()
  await apply(h.ctx)
  h.setState({ on: false, pending: { arg: 'on', commandId: 'p', startedAt: Date.now() }, failure: null })
  const rejected = await h.commands[0].handler({ agent: h.agent, rawInput: 'off', commandId: 'q' })
  assert.deepEqual(rejected, { kind: 'error', text: 'Output style is already updating. Try again after it finishes.' })
  const own = await h.commands[0].handler({ agent: h.agent, rawInput: 'explainer', commandId: 'p' })
  assert.equal(own.kind, 'success')
})

test('the usage error is checked before the pending check', async () => {
  const h = harness()
  await apply(h.ctx)
  h.setState({ on: false, pending: { arg: 'on', commandId: 'p', startedAt: Date.now() }, failure: null })
  const result = await h.commands[0].handler({ agent: h.agent, rawInput: 'bogus', commandId: 'q' })
  assert.equal(result.text, 'Usage: /output-style explainer|off|status')
})

test('the setting belongs to the session whose state is read', async () => {
  const h = harness()
  await apply(h.ctx)
  const other = { session: {} }
  h.setState({ on: true, pending: null, failure: null })
  assert.equal(h.section().text({ agent: other }), POLICY)
  h.setState(INITIAL_EXPLAINER_STATE)
  assert.equal(h.section().text({ agent: other }), '')
})

test('POLICY equals the pinned text exactly', () => {
  assert.equal(POLICY, EXPECTED_POLICY)
})

test('POLICY names the three rungs, the video rule and the word limits', () => {
  assert.match(POLICY, /- Short prose: /)
  assert.match(POLICY, /- Text diagram: /)
  assert.match(POLICY, /- One-file HTML page: /)
  assert.match(POLICY, /- Video: never make one on your own\. If the user asks for one, state the cost and confirm first\./)
  assert.match(POLICY, /20 words for procedures and 25 for descriptions/)
  assert.equal(POLICY.split('\n').filter((line) => line.startsWith('- ')).length, 4)
})

test('POLICY keeps pages out of the project repository', () => {
  assert.match(POLICY, /~\/explainers\/YYYY-MM-DD-<slug>\/index\.html/)
  assert.match(POLICY, /never into the project repository/)
  assert.match(POLICY, /Open it with the system opener if one exists, give its path, and confirm that the file exists\./)
  assert.match(POLICY, /This style applies to explanations only, not to code edits, tool output, status reports, plans, reviews or final reports\. Section rules from other active modes still apply to every final answer\./)
  assert.match(POLICY, /If you cannot write the file, say so and give the explanation in the chat instead\./)
})

test('POLICY says the style overrides the page rules and never lengthens an answer', () => {
  assert.match(POLICY, /Keep a short answer short: this style never makes an answer longer, and it overrides the page rules below\./)
  assert.match(POLICY, /These limits apply to this form only\./)
})

test('POLICY ties building a page without asking to an explicit request', () => {
  assert.match(POLICY, /Build it without asking only when the user asked for a page, a visual or an interactive explanation\./)
  assert.doesNotMatch(POLICY, /explain, understand or learn the topic, build it/)
})

test('the video line says never make one on your own', () => {
  const video = POLICY.split('\n').find((line) => line.startsWith('- Video: '))
  assert.ok(video.includes('never make one on your own'))
  assert.ok(video.includes('state the cost and confirm first'))
})

// The words are built from parts so this file itself stays free of them.
const BANNED = [['advi', 'sor'], ['ski', 'll'], ['consult', '.py']].map((parts) => parts.join(''))
const bannedPattern = new RegExp(BANNED.map((word) => word.replace('.', '[.]')).join('|'), 'i')

test('POLICY names no helper, tool or script', () => {
  for (const word of BANNED) assert.ok(!POLICY.toLowerCase().includes(word), word)
  assert.doesNotMatch(POLICY, bannedPattern)
})

test('POLICY mentions Mermaid only to forbid pasting it', () => {
  const forbidden = 'Never paste Mermaid or SVG source into the chat.'
  assert.equal(POLICY.split(forbidden).length, 2)
  assert.doesNotMatch(POLICY.replace(forbidden, ''), /mermaid/i)
})

test('package.json has the identity fields and no client half', () => {
  assert.equal(pkg.name, 'dsh-plugin-explainer')
  assert.equal(pkg.version, '0.1.0')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'src/index.host.js')
  assert.deepEqual(pkg.meta, { title: 'Explainer', description: 'Per-session output style that picks the lowest clear explanation form.' })
  assert.deepEqual(pkg.dependencies, { zod: '4.4.3' })
  assert.deepEqual(pkg.peerDependencies, { '@deepseek-ai/cordis': '^4.0.0' })
  assert.equal(pkg.license, 'MIT')
  assert.equal(pkg.repository.directory, 'packages/explainer')
  assert.deepEqual(pkg.dsh, { bundle: { patch: './cordis.patch.yml' } })
  assert.equal(pkg.dsh.client, undefined)
  assert.equal(pkg.exports['./client'], undefined)
  assert.deepEqual(Object.keys(pkg.exports), ['.', './cordis.patch.yml', './locale/*.json', './icon', './package.json'])
  assert.ok(!pkg.files.includes('client.js'))
})

test('the package ships no client file and the bundle patch has one row', () => {
  assert.throws(() => read('../src/client.js'), /ENOENT/)
  const patch = read('../cordis.patch.yml').split('\n').filter((line) => !line.startsWith('#') && line.trim() !== '')
  assert.deepEqual(patch, ['- insert:', '    - id: explainer', '      name: dsh-plugin-explainer'])
})

test('both locale files carry the package meta', () => {
  assert.deepEqual(JSON.parse(read('../locale/en.json')).meta, pkg.meta)
  assert.deepEqual(Object.keys(JSON.parse(read('../locale/zh.json'))), ['meta'])
  assert.equal(JSON.parse(read('../locale/zh.json')).meta.title, 'Explainer')
})

test('the zh description uses a full-width colon and no ASCII colon', () => {
  const description = JSON.parse(read('../locale/zh.json')).meta.description
  assert.ok(description.includes('：'))
  assert.ok(!description.includes(':'))
})

test('the README pins its key sentences and the install command', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('The plugin generates no files, runs no tools, and makes no model calls.'))
  assert.ok(readme.includes('The setting is per session, and a new session starts off.'))
  assert.ok(readme.includes('dsh plugin --profile web add "$PWD/packages/explainer"'))
})

test('the README pins the five-minute stale-pending sentence, and the code agrees', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('A command sent while another update is pending is rejected until the pending one finishes or expires after five minutes.'))
  assert.equal(STALE_PENDING_MS, 5 * 60 * 1000)
  assert.equal(STALE_PENDING_MS, 300000)
})

test('the README names the new command and not the old one', () => {
  const readme = read('../README.md')
  for (const line of ['/output-style explainer', '/output-style on', '/output-style off', '/output-style status', 'Usage: /output-style explainer|off|status']) {
    assert.ok(readme.includes(line), line)
  }
  assert.doesNotMatch(readme, /(^|[\s`])\/explainer\b/)
  assert.ok(!read('../locale/en.json').includes('/explainer'))
  assert.ok(!read('../locale/zh.json').includes('/explainer'))
})

test('the README summarises the precedence and how the page is opened', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('The style never makes an answer longer and overrides the page rules; rules that require a section in a status report or final report still apply.'))
  assert.ok(readme.includes('The agent opens the page with the system opener if one exists, gives its path, and confirms that the file exists.'))
  assert.ok(readme.includes('If it cannot write the file, it says so and explains in the chat.'))
  assert.ok(readme.includes('/output-style status'))
  assert.ok(readme.includes('A video is never made on the agent\'s own initiative.'))
})

test('no package file names the banned helper words', () => {
  for (const path of ['../README.md', '../package.json', '../src/index.host.js', '../src/state.js', '../locale/en.json', '../locale/zh.json', '../icon.svg']) {
    assert.doesNotMatch(read(path), bannedPattern, path)
  }
})

// A fixed wall clock, so the handler judges a pending entry by the same time
// the fold sees. The default dispatch time of 1000 makes any pending entry
// look expired to the handler, so these tests set both explicitly.
const T0 = 50_000_000

test('with a fresh own pending entry, status says updating and a second command is rejected', async (t) => {
  const h = harness()
  await apply(h.ctx)
  t.mock.method(Date, 'now', () => T0 + 1000)
  h.feed({ type: 'command/run', time: T0, data: { name: 'output-style', args: 'explainer', commandId: 'own' } })
  const status = await h.commands[0].handler({ agent: h.agent, rawInput: 'status', commandId: 'st' })
  assert.deepEqual(status, { kind: 'success', text: 'Output style is updating to explainer for this session.' })
  const bare = await h.commands[0].handler({ agent: h.agent, rawInput: '', commandId: 'st2' })
  assert.equal(bare.text, 'Output style is updating to explainer for this session.')
  // A second, different command is rejected through the real dispatch path too.
  const rejected = await h.dispatch('off', 'other', T0 + 2000)
  assert.deepEqual(rejected, { kind: 'error', text: 'Output style is already updating. Try again after it finishes.' })
  assert.equal(h.section().text({ agent: h.agent }), '')
  // The pending entry is still the first command's, and it finishes normally.
  const own = await h.commands[0].handler({ agent: h.agent, rawInput: 'explainer', commandId: 'own' })
  assert.deepEqual(own, { kind: 'success', text: 'Output style set to explainer.' })
  h.feed({ type: 'command/done', data: { commandId: 'own', kind: 'success', text: own.text } })
  assert.equal(h.section().text({ agent: h.agent }), POLICY)
  assert.deepEqual(await h.commands[0].handler({ agent: h.agent, rawInput: 'status', commandId: 'st3' }), { kind: 'success', text: 'Output style: explainer.' })
})

test('a command dispatched with a fresh clock sees its own pending entry as its own', async (t) => {
  const h = harness()
  await apply(h.ctx)
  t.mock.method(Date, 'now', () => T0 + 10)
  assert.deepEqual(await h.dispatch('explainer', 'c-own', T0), { kind: 'success', text: 'Output style set to explainer.' })
  assert.equal(h.section().text({ agent: h.agent }), POLICY)
  assert.deepEqual(await h.dispatch('off', 'c-off', T0 + 20), { kind: 'success', text: 'Output style set to off.' })
  assert.equal(h.section().text({ agent: h.agent }), '')
})

test('the handler lets a pending command through at exactly five minutes and rejects it just under', async (t) => {
  const h = harness()
  await apply(h.ctx)
  const pending = { arg: 'on', commandId: 'p', startedAt: T0 }
  let now = T0 + STALE_PENDING_MS - 1
  t.mock.method(Date, 'now', () => now)
  h.setState({ on: false, pending, failure: null })
  assert.deepEqual(await h.commands[0].handler({ agent: h.agent, rawInput: 'off', commandId: 'q' }), { kind: 'error', text: 'Output style is already updating. Try again after it finishes.' })
  now = T0 + STALE_PENDING_MS
  assert.deepEqual(await h.commands[0].handler({ agent: h.agent, rawInput: 'off', commandId: 'q' }), { kind: 'success', text: 'Output style set to off.' })
  assert.equal((await h.commands[0].handler({ agent: h.agent, rawInput: 'status', commandId: 'q' })).text, 'Output style: off.')
})

test('the whole path replaces a stale pending command but not a fresh one', async (t) => {
  const h = harness()
  await apply(h.ctx)
  h.feed({ type: 'command/run', time: T0, data: { name: 'output-style', args: 'explainer', commandId: 'p' } })
  let now = T0 + STALE_PENDING_MS - 1
  t.mock.method(Date, 'now', () => now)
  assert.equal((await h.dispatch('off', 'fresh-q', T0 + STALE_PENDING_MS - 1)).kind, 'error')
  now = T0 + STALE_PENDING_MS
  assert.equal((await h.dispatch('off', 'stale-q', T0 + STALE_PENDING_MS)).kind, 'success')
  assert.equal(h.section().text({ agent: h.agent }), '')
})
