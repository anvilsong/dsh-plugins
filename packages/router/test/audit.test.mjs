import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { apply } from '../src/index.host.js'
import {
  AUDIT_VERDICTS, auditStatusLine, classifyDelegation, foldAudit, initAudit, isAdvisorReservedName, ROUTE_TEXT_MAX,
} from '../src/audit.js'
import { foldRouter, INITIAL_ROUTER_STATE } from '../src/state.js'

const OPUS = { provider: 'anthropic', model: 'claude-opus-5-5' }
const HAIKU = { provider: 'anthropic', model: 'claude-haiku-5-5' }
const FLASH = { provider: 'openrouter', model: '~deepseek/deepseek-flash-latest' }
const GONE = { provider: 'gone', model: 'retired' }
const AUTHORIZED = [OPUS, HAIKU, FLASH]
const label = (route) => `${route.provider}/${route.model}`
const ZERO = Object.freeze(Object.fromEntries(AUDIT_VERDICTS.map((verdict) => [verdict, 0])))

// Real-shaped events: `tool/call` data is { turn, step, callId, name, arguments }
// with `arguments` the model's raw JSON string; events carry a time.
let clock = 1_763_000_000_000
let serial = 0
const event = (type, data) => ({ type, seq: serial++, time: (clock += 1_000), data })
function command(args, kind = 'success') {
  const commandId = `command-${serial}`
  return [
    event('command/run', { name: 'router', args, commandId }),
    event('command/done', { commandId, kind, ...(kind === 'success' ? {} : { text: 'Route x is not authorized for this session.' }) }),
  ]
}
const policy = (routes) => event('subagent/model-selection-policy', { allowedModels: routes.map(({ provider, model }) => ({ provider, model })) })
/** A tool call whose `arguments` is the given text, or the JSON of the given value. */
const call = (args, data = {}) => rawCall(typeof args === 'string' ? args : JSON.stringify(args), data)
const rawCall = (value, data = {}) => event('tool/call', { turn: 1, step: 1, callId: `call_${serial}`, name: 'subagent', ...data, arguments: value })
const TASK = Object.freeze({ description: 'DESCRIPTION-MARKER fix parser', name: 'NAME-MARKER', prompt: 'PROMPT-MARKER: fix the parser and run its tests.' })
const spawn = (route = {}, extra = {}) => ({ ...TASK, ...extra, ...route })
const routed = (route, effort) => effort === undefined
  ? { provider: route.provider, model: route.model }
  : { provider: route.provider, model: route.model, reasoning_effort: effort }

const fold = (events, state = initAudit()) => events.reduce(foldAudit, state)
function session({ authorized = AUTHORIZED, levels = {}, on = true } = {}) {
  return [
    ...(authorized === null ? [] : [policy(authorized)]),
    ...(on ? command('manual') : []),
    ...Object.entries(levels).flatMap(([level, value]) => command(`level ${level} ${value}`)),
  ]
}
// Every level shows a shortlist; Flash sits in two levels with different efforts.
const BASE_LEVELS = Object.freeze({
  mechanical: `${label(FLASH)} effort=low`,
  ordinary: label(HAIKU),
  hard: `${label(OPUS)} effort=xhigh,${label(FLASH)}`,
})

/** The one verdict an event adds, or null when the audit returns the same state. */
function verdictOf(state, toolCall) {
  const next = foldAudit(state, toolCall)
  if (next === state) return null
  const changed = AUDIT_VERDICTS.filter((verdict) => next.counts[verdict] !== state.counts[verdict])
  assert.equal(changed.length, 1, JSON.stringify(next.counts))
  assert.equal(next.counts[changed[0]], state.counts[changed[0]] + 1)
  assert.equal(next.total, state.total + 1)
  return changed[0]
}
const nonZero = (state) => Object.fromEntries(AUDIT_VERDICTS.filter((verdict) => state.counts[verdict] > 0).map((verdict) => [verdict, state.counts[verdict]]))

async function definitions() {
  const units = {}
  await apply({
    sessionProjections: { async register(unit) { units[unit.key] = unit; return { stateOf: () => undefined } } },
    systemPrompt: { getSectionOrder: () => 500, section() {} },
    inject() {},
  })
  return units
}

test('every verdict, judged against the union of the prompt-visible entries of all levels', () => {
  const base = fold(session({ levels: BASE_LEVELS }))
  assert.equal(base.router.mode, 'manual')
  assert.deepEqual(base.counts, ZERO)
  const table = [
    [spawn(), 'inherit'],
    [spawn({}, { agent_preset: 'reviewer', cwd: '/tmp/work' }), 'inherit'], // no route field
    [spawn(routed(OPUS, 'xhigh')), 'match'],
    [spawn(routed(FLASH)), 'match'], // hard lists Flash without an effort
    [spawn(routed(FLASH, 'low')), 'match'], // mechanical lists it with effort low
    [spawn(routed(HAIKU)), 'match'],
    [routed(OPUS, 'xhigh'), 'match'], // no name, description or prompt needed
    [spawn(routed(OPUS, 'high')), 'effort_mismatch'],
    [spawn(routed(OPUS, 'XHIGH')), 'effort_mismatch'], // ids compare exactly
    [spawn(routed(OPUS, 'xhigh ')), 'effort_mismatch'],
    [spawn(routed(FLASH, 'high')), 'effort_mismatch'],
    [spawn(routed(HAIKU, 'low')), 'effort_mismatch'], // an entry without an effort takes none
    [spawn(routed(HAIKU, 'default')), 'effort_mismatch'],
    [spawn(routed(OPUS)), 'effort_omitted'], // every shown Opus entry carries an effort
    [spawn(routed(GONE, 'max')), 'unlisted_closed'],
    [spawn(routed({ provider: 'anthropic', model: 'claude-sonnet-5-5' })), 'unlisted_closed'],
    [spawn(routed({ provider: 'Anthropic', model: OPUS.model }, 'xhigh')), 'unlisted_closed'], // exact provider
    [spawn(routed({ provider: OPUS.provider, model: `${OPUS.model} ` }, 'xhigh')), 'unlisted_closed'], // exact model
    [spawn(routed({ provider: 'anthropic/claude-opus-5-5', model: 'x' })), 'unlisted_closed'],
    [spawn({ provider: 'anthropic' }), 'malformed'],
  ]
  const seen = new Set()
  for (const [args, expected] of table) {
    assert.equal(verdictOf(base, call(args)), expected, JSON.stringify(args))
    seen.add(expected)
  }
  // The other two verdicts need a level that reads Inherit.
  const open = fold(session({ levels: { hard: label(OPUS) } }))
  assert.equal(verdictOf(open, call(spawn(routed(GONE)))), 'unlisted_open')
  assert.equal(verdictOf(fold(session()), call(spawn(routed(OPUS)))), 'no_shortlist')
  for (const verdict of ['unlisted_open', 'no_shortlist', 'retry']) seen.add(verdict)
  assert.deepEqual([...AUDIT_VERDICTS].sort(), [...seen].sort(), 'the table covers every verdict (retry has its own test)')
  assert.deepEqual(AUDIT_VERDICTS, ['inherit', 'match', 'retry', 'effort_mismatch', 'effort_omitted', 'unlisted_closed', 'unlisted_open', 'no_shortlist', 'malformed'])
})

test('one model in two levels with different efforts matches either entry, and an entry without an effort matches the bare route', () => {
  const state = fold(session({ levels: { mechanical: `${label(OPUS)} effort=low`, hard: `${label(OPUS)} effort=xhigh` } }))
  assert.equal(verdictOf(state, call(spawn(routed(OPUS, 'low')))), 'match')
  assert.equal(verdictOf(state, call(spawn(routed(OPUS, 'xhigh')))), 'match')
  assert.equal(verdictOf(state, call(spawn(routed(OPUS, 'high')))), 'effort_mismatch')
  assert.equal(verdictOf(state, call(spawn(routed(OPUS)))), 'effort_omitted')
  const plain = fold(command(`level ordinary ${label(OPUS)}`), state)
  assert.equal(verdictOf(plain, call(spawn(routed(OPUS)))), 'match')
  assert.equal(verdictOf(plain, call(spawn(routed(OPUS, 'medium')))), 'effort_mismatch')
})

test('an unlisted route is closed only when every level shows a shortlist, open when one reads Inherit, no_shortlist when none shows one', () => {
  const unlisted = call(spawn(routed(GONE, 'max')))
  const authorizedRoute = call(spawn(routed(OPUS, 'xhigh')))
  for (const [levels, authorized, expected, why] of [
    [{ mechanical: label(FLASH), ordinary: label(HAIKU), hard: label(OPUS) }, AUTHORIZED, 'unlisted_closed', 'three shortlists'],
    [{ ordinary: label(HAIKU), hard: label(OPUS) }, AUTHORIZED, 'unlisted_open', 'mechanical inherits'],
    [{ hard: label(OPUS) }, AUTHORIZED, 'unlisted_open', 'two levels inherit'],
    [{ mechanical: `${label(GONE)} effort=low`, ordinary: label(HAIKU), hard: label(OPUS) }, AUTHORIZED, 'unlisted_open', 'a level whose saved entries are all unavailable reads Inherit'],
    [{}, AUTHORIZED, 'no_shortlist', 'every level inherits'],
    [{ mechanical: label(GONE), hard: label(GONE) }, AUTHORIZED, 'no_shortlist', 'every saved entry is unavailable'],
    [{ hard: label(OPUS) }, [], 'no_shortlist', 'nothing is authorized'],
  ]) {
    assert.equal(verdictOf(fold(session({ authorized, levels })), unlisted), expected, why)
  }
  // An authorized route outside every shortlist is no violation while all levels inherit.
  assert.equal(verdictOf(fold(session()), authorizedRoute), 'no_shortlist')
  assert.equal(verdictOf(fold(session({ levels: { hard: label(OPUS) } })), call(spawn(routed(HAIKU)))), 'unlisted_open')
})

test('only authorized saved entries are visible; before the session policy is recorded every saved entry is', () => {
  const levels = { mechanical: label(FLASH), ordinary: label(HAIKU), hard: `${label(GONE)} effort=max,${label(OPUS)} effort=xhigh` }
  const goneCall = call(spawn(routed(GONE, 'max')))
  const known = fold(session({ levels }))
  assert.deepEqual(known.authorized, AUTHORIZED)
  assert.equal(verdictOf(known, goneCall), 'unlisted_closed', 'an unauthorized saved entry is not prompt-visible')
  assert.equal(verdictOf(known, call(spawn(routed(OPUS, 'xhigh')))), 'match')
  // Unknown authorization: every saved entry counts as shown.
  const unknown = fold(session({ authorized: null, levels }))
  assert.equal(unknown.authorized, null)
  assert.equal(verdictOf(unknown, goneCall), 'match')
  const recorded = fold([policy(AUTHORIZED)], unknown)
  assert.equal(verdictOf(recorded, goneCall), 'unlisted_closed')
  // Only the first policy event counts, like routerModelRoutes.
  assert.equal(foldAudit(known, policy([...AUTHORIZED, GONE])), known)
  assert.equal(foldAudit(known, policy([])), known)
  // The routes keep only provider and model; unusable entries are left out; a list that is no array changes nothing.
  const kept = foldAudit(initAudit(), event('subagent/model-selection-policy', { allowedModels: [
    { ...OPUS, display: 'Opus', efforts: ['high'] }, { provider: '', model: 'x' }, { provider: 5, model: 'y' }, null, 'anthropic/claude-haiku-5-5', HAIKU,
  ] }))
  assert.deepEqual(kept.authorized, [OPUS, HAIKU])
  for (const allowedModels of [undefined, null, 'all', { 0: OPUS }]) {
    const initial = initAudit()
    assert.equal(foldAudit(initial, event('subagent/model-selection-policy', { allowedModels })), initial, String(allowedModels))
  }
  const empty = foldAudit(initAudit(), policy([]))
  assert.deepEqual(empty.authorized, [], 'an empty list is recorded: nothing is shown')
})

test('a saved entry is shown only when its provider and its model are both authorized', () => {
  const SONNET = { provider: 'anthropic', model: 'claude-sonnet-5-5' }
  const BEDROCK_OPUS = { provider: 'bedrock', model: OPUS.model }
  const state = fold(session({ authorized: [OPUS, HAIKU], levels: { mechanical: label(OPUS), ordinary: label(HAIKU), hard: `${label(SONNET)},${label(BEDROCK_OPUS)}` } }))
  // Hard holds no authorized entry, so it reads Inherit (saved routes unavailable).
  assert.equal(verdictOf(state, call(spawn(routed(SONNET)))), 'unlisted_open', 'an authorized provider alone shows nothing')
  assert.equal(verdictOf(state, call(spawn(routed(BEDROCK_OPUS)))), 'unlisted_open', 'an authorized model alone shows nothing')
  assert.equal(verdictOf(state, call(spawn(routed(OPUS)))), 'match')
  const shown = fold(command(`level hard ${label(OPUS)}`), state)
  assert.equal(verdictOf(shown, call(spawn(routed(SONNET)))), 'unlisted_closed')
})

test('nothing is counted while Router is off; the mode follows command/run and command/done mid-log', () => {
  const opus = () => call(spawn(routed(OPUS, 'xhigh')))
  let state = fold([policy(AUTHORIZED), ...command(`level hard ${label(OPUS)} effort=xhigh`)])
  assert.equal(state.router.mode, 'off')
  for (const toolCall of [opus(), call(spawn()), call('{'), call(spawn(routed(GONE)))]) assert.equal(foldAudit(state, toolCall), state)
  const [runOn, doneOn] = command('manual')
  state = foldAudit(state, runOn)
  assert.equal(foldAudit(state, opus()), state, 'a pending switch is not on yet')
  state = foldAudit(state, doneOn)
  assert.equal(verdictOf(state, opus()), 'match')
  state = fold([opus(), opus()], state)
  const [runOff, failOff] = command('off', 'error')
  state = fold([runOff, opus(), failOff, opus()], state)
  assert.equal(state.counts.match, 4, 'a pending off still counts; a failed off leaves Router on')
  state = fold(command('off'), state)
  assert.equal(state.router.mode, 'off')
  const off = state
  assert.equal(fold([opus(), call(spawn()), call('{')], off), off)
  state = fold([...command(''), opus()], state)
  assert.equal(state.router.mode, 'manual', 'the bare command toggles back on')
  assert.deepEqual(nonZero(state), { match: 5 })
  assert.equal(state.total, 5)
})

test('each request is judged against the shortlist in force at its event', () => {
  let state = fold(session({ levels: { hard: `${label(OPUS)} effort=xhigh` } }))
  const opus = (effort) => call(spawn(routed(OPUS, effort)))
  assert.equal(verdictOf(state, opus('xhigh')), 'match')
  assert.equal(verdictOf(state, opus('high')), 'effort_mismatch')
  const [run, done] = command(`level hard ${label(OPUS)} effort=high`)
  state = foldAudit(state, run)
  assert.equal(verdictOf(state, opus('xhigh')), 'match', 'a pending change does not apply yet')
  state = foldAudit(state, done)
  assert.equal(verdictOf(state, opus('xhigh')), 'effort_mismatch')
  assert.equal(verdictOf(state, opus('high')), 'match')
  state = fold(command(`level hard ${label(HAIKU)}`, 'error'), state)
  assert.equal(verdictOf(state, opus('high')), 'match', 'a rejected change keeps the level')
  state = fold(command('level hard inherit'), state)
  assert.equal(verdictOf(state, opus('high')), 'no_shortlist')
  state = fold(command(`level ordinary ${label(HAIKU)}`), state)
  assert.equal(verdictOf(state, opus('high')), 'unlisted_open')
  // A log that changes the shortlist between requests counts each against its own.
  const log = fold([
    ...session({ levels: { hard: `${label(OPUS)} effort=xhigh` } }),
    opus('xhigh'),
    ...command(`level hard ${label(OPUS)} effort=high`),
    opus('xhigh'),
    ...command('level hard inherit'),
    opus('xhigh'),
  ])
  assert.deepEqual(nonZero(log), { match: 1, effort_mismatch: 1, no_shortlist: 1 })
})

test('retry: effort omitted on the same route directly after its effort match in the same turn', () => {
  const base = fold(session({ levels: BASE_LEVELS }))
  const opus = (effort, turn = 4, step = 1) => call(spawn(routed(OPUS, effort)), { turn, step })
  // A spawn rejected for its effort plus its retry are two requests: match + retry.
  let state = fold([
    opus('xhigh', 4, 1),
    event('tool/result', { turn: 4, step: 1, message: { role: 'tool', content: [{ type: 'text', text: 'unsupported reasoning_effort' }], isError: true } }),
    event('assistant/message', { turn: 4, step: 2, message: { role: 'assistant', content: 'The effort was rejected; retrying once without it.' } }),
    opus(undefined, 4, 2),
  ], base)
  assert.deepEqual(nonZero(state), { match: 1, retry: 1 })
  assert.equal(state.lastEffortMatch, null, 'one retry per effort match')
  assert.equal(verdictOf(state, opus(undefined, 4, 3)), 'effort_omitted', 'a second omission is no retry')
  const matched = foldAudit(base, opus('xhigh', 4))
  assert.deepEqual(matched.lastEffortMatch, { ...OPUS, effort: 'xhigh', turn: 4 })
  assert.equal(verdictOf(matched, opus(undefined, 4)), 'retry')
  assert.equal(verdictOf(matched, opus(undefined, 5)), 'effort_omitted', 'another turn')
  assert.equal(verdictOf(matched, call(spawn(routed(OPUS)), { turn: '4' })), 'effort_omitted', 'a turn that is no number')
  assert.equal(verdictOf(matched, call(spawn(routed(OPUS)), { turn: undefined })), 'effort_omitted', 'no turn')
  const flashFirst = foldAudit(base, call(spawn(routed(FLASH, 'low')), { turn: 4 }))
  assert.deepEqual(flashFirst.lastEffortMatch, { ...FLASH, effort: 'low', turn: 4 })
  assert.equal(verdictOf(flashFirst, opus(undefined, 4)), 'effort_omitted', 'another route')
  // A shown entry without an effort is a match, not a retry.
  assert.equal(verdictOf(flashFirst, call(spawn(routed(FLASH)), { turn: 4 })), 'match')
  // Any audited request in between breaks the adjacency.
  for (const [between, why] of [
    [call(spawn(), { turn: 4 }), 'inherit'],
    [call('{', { turn: 4 }), 'malformed'],
    [opus('high', 4), 'effort_mismatch'],
    [call(spawn(routed(FLASH)), { turn: 4 }), 'an effort-less match'],
    [call(spawn(routed(GONE)), { turn: 4 }), 'unlisted'],
  ]) assert.equal(verdictOf(foldAudit(matched, between), opus(undefined, 4)), 'effort_omitted', why)
  // Requests the audit does not count leave it in place.
  const skipped = fold([
    call({}, { turn: 4, name: 'list_subagent_models' }),
    call(spawn(routed(OPUS, 'xhigh'), { name: 'advisor-verifier-0123456789ab' }), { turn: 4 }),
    call(spawn(routed(OPUS)), { turn: 4, name: 'subagent_fork' }),
    event('tool/result', { turn: 4, step: 1, message: { role: 'tool', content: [] } }),
  ], matched)
  assert.equal(skipped, matched)
  assert.equal(verdictOf(skipped, opus(undefined, 4)), 'retry')
  // An effort match without a turn number records nothing to retry.
  const unnumbered = foldAudit(base, call(spawn(routed(OPUS, 'xhigh')), { turn: undefined }))
  assert.deepEqual(nonZero(unnumbered), { match: 1 })
  assert.equal(unnumbered.lastEffortMatch, null)
  assert.equal(foldAudit(base, call(spawn(routed(FLASH)), { turn: 4 })).lastEffortMatch, null, 'an effort-less match records nothing')
})

test('a retry needs the provider and the model of the effort match', () => {
  const BEDROCK_OPUS = { provider: 'bedrock', model: OPUS.model }
  const state = fold(session({
    authorized: [...AUTHORIZED, BEDROCK_OPUS],
    levels: { mechanical: `${label(BEDROCK_OPUS)} effort=high`, ordinary: `${label(HAIKU)} effort=low`, hard: `${label(OPUS)} effort=xhigh` },
  }))
  const matched = foldAudit(state, call(spawn(routed(OPUS, 'xhigh')), { turn: 4 }))
  assert.deepEqual(matched.lastEffortMatch, { ...OPUS, effort: 'xhigh', turn: 4 })
  // The same provider with another model listed with an effort: the model check decides.
  assert.equal(verdictOf(matched, call(spawn(routed(HAIKU)), { turn: 4 })), 'effort_omitted')
  // The same model under another provider listed with an effort: the provider check decides.
  assert.equal(verdictOf(matched, call(spawn(routed(BEDROCK_OPUS)), { turn: 4 })), 'effort_omitted')
  assert.equal(verdictOf(matched, call(spawn(routed(OPUS)), { turn: 4 })), 'retry')
})

test('advisor-reserved children and other delegation tools are not audited', () => {
  const base = fold(session({ levels: BASE_LEVELS }))
  const unlisted = routed(GONE, 'max')
  for (const name of [
    'advisor-verifier-0123456789ab', 'advisor-planner-0123456789ab', 'advisor-consult-0123456789ab',
    'advisor-verifier', 'advisor-planner', 'advisor-consult', 'advisor-verifier-typo', 'advisor-planner-',
  ]) {
    assert.equal(isAdvisorReservedName(name), true, name)
    assert.equal(foldAudit(base, call(spawn(unlisted, { name }))), base, name)
    assert.equal(foldAudit(base, call({ name })), base, `${name} without a route`)
  }
  for (const name of ['advisor-verifiers', 'advisor-other-0123456789ab', 'my-advisor-verifier-0123456789ab', 'Advisor-verifier-0123456789ab', 'advisor-', 'worker', 5, null]) {
    assert.equal(isAdvisorReservedName(name), false, String(name))
    assert.equal(verdictOf(base, call(spawn(unlisted, { name }))), 'unlisted_closed', String(name))
  }
  for (const name of ['subagent_fork', 'subagent_codex', 'subagent_claude_code', 'spawn_teammate', 'Subagent', 'subagent ', 'list_subagent_models', 'bash', undefined, null]) {
    assert.equal(foldAudit(base, call(spawn(unlisted), { name })), base, String(name))
  }
})

test('arguments that are no JSON object, partial or empty routes, and wrong types are malformed', () => {
  const base = fold(session({ levels: BASE_LEVELS }))
  for (const text of [
    '', ' ', '{', '{"provider":"anthropic"', 'undefined', "{'provider':'anthropic','model':'claude-opus-5-5'}",
    'null', '[]', '[{"provider":"anthropic","model":"claude-opus-5-5"}]', '42', '"subagent"', 'true',
    `${'['.repeat(200_000)}${']'.repeat(200_000)}`,
  ]) assert.equal(verdictOf(base, call(text)), 'malformed', text.slice(0, 40))
  for (const value of [undefined, null, 7, true, { ...OPUS }, [label(OPUS)]]) {
    assert.equal(verdictOf(base, rawCall(value)), 'malformed', `arguments ${JSON.stringify(value)} is no JSON text`)
  }
  for (const args of [
    { provider: 'anthropic' }, // provider without model
    { model: 'claude-opus-5-5' }, // model without provider
    { reasoning_effort: 'xhigh' }, // effort without a route
    { provider: 'anthropic', reasoning_effort: 'xhigh' },
    { model: 'claude-opus-5-5', reasoning_effort: 'xhigh' },
    { provider: '', model: 'claude-opus-5-5' }, // the subagent tool refuses empty values
    { provider: 'anthropic', model: '' },
    { ...routed(OPUS), reasoning_effort: '' },
    { provider: '', model: '', reasoning_effort: '' },
    { provider: null }, // null is no omission
    { provider: null, model: null, reasoning_effort: null },
    { ...routed(OPUS), reasoning_effort: null },
    { provider: 'anthropic', model: 5 },
    { provider: ['anthropic'], model: 'claude-opus-5-5' },
    { provider: { id: 'anthropic' }, model: 'claude-opus-5-5' },
    { ...routed(OPUS), reasoning_effort: 3 },
    { ...routed(OPUS), reasoning_effort: ['xhigh'] },
    { ...routed(OPUS), reasoning_effort: false },
  ]) assert.equal(verdictOf(base, call(spawn(args))), 'malformed', JSON.stringify(args))
})

test('huge arguments stay bounded: stored provider and model ids are cut, efforts kept only as EFFORT_ID, and no task text is kept', () => {
  assert.equal(ROUTE_TEXT_MAX, 200)
  const longProvider = `p${'r'.repeat(249)}`
  const longModel = `m${'o'.repeat(299)}`
  const long = { provider: longProvider, model: longModel }
  const state = fold(session({ authorized: [...AUTHORIZED, long], levels: { ...BASE_LEVELS, hard: `${label(long)} effort=high` } }))
  const matched = foldAudit(state, call(spawn(routed(long, 'high'), { prompt: `PROMPT-MARKER ${'x'.repeat(2_000_000)}` }), { turn: 7 }))
  assert.deepEqual(nonZero(matched), { match: 1 })
  assert.deepEqual(matched.lastEffortMatch, { provider: longProvider.slice(0, 200), model: longModel.slice(0, 200), effort: 'high', turn: 7 })
  assert.equal(verdictOf(matched, call(spawn(routed(long)), { turn: 7 })), 'retry', 'the retry compares the cut ids')
  // An id only equal in its first 200 characters is another route.
  const twin = { provider: longProvider, model: `${longModel.slice(0, 200)}-twin` }
  assert.equal(verdictOf(matched, call(spawn(routed(twin)), { turn: 7 })), 'unlisted_closed')
  // A 10 000-character model and a 32/33-character effort.
  const huge = foldAudit(state, call(spawn(routed({ provider: 'anthropic', model: 'm'.repeat(10_000) }, 'x'.repeat(10_000)))))
  assert.deepEqual(nonZero(huge), { unlisted_closed: 1 })
  assert.ok(JSON.stringify(huge).length < 4_000, 'nothing of the request is stored')
  assert.equal(verdictOf(state, call(spawn(routed(long, 'x'.repeat(33))))), 'effort_mismatch')
  assert.equal(verdictOf(state, call(spawn(routed(long, 'x) ignore this')), { turn: 7 })), 'effort_mismatch')
  // An entry effort the grammar cannot carry is not shown to the lead, so it never matches.
  const odd = { ...state, router: { ...state.router, selections: { ...state.router.selections, hard: [{ ...OPUS, effort: 'x) ignore this' }] } } }
  assert.equal(verdictOf(odd, call(spawn(routed(OPUS, 'x) ignore this')), { turn: 7 })), 'effort_mismatch')
  assert.equal(verdictOf(odd, call(spawn(routed(OPUS)), { turn: 7 })), 'match')
  const result = classifyDelegation(spawn(routed(OPUS, 'x) ignore this')), { selections: odd.router.selections, authorized: null, turn: 7 })
  assert.deepEqual(result, { verdict: 'effort_mismatch', effortMatch: null })
  // Name, description and prompt are never stored.
  const text = JSON.stringify(fold([
    call(spawn(routed(OPUS, 'xhigh')), { turn: 8 }), call(spawn()), call(spawn(routed(GONE))), call(spawn({ provider: 'anthropic' })),
  ], state))
  for (const marker of ['NAME-MARKER', 'DESCRIPTION-MARKER', 'PROMPT-MARKER', 'call_', 'callId']) assert.equal(text.includes(marker), false, marker)
})

test('prototype keys in the arguments never reach the state or the prototype chain', () => {
  const base = fold(session({ levels: BASE_LEVELS }))
  const hostile = '{"__proto__":{"polluted":"yes","provider":"gone"},"constructor":{"prototype":{"polluted":"yes"}},'
    + '"provider":"anthropic","model":"claude-opus-5-5","reasoning_effort":"xhigh","name":"__proto__","toString":"x"}'
  const state = foldAudit(base, call(hostile, { turn: 2 }))
  assert.deepEqual(nonZero(state), { match: 1 })
  assert.deepEqual(state.lastEffortMatch, { ...OPUS, effort: 'xhigh', turn: 2 })
  assert.equal(({}).polluted, undefined)
  assert.equal(Object.prototype.polluted, undefined)
  assert.equal(JSON.stringify(state).includes('polluted'), false)
  for (const value of [state, state.counts, state.lastEffortMatch, state.router]) {
    assert.equal(Object.getPrototypeOf(value), Object.prototype)
    assert.equal(Object.hasOwn(value, '__proto__'), false)
    assert.equal(Object.hasOwn(value, 'constructor'), false)
  }
  assert.deepEqual(Object.keys(state.counts), AUDIT_VERDICTS)
  // A route under __proto__ is no route; an inherited property is never read.
  assert.equal(verdictOf(base, call('{"__proto__":{"provider":"anthropic","model":"claude-opus-5-5"}}')), 'inherit')
  assert.equal(verdictOf(base, call('{"constructor":{"provider":"anthropic"}}')), 'inherit')
  const modelOnly = call(spawn({ model: 'claude-opus-5-5' }))
  Object.prototype.provider = 'anthropic' // eslint-disable-line no-extend-native
  let polluted
  try {
    polluted = foldAudit(base, modelOnly)
  } finally {
    delete Object.prototype.provider
  }
  assert.deepEqual(nonZero(polluted), { malformed: 1 }, 'an inherited provider is not read')
  // Ids named like prototype keys are plain strings.
  const named = fold(session({ authorized: null, levels: { hard: '__proto__/constructor effort=low' } }))
  const matched = foldAudit(named, call(spawn({ provider: '__proto__', model: 'constructor', reasoning_effort: 'low' }), { turn: 3 }))
  assert.deepEqual(nonZero(matched), { match: 1 })
  assert.deepEqual(Object.entries(matched.lastEffortMatch), [['provider', '__proto__'], ['model', 'constructor'], ['effort', 'low'], ['turn', 3]])
  assert.equal(Object.getPrototypeOf(matched.lastEffortMatch), Object.prototype)
})

test('events the audit does not read return the same state reference', () => {
  const base = fold(session({ levels: BASE_LEVELS }))
  const off = fold(command('off'), base)
  const cases = [
    [base, event('turn/start', { turn: 9 })],
    [base, event('turn/end', { turn: 9, reason: 'completed' })],
    [base, event('tool/result', { turn: 1, step: 1, message: { role: 'tool', content: [] } })],
    [base, event('assistant/message', { message: { role: 'assistant', content: 'router: hard → anthropic/claude-opus-5-5' } })],
    [base, event('user/message', { message: { role: 'user', content: 'go' } })],
    [base, event('command/run', { name: 'ultracode', args: 'on', commandId: 'u1' })],
    [base, event('command/done', { commandId: 'u1', kind: 'success' })],
    [base, event('command/run', { name: 'router', args: 'status', commandId: 's1' })],
    [base, event('command/done', { commandId: 's1', kind: 'success' })],
    [base, event('command/run', { name: 'router', args: 'level hard a/b effort=x!', commandId: 'bad' })],
    [base, event('command/done', { kind: 'success' })],
    [base, policy([GONE])],
    [base, call(spawn(routed(OPUS, 'xhigh')), { name: 'bash' })],
    [base, call(spawn(routed(OPUS, 'xhigh'), { name: 'advisor-consult-0123456789ab' }))],
    [off, call(spawn(routed(OPUS, 'xhigh')))],
    [off, call('{')],
    // Commands whose id the router state could not hold are not folded.
    [base, event('command/run', { name: 'router', args: 'off', commandId: 7 })],
    [base, { type: 'command/run', time: 5, data: { name: 'router', args: 'off' } }],
    // Garbage.
    [base, null], [base, undefined], [base, 0], [base, 'tool/call'], [base, []], [base, {}],
    [base, { type: 'tool/call' }], [base, { type: 'tool/call', data: null }], [base, { type: 'tool/call', data: 'subagent' }],
    [base, { type: 'command/run', data: null }], [base, { type: 'command/run', data: 'router' }], [base, { type: 'command/done' }],
    [base, { type: 'subagent/model-selection-policy', data: null }],
    [base, { get type() { throw new Error('hostile type') } }],
    [base, { type: 'tool/call', get data() { throw new Error('hostile data') } }],
    [base, { type: 'tool/call', data: { name: 'subagent', get arguments() { throw new Error('hostile arguments') } } }],
    [base, { type: 'command/run', data: { get name() { throw new Error('hostile name') } } }],
  ]
  for (const [index, [state, value]] of cases.entries()) assert.equal(foldAudit(state, value), state, `case ${index}`)
})

test('the fold never reads the clock: a command without a time folds as time 0, the same on every replay', () => {
  const timeless = (events) => events.map(({ time, ...rest }) => rest)
  const log = [
    policy(AUTHORIZED),
    ...timeless(command('manual')),
    ...timeless(command(`level hard ${label(OPUS)} effort=xhigh`)),
    ...timeless([event('command/run', { name: 'router', args: 'off', commandId: 'pending-off' })]),
    { ...event('command/run', { name: 'router', args: 'level ordinary inherit', commandId: 'late' }), time: 'soon' },
    timeless([call(spawn(routed(OPUS, 'xhigh')), { turn: 2 })])[0],
  ]
  const realNow = Date.now
  let reads = 0
  Date.now = () => { reads++; throw new Error('the audit fold must not read the clock') }
  let first, second
  try {
    first = fold(log)
    second = fold(log)
  } finally {
    Date.now = realNow
  }
  assert.equal(reads, 0)
  assert.deepEqual(second, first)
  assert.equal(first.router.pending.commandId, 'pending-off')
  assert.equal(first.router.pending.startedAt, 0)
  assert.equal(first.router.lastRun.commandId, 'late', 'the overlapping run is not admitted, as in the router fold')
  assert.deepEqual(nonZero(first), { match: 1 })
  // Exactly the router fold over the same events with time 0.
  const zeroed = log.map((entry) => entry.type.startsWith('command/') && !Number.isFinite(entry.time) ? { ...entry, time: 0 } : entry)
  assert.deepEqual(first.router, zeroed.reduce(foldRouter, INITIAL_ROUTER_STATE))
})

test('a command event is read once: fields that change between reads never reach the clock or the state', async () => {
  const { routerAudit } = await definitions()
  let timeReads = 0
  const flakyTime = {
    type: 'command/run',
    data: { name: 'router', args: 'manual', commandId: 'flaky' },
    get time() { timeReads++; return timeReads === 1 ? 5 : undefined },
  }
  let idReads = 0
  const flakyId = {
    type: 'command/run',
    time: 6,
    data: { name: 'router', args: 'manual', get commandId() { idReads++; return idReads === 1 ? 'checked' : 7 } },
  }
  const realNow = Date.now
  let clockReads = 0
  Date.now = () => { clockReads++; throw new Error('the audit fold must not read the clock') }
  let byTime, byId
  try {
    byTime = foldAudit(initAudit(), flakyTime)
    byId = foldAudit(initAudit(), flakyId)
  } finally {
    Date.now = realNow
  }
  assert.equal(clockReads, 0, 'Date.now was never called')
  assert.deepEqual(byTime.router.pending, { target: 'mode', arg: 'manual', commandId: 'flaky', startedAt: 5 })
  assert.deepEqual(byId.router.pending, { target: 'mode', arg: 'manual', commandId: 'checked', startedAt: 6 }, 'the commandId kept is the one checked')
  for (const state of [byTime, byId]) assert.deepEqual(routerAudit.stateSchema.parse(state), state)
})

function realisticLog() {
  const turn = (number, step = 1) => ({ turn: number, step })
  return [
    policy(AUTHORIZED),
    event('turn/start', { turn: 1 }),
    call(spawn(routed(OPUS, 'xhigh')), turn(1)), // Router is off
    event('turn/end', { turn: 1, reason: 'completed' }),
    ...command('manual'),
    ...command(`level hard ${label(OPUS)} effort=xhigh,${label(FLASH)}`),
    ...command(`level mechanical ${label(FLASH)} effort=low`),
    event('turn/start', { turn: 2 }),
    call({}, { ...turn(2), name: 'list_subagent_models' }),
    call(spawn(routed(OPUS, 'xhigh')), turn(2, 2)), // match
    event('tool/result', { ...turn(2, 2), message: { role: 'tool', content: [{ type: 'text', text: 'unsupported effort' }], isError: true } }),
    call(spawn(routed(OPUS)), turn(2, 3)), // retry
    call(spawn(), turn(2, 4)), // inherit
    call(spawn(routed(GONE, 'max')), turn(2, 4)), // unlisted_open: ordinary inherits
    call('{"provider":"anthropic"', turn(2, 5)), // malformed
    call(spawn(routed(OPUS, 'xhigh'), { name: 'advisor-verifier-0123456789ab' }), turn(2, 6)), // skipped
    event('turn/end', { turn: 2, reason: 'completed' }),
    ...command(`level ordinary ${label(HAIKU)}`),
    ...command('off'),
    call(spawn(routed(HAIKU, 'low')), turn(3)), // Router is off
    ...command('on'),
    call(spawn(routed(HAIKU, 'low')), turn(4)), // effort_mismatch
    call(spawn(routed(GONE)), turn(4)), // unlisted_closed
    call(spawn(routed(FLASH)), turn(4)), // match: hard lists Flash without an effort
    call(spawn(routed(OPUS)), turn(4)), // effort_omitted: the request before it was no effort match
  ]
}

test('a replay folds the same log to the same state; a checkpoint plus its suffix equals the full fold', async () => {
  const { routerAudit } = await definitions()
  const log = realisticLog()
  const once = fold(log, routerAudit.init())
  assert.deepEqual(nonZero(once), { inherit: 1, match: 2, retry: 1, effort_mismatch: 1, effort_omitted: 1, unlisted_closed: 1, unlisted_open: 1, malformed: 1 })
  assert.equal(once.total, 9)
  assert.deepEqual(fold(log, routerAudit.init()), once)
  for (let cut = 0; cut <= log.length; cut++) {
    // A persisted checkpoint is plain JSON validated by the state schema.
    const checkpoint = routerAudit.stateSchema.parse(JSON.parse(JSON.stringify(fold(log.slice(0, cut), routerAudit.init()))))
    assert.deepEqual(fold(log.slice(cut), checkpoint), once, `cut ${cut}`)
  }
})

test('the embedded router state is foldRouter over the same events, prefix by prefix', () => {
  let audit = initAudit()
  let router = INITIAL_ROUTER_STATE
  for (const entry of realisticLog()) {
    audit = foldAudit(audit, entry)
    router = foldRouter(router, entry)
    assert.deepEqual(audit.router, router)
  }
  assert.equal(audit.router.mode, 'manual')
})

test('the registered unit: routerAudit, stateVersion 1, host-only, its schema embedding the router state schema', async () => {
  const units = await definitions()
  const unit = units.routerAudit
  assert.deepEqual(Object.keys(units), ['router', 'routerModelRoutes', 'routerAudit'])
  assert.equal(unit.key, 'routerAudit')
  assert.equal(unit.stateVersion, 1, 'bump routerAudit stateVersion together with the router stateVersion')
  assert.equal(units.router.stateVersion, 5, 'bump routerAudit stateVersion together with the router stateVersion')
  assert.equal('wire' in unit, false, 'host-only: never sent to the Client')
  assert.equal(unit.apply, foldAudit)
  assert.equal(unit.stateSchema.shape.router, units.router.stateSchema, 'the router part is validated by the router schema itself')
  const initial = unit.init({ id: 'header' }, 0)
  assert.deepEqual(initial, { router: INITIAL_ROUTER_STATE, authorized: null, counts: ZERO, total: 0, lastEffortMatch: null })
  const again = unit.init()
  assert.notEqual(again, initial)
  assert.notEqual(again.counts, initial.counts)
  assert.notEqual(again.router.selections, initial.router.selections)
  assert.notEqual(again.router.selections, INITIAL_ROUTER_STATE.selections)
  assert.deepEqual(unit.stateSchema.parse(initial), initial)
  const full = fold(realisticLog(), initial)
  assert.deepEqual(unit.stateSchema.parse(full), full)
  const withMatch = foldAudit(fold(session({ levels: BASE_LEVELS })), call(spawn(routed(OPUS, 'xhigh')), { turn: 3 }))
  assert.deepEqual(unit.stateSchema.parse(withMatch), withMatch)
  const lastMatch = (value) => ({ ...withMatch, lastEffortMatch: { ...withMatch.lastEffortMatch, ...value } })
  for (const [name, bad] of [
    ['a cut id longer than 200', lastMatch({ model: 'm'.repeat(201) })],
    ['an empty provider', lastMatch({ provider: '' })],
    ['an effort outside EFFORT_ID', lastMatch({ effort: 'x y' })],
    ['an effort of 33 characters', lastMatch({ effort: 'x'.repeat(33) })],
    ['a turn that is no integer', lastMatch({ turn: 1.5 })],
    ['a missing turn', { ...withMatch, lastEffortMatch: { ...OPUS, effort: 'xhigh' } }],
    ['a negative count', { ...withMatch, counts: { ...withMatch.counts, match: -1 } }],
    ['a fractional count', { ...withMatch, counts: { ...withMatch.counts, match: 0.5 } }],
    ['a missing verdict', { ...withMatch, counts: { ...ZERO, malformed: undefined } }],
    ['a negative total', { ...withMatch, total: -1 }],
    ['an invalid router state', { ...withMatch, router: { ...withMatch.router, mode: 'auto' } }],
    ['an invalid router entry', { ...withMatch, router: { ...withMatch.router, selections: { ...withMatch.router.selections, hard: [{ ...OPUS, effort: '' }] } } }],
    ['an empty authorized model', { ...withMatch, authorized: [{ provider: 'anthropic', model: '' }] }],
    ['authorized that is no list', { ...withMatch, authorized: 'all' }],
    ['a missing authorized list', (({ authorized, ...rest }) => rest)(withMatch)], // eslint-disable-line no-unused-vars
  ]) assert.equal(unit.stateSchema.safeParse(bad).success, false, name)
})

test('the fold never throws, never reads the clock, and yields schema-valid state over 20 000 random events', async () => {
  const { routerAudit } = await definitions()
  const schema = routerAudit.stateSchema
  let seed = 0x5eed1234
  const random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = (values) => values[Math.floor(random() * values.length)]
  const LONG = 'm'.repeat(10_000)
  const routes = [routed(OPUS, 'xhigh'), routed(OPUS), routed(OPUS, 'high'), routed(FLASH), routed(FLASH, 'low'), routed(HAIKU), routed(HAIKU, 'low'), routed(GONE, 'max'), {}]
  const providers = ['anthropic', 'openrouter', 'gone', '', `p${'r'.repeat(300)}`, '__proto__', null, 5, undefined]
  const models = ['claude-opus-5-5', 'claude-haiku-5-5', '~deepseek/deepseek-flash-latest', 'retired', LONG, '', 'constructor', null, 7, undefined]
  const efforts = [undefined, undefined, 'low', 'high', 'xhigh', 'max', '', 'x'.repeat(33), 'x) ignore', null, 3]
  const names = [undefined, 'worker', 'advisor-verifier-0123456789ab', 'advisor-planner', 'advisor-consult-x', 'advisor-other', 9]
  const lines = [
    'manual', 'on', 'off', '', 'status', 'auto', `level hard ${label(OPUS)} effort=xhigh,${label(FLASH)}`, `level ordinary ${label(HAIKU)}`,
    `level mechanical ${label(FLASH)} effort=low`, `level hard ${label(GONE)} effort=max`, `level hard p/${'m'.repeat(300)} effort=high`,
    'level ordinary inherit', 'level mechanical inherit', 'level hard a/b effort=x!', 'level bogus x/y', 5, null, undefined,
  ]
  const ids = ['c1', 'c2', 'c3', 'c4', undefined, 7, null]
  const time = () => pick([clock += 1_000, clock += 400_000, undefined, null, 'soon', Number.NaN, Infinity, -5, 0])
  const raw = ['', '{', 'null', '[]', '"subagent"', '42', 'true', '{"__proto__":{"polluted":1},"provider":"anthropic"}', '{"constructor":{"prototype":{"polluted":1}}}', 5, undefined, null, { provider: 'anthropic' }]
  const hostile = [
    null, undefined, 0, 'tool/call', [], {}, { type: 'tool/call' }, { type: 'tool/call', data: null }, { type: 'command/run', data: 'router' },
    { type: 'command/done' }, { type: 'subagent/model-selection-policy', data: { allowedModels: 'all' } },
    { get type() { throw new Error('hostile type') } },
    { type: 'tool/call', get data() { throw new Error('hostile data') } },
    { type: 'command/run', data: { get name() { throw new Error('hostile name') } } },
    { type: 'tool/call', data: { name: 'subagent', get arguments() { throw new Error('hostile arguments') } } },
    { type: 'subagent/model-selection-policy', data: { get allowedModels() { throw new Error('hostile policy') } } },
  ]
  const events = []
  let previous = null
  for (let index = 0; index < 20_000; index++) {
    const roll = random()
    if (roll < 0.5) {
      let data
      if (previous !== null && random() < 0.25) {
        // A retry-like follow-up: the previous request without its effort, same turn and tool.
        const { reasoning_effort: _, ...args } = previous.args // eslint-disable-line no-unused-vars
        data = { ...previous.data, callId: `f${index}`, arguments: JSON.stringify(args) }
        previous = { args, data }
      } else {
        let args
        if (random() < 0.6) {
          args = { ...pick(routes) }
        } else {
          args = {}
          for (const [key, values] of [['provider', providers], ['model', models], ['reasoning_effort', efforts]]) {
            const value = pick(values)
            if (value !== undefined) args[key] = value
          }
        }
        const name = pick(names)
        if (name !== undefined) args.name = name
        if (random() < 0.3) args.prompt = TASK.prompt
        data = {
          turn: pick([1, 1, 2, 2, 3, undefined, '2', 1.5, null]), step: 1, callId: `f${index}`,
          name: pick(['subagent', 'subagent', 'subagent', 'subagent', 'subagent_fork', 'bash', 'Subagent', undefined]),
          arguments: random() < 0.9 ? JSON.stringify(args) : pick(raw),
        }
        previous = { args, data }
      }
      events.push({ type: 'tool/call', time: time(), data })
    } else if (roll < 0.66) {
      events.push({ type: 'command/run', time: time(), data: { name: pick(['router', 'router', 'router', 'ultracode', undefined]), args: pick(lines), commandId: pick(ids) } })
    } else if (roll < 0.8) {
      events.push({ type: 'command/done', time: time(), data: { commandId: pick(ids), kind: pick(['success', 'success', 'error', undefined, 5]), text: pick([undefined, 'Route x is not authorized', 5]) } })
    } else if (roll < 0.84) {
      events.push({ type: 'subagent/model-selection-policy', time: time(), data: { allowedModels: pick([AUTHORIZED, [], [GONE], 'all', null, [{ provider: 5 }], [OPUS, { provider: '', model: 'x' }]]) } })
    } else if (roll < 0.95) {
      events.push({ type: pick(['turn/start', 'turn/end', 'tool/result', 'assistant/message', 'user/message', 'compaction/done']), time: time(), data: { turn: 1, step: 1 } })
    } else {
      events.push(pick(hostile))
    }
  }
  const realNow = Date.now
  let reads = 0
  const start = fold(session({ levels: BASE_LEVELS }))
  let state = start
  const seen = new Set()
  Date.now = () => { reads++; throw new Error('the audit fold must not read the clock') }
  try {
    for (const entry of events) {
      const before = JSON.stringify(state)
      const next = foldAudit(state, entry)
      assert.equal(JSON.stringify(state), before, 'the fold never mutates its input')
      if (next === state) continue
      assert.deepEqual(schema.parse(next), next)
      assert.equal(next.total, AUDIT_VERDICTS.reduce((sum, verdict) => sum + next.counts[verdict], 0))
      for (const verdict of AUDIT_VERDICTS) if (next.counts[verdict] > state.counts[verdict]) seen.add(verdict)
      if (next.lastEffortMatch !== null) {
        assert.ok(next.lastEffortMatch.provider.length <= ROUTE_TEXT_MAX && next.lastEffortMatch.model.length <= ROUTE_TEXT_MAX)
      }
      state = next
    }
  } finally {
    Date.now = realNow
  }
  assert.equal(reads, 0, 'Date.now was never called')
  assert.deepEqual([...seen].sort(), [...AUDIT_VERDICTS].sort(), 'the random log reaches every verdict')
  assert.ok(state.total > 1_000, `${state.total} requests counted`)
  assert.ok(JSON.stringify(state).length < 10_000, 'the state stays bounded')
  assert.equal(({}).polluted, undefined)
  // Deterministic: the same garbage log folds to the same state.
  Date.now = () => { reads++; throw new Error('the audit fold must not read the clock') }
  try {
    assert.deepEqual(fold(events, start), state)
  } finally {
    Date.now = realNow
  }
  assert.equal(reads, 0)
})

test('the status line lists the observed total and the non-zero verdicts in a fixed order', () => {
  const state = (counts) => ({ ...initAudit(), counts: { ...ZERO, ...counts }, total: Object.values(counts).reduce((sum, count) => sum + count, 0) })
  assert.equal(auditStatusLine(() => state({ effort_mismatch: 1, match: 9, inherit: 2 })),
    'Observed subagent requests while Router was on: 12 (inherit 2, match 9, effort_mismatch 1). Observe only; nothing is blocked.')
  assert.equal(auditStatusLine(() => state(Object.fromEntries(AUDIT_VERDICTS.map((verdict, index) => [verdict, index + 1])))),
    'Observed subagent requests while Router was on: 45 (inherit 1, match 2, retry 3, effort_mismatch 4, effort_omitted 5, unlisted_closed 6, unlisted_open 7, no_shortlist 8, malformed 9). Observe only; nothing is blocked.')
  assert.equal(auditStatusLine(() => state({ malformed: 1 })), 'Observed subagent requests while Router was on: 1 (malformed 1). Observe only; nothing is blocked.')
  assert.equal(auditStatusLine(() => fold(realisticLog())),
    'Observed subagent requests while Router was on: 9 (inherit 1, match 2, retry 1, effort_mismatch 1, effort_omitted 1, unlisted_closed 1, unlisted_open 1, malformed 1). Observe only; nothing is blocked.')
  // Nothing observed, or no audit state: no line.
  for (const [name, read] of [
    ['initial', () => initAudit()], ['undefined', () => undefined], ['null', () => null], ['a route list', () => [OPUS]], ['text', () => 'total'], ['a number', () => 5],
    ['total only', () => ({ total: 3 })], ['total as text', () => ({ ...state({ match: 3 }), total: '3' })], ['negative total', () => ({ total: -1, counts: ZERO })],
    ['fractional total', () => ({ ...state({ match: 1 }), total: 1.5 })], ['counts as a list', () => ({ total: 2, counts: [1, 1] })],
    ['a throwing read', () => { throw new Error('unavailable') }],
    // Whatever the value does while it is read, the line is '' and nothing throws.
    ['a total getter that throws', () => ({ get total() { throw new Error('total') } })],
    ['a counts getter that throws', () => ({ total: 3, get counts() { throw new Error('counts') } })],
    ['a state proxy whose get trap throws', () => new Proxy({}, { get() { throw new Error('get trap') } })],
    ['counts whose own-property trap throws', () => ({ total: 2, counts: new Proxy({ match: 2 }, { getOwnPropertyDescriptor() { throw new Error('descriptor trap') } }) })],
    ['a revoked proxy as counts', () => {
      const { proxy, revoke } = Proxy.revocable({ match: 1 }, {})
      revoke()
      return { total: 1, counts: proxy }
    }],
    ['a count getter that throws', () => ({ total: 1, counts: { get inherit() { throw new Error('count') } } })],
  ]) assert.equal(auditStatusLine(read), '', name)
})

test('audit.js stays observe-only: no clock, file, tool, prompt or Client access', () => {
  const source = readFileSync(new URL('../src/audit.js', import.meta.url), 'utf8')
  assert.deepEqual([...source.matchAll(/^import .* from '([^']+)'$/gm)].map((match) => match[1]), ['zod', './state.js'])
  for (const forbidden of [/Date/, /performance/, /hrtime/, /node:/, /process\./, /require\(/, /import\(/, /\.guard\(/, /systemPrompt/, /\bwire\b/, /inject/]) {
    assert.doesNotMatch(source, forbidden)
  }
})
