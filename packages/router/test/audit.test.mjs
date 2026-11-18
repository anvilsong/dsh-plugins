import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { apply } from '../src/index.host.js'
import {
  attributeLevel, AUDIT_LEVELS, AUDIT_VERDICTS, auditStatusLine, classifyDelegation, foldAudit, initAudit, isAdvisorReservedName, ROUTE_TEXT_MAX,
} from '../src/audit.js'
import { foldRouter, INITIAL_ROUTER_STATE } from '../src/state.js'

const OPUS = { provider: 'anthropic', model: 'claude-opus-5-5' }
const HAIKU = { provider: 'anthropic', model: 'claude-haiku-5-5' }
const FLASH = { provider: 'openrouter', model: '~deepseek/deepseek-flash-latest' }
const GONE = { provider: 'gone', model: 'retired' }
const AUTHORIZED = [OPUS, HAIKU, FLASH]
const label = (route) => `${route.provider}/${route.model}`
const ZERO = Object.freeze(Object.fromEntries(AUDIT_VERDICTS.map((verdict) => [verdict, 0])))
const LEVELS_ZERO = Object.freeze({ mechanical: 0, ordinary: 0, hard: 0, shared: 0 })
// The fields audit v2 adds to the state, as initAudit gives them.
const V2_INITIAL = Object.freeze({ levels: LEVELS_ZERO, reserved: 0, discovery: Object.freeze({ turns: 0, listed: 0 }), listTurn: null, lastRequestTurn: null })
/** The v1 part of a state: what decides and records a verdict. */
const verdictState = ({ counts, total, lastEffortMatch }) => ({ counts, total, lastEffortMatch })

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
  // Requests the audit does not classify leave it in place (v2 only counts the
  // reserved child and records the list call's turn).
  const skipped = fold([
    call({}, { turn: 4, name: 'list_subagent_models' }),
    call(spawn(routed(OPUS, 'xhigh'), { name: 'advisor-verifier-0123456789ab' }), { turn: 4 }),
    call(spawn(routed(OPUS)), { turn: 4, name: 'subagent_fork' }),
    event('tool/result', { turn: 4, step: 1, message: { role: 'tool', content: [] } }),
  ], matched)
  assert.deepEqual(verdictState(skipped), verdictState(matched))
  assert.deepEqual(skipped, { ...matched, reserved: matched.reserved + 1, listTurn: 4 })
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
    // Never classified: only the reserved count moves (audit v2).
    assert.deepEqual(foldAudit(base, call(spawn(unlisted, { name }))), { ...base, reserved: 1 }, name)
    assert.deepEqual(foldAudit(base, call({ name })), { ...base, reserved: 1 }, `${name} without a route`)
  }
  for (const name of ['advisor-verifiers', 'advisor-other-0123456789ab', 'my-advisor-verifier-0123456789ab', 'Advisor-verifier-0123456789ab', 'advisor-', 'worker', 5, null]) {
    assert.equal(isAdvisorReservedName(name), false, String(name))
    assert.equal(verdictOf(base, call(spawn(unlisted, { name }))), 'unlisted_closed', String(name))
  }
  for (const name of ['subagent_fork', 'subagent_codex', 'subagent_claude_code', 'spawn_teammate', 'Subagent', 'subagent ', 'bash', undefined, null]) {
    assert.equal(foldAudit(base, call(spawn(unlisted), { name })), base, String(name))
    assert.equal(foldAudit(base, call(spawn(unlisted, { name: 'advisor-verifier-x' }), { name })), base, `${String(name)}, reserved name`)
  }
  // A list call is no request: it only records its turn for discovery (audit v2).
  assert.deepEqual(foldAudit(base, call(spawn(unlisted), { name: 'list_subagent_models' })), { ...base, listTurn: 1 })
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
    [off, call(spawn(routed(OPUS, 'xhigh'), { name: 'advisor-consult-0123456789ab' }))], // reserved children count only while on
    [off, call(spawn(routed(OPUS, 'xhigh')))],
    [off, call('{')],
    // A list call without a finite turn, or in the turn already recorded.
    [base, call({}, { name: 'list_subagent_models', turn: '1' })],
    [base, call({}, { name: 'list_subagent_models', turn: undefined })],
    [base, call({}, { name: 'list_subagent_models', turn: Number.NaN })],
    [foldAudit(base, call({}, { name: 'list_subagent_models', turn: 3 })), call({}, { name: 'list_subagent_models', turn: 3 })],
    [base, call({}, { name: 'List_subagent_models', turn: 2 })],
    [base, call({}, { name: 'list_subagent_models ', turn: 2 })],
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
  // Hostile list calls.
  for (const value of [
    { type: 'tool/call', data: { name: 'list_subagent_models', get turn() { throw new Error('hostile turn') } } },
    { type: 'tool/call', data: { get name() { throw new Error('hostile name') }, turn: 2 } },
  ]) assert.equal(foldAudit(base, value), base)
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
  // v2: Opus match, retry and omission are Hard's; Haiku is Ordinary's; Flash is on Mechanical and Hard.
  assert.deepEqual(once.levels, { mechanical: 0, ordinary: 1, hard: 3, shared: 1 })
  assert.equal(once.reserved, 1)
  assert.deepEqual(once.discovery, { turns: 2, listed: 1 })
  assert.equal(once.listTurn, 2)
  assert.equal(once.lastRequestTurn, 4)
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

test('the registered unit: routerAudit, stateVersion 2, host-only, its schema embedding the router state schema', async () => {
  const units = await definitions()
  const unit = units.routerAudit
  assert.deepEqual(Object.keys(units), ['router', 'routerModelRoutes', 'routerAudit'])
  assert.equal(unit.key, 'routerAudit')
  // 2: audit v2 (levels, reserved, discovery); the router itself stays at 5.
  assert.equal(unit.stateVersion, 2, 'bump routerAudit stateVersion together with the router stateVersion')
  assert.equal(units.router.stateVersion, 5, 'bump routerAudit stateVersion together with the router stateVersion')
  assert.equal('wire' in unit, false, 'host-only: never sent to the Client')
  assert.equal(unit.apply, foldAudit)
  assert.equal(unit.stateSchema.shape.router, units.router.stateSchema, 'the router part is validated by the router schema itself')
  const initial = unit.init({ id: 'header' }, 0)
  assert.deepEqual(initial, { router: INITIAL_ROUTER_STATE, authorized: null, counts: ZERO, total: 0, lastEffortMatch: null, ...V2_INITIAL })
  const again = unit.init()
  assert.notEqual(again, initial)
  assert.notEqual(again.counts, initial.counts)
  assert.notEqual(again.levels, initial.levels)
  assert.notEqual(again.discovery, initial.discovery)
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
    // v2 fields are required and bounded like the counts.
    ['a negative level count', { ...withMatch, levels: { ...LEVELS_ZERO, hard: -1 } }],
    ['a fractional level count', { ...withMatch, levels: { ...LEVELS_ZERO, shared: 0.5 } }],
    ['a missing shared count', { ...withMatch, levels: { mechanical: 0, ordinary: 0, hard: 1 } }],
    ['levels that are no object', { ...withMatch, levels: [0, 0, 1, 0] }],
    ['a reserved count as text', { ...withMatch, reserved: '1' }],
    ['a negative reserved count', { ...withMatch, reserved: -1 }],
    ['a missing listed count', { ...withMatch, discovery: { turns: 1 } }],
    ['a fractional turns count', { ...withMatch, discovery: { turns: 1.5, listed: 0 } }],
    ['a list turn as text', { ...withMatch, listTurn: '3' }],
    ['an infinite list turn', { ...withMatch, listTurn: Infinity }],
    ['a request turn that is NaN', { ...withMatch, lastRequestTurn: Number.NaN }],
    ...['levels', 'reserved', 'discovery', 'listTurn', 'lastRequestTurn'].map((key) => [`a missing ${key}`, Object.fromEntries(Object.entries(withMatch).filter(([name]) => name !== key))]),
  ]) assert.equal(unit.stateSchema.safeParse(bad).success, false, name)
  // A cached v1 row (the v1 fields only) is no v2 state: the Host discards it and refolds the log.
  const v1Row = JSON.parse(JSON.stringify(verdictState(withMatch)))
  for (const row of [
    { router: withMatch.router, authorized: withMatch.authorized, ...v1Row },
    { router: INITIAL_ROUTER_STATE, authorized: null, counts: ZERO, total: 0, lastEffortMatch: null },
  ]) assert.equal(unit.stateSchema.safeParse(row).success, false, 'a v1-shaped state is rejected')
  const turns = { ...withMatch, listTurn: 2, lastRequestTurn: 1.5 }
  assert.deepEqual(unit.stateSchema.parse(JSON.parse(JSON.stringify(turns))), turns, 'finite turn numbers round-trip')
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
          name: pick(['subagent', 'subagent', 'subagent', 'subagent', 'subagent_fork', 'bash', 'Subagent', undefined, 'list_subagent_models']),
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
  const seenLevels = new Set()
  let listedSteps = 0
  Date.now = () => { reads++; throw new Error('the audit fold must not read the clock') }
  try {
    for (const entry of events) {
      const before = JSON.stringify(state)
      const next = foldAudit(state, entry)
      assert.equal(JSON.stringify(state), before, 'the fold never mutates its input')
      if (next === state) continue
      assert.deepEqual(schema.parse(next), next)
      assert.deepEqual(schema.parse(JSON.parse(JSON.stringify(next))), next, 'a JSON round trip keeps the state')
      assert.equal(next.total, AUDIT_VERDICTS.reduce((sum, verdict) => sum + next.counts[verdict], 0))
      for (const verdict of AUDIT_VERDICTS) if (next.counts[verdict] > state.counts[verdict]) seen.add(verdict)
      if (next.lastEffortMatch !== null) {
        assert.ok(next.lastEffortMatch.provider.length <= ROUTE_TEXT_MAX && next.lastEffortMatch.model.length <= ROUTE_TEXT_MAX)
      }
      // v2: exactly the requests whose route a level shows are attributed, once.
      const shownRoute = (value) => value.counts.match + value.counts.retry + value.counts.effort_mismatch + value.counts.effort_omitted
      assert.equal(AUDIT_LEVELS.reduce((sum, level) => sum + next.levels[level], 0), shownRoute(next))
      for (const level of AUDIT_LEVELS) if (next.levels[level] > state.levels[level]) seenLevels.add(level)
      // A reserved child moves nothing else; a counted request never moves it.
      if (next.reserved !== state.reserved) {
        assert.equal(next.reserved, state.reserved + 1)
        assert.deepEqual({ ...next, reserved: state.reserved }, state)
      }
      assert.ok(next.discovery.listed <= next.discovery.turns)
      assert.ok(next.discovery.turns - state.discovery.turns <= 1 && next.discovery.listed - state.discovery.listed <= 1)
      if (next.discovery.turns > state.discovery.turns) {
        assert.equal(next.total, state.total + 1, 'only a counted request opens a turn')
        assert.ok(Number.isFinite(next.lastRequestTurn) && next.lastRequestTurn !== state.lastRequestTurn)
      }
      if (next.discovery.listed > state.discovery.listed) listedSteps++
      state = next
    }
  } finally {
    Date.now = realNow
  }
  assert.equal(reads, 0, 'Date.now was never called')
  assert.deepEqual([...seen].sort(), [...AUDIT_VERDICTS].sort(), 'the random log reaches every verdict')
  assert.deepEqual([...seenLevels].sort(), [...AUDIT_LEVELS].sort(), 'the random log reaches every level and shared')
  assert.ok(state.reserved > 100, `${state.reserved} reserved children counted`)
  assert.ok(listedSteps > 10 && state.discovery.turns > state.discovery.listed, `${state.discovery.listed} of ${state.discovery.turns} turns listed`)
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
  // The first line is the v1 line, byte for byte; v2 appends its second line after one newline.
  const first = (status) => status.split('\n')[0]
  const ZERO_SECOND = 'Shortlist that ran (route shown by): mechanical 0, ordinary 0, hard 0, shared 0. Advisor-reserved subagent requests: 0. Listed models first in 0 of 0 turns with routed requests.'
  assert.equal(auditStatusLine(() => state({ effort_mismatch: 1, match: 9, inherit: 2 })),
    `Observed subagent requests while Router was on: 12 (inherit 2, match 9, effort_mismatch 1). Observe only; nothing is blocked.\n${ZERO_SECOND}`)
  assert.equal(first(auditStatusLine(() => state(Object.fromEntries(AUDIT_VERDICTS.map((verdict, index) => [verdict, index + 1]))))),
    'Observed subagent requests while Router was on: 45 (inherit 1, match 2, retry 3, effort_mismatch 4, effort_omitted 5, unlisted_closed 6, unlisted_open 7, no_shortlist 8, malformed 9). Observe only; nothing is blocked.')
  assert.equal(first(auditStatusLine(() => state({ malformed: 1 }))), 'Observed subagent requests while Router was on: 1 (malformed 1). Observe only; nothing is blocked.')
  assert.equal(auditStatusLine(() => fold(realisticLog())), [
    'Observed subagent requests while Router was on: 9 (inherit 1, match 2, retry 1, effort_mismatch 1, effort_omitted 1, unlisted_closed 1, unlisted_open 1, malformed 1). Observe only; nothing is blocked.',
    'Shortlist that ran (route shown by): mechanical 0, ordinary 1, hard 3, shared 1. Advisor-reserved subagent requests: 1. Listed models first in 1 of 2 turns with routed requests.',
  ].join('\n'))
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

// ---------------------------------------------------------------------------
// Audit v2: per-level counts by shown route, Advisor-reserved children, discovery.

/** The level an event adds one to, or null when it adds to none. */
function levelOf(state, toolCall) {
  const next = foldAudit(state, toolCall)
  const changed = AUDIT_LEVELS.filter((level) => next.levels[level] !== state.levels[level])
  assert.ok(changed.length <= 1, JSON.stringify(next.levels))
  if (changed.length === 0) return null
  assert.equal(next.levels[changed[0]], state.levels[changed[0]] + 1)
  return changed[0]
}
const list = (turn, data = {}) => call({}, { turn, name: 'list_subagent_models', ...data })
const reservedChild = (turn = 1, name = 'advisor-verifier-0123456789ab') => call(spawn(routed(OPUS, 'xhigh'), { name }), { turn })
function deepFreeze(value) {
  if (typeof value === 'object' && value !== null) {
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}

test('levels: a request is attributed to the one level that shows its route, shared when several do, none when no level does', () => {
  const base = fold(session({ levels: BASE_LEVELS }))
  assert.deepEqual(base.levels, LEVELS_ZERO)
  assert.deepEqual(AUDIT_LEVELS, ['mechanical', 'ordinary', 'hard', 'shared'])
  for (const [args, verdict, level, why] of [
    [spawn(routed(HAIKU)), 'match', 'ordinary', 'one level'],
    [spawn(routed(OPUS, 'xhigh')), 'match', 'hard', 'one level, with its effort'],
    [routed(OPUS, 'xhigh'), 'match', 'hard', 'no name, description or prompt needed'],
    [spawn(routed(OPUS, 'high')), 'effort_mismatch', 'hard', 'the effort is ignored'],
    [spawn(routed(OPUS, 'XHIGH')), 'effort_mismatch', 'hard', 'any effort'],
    [spawn(routed(OPUS)), 'effort_omitted', 'hard', 'an omitted effort is ignored'],
    [spawn(routed(HAIKU, 'low')), 'effort_mismatch', 'ordinary', 'an effort for an entry without one'],
    [spawn(routed(FLASH, 'low')), 'match', 'shared', 'Mechanical shows Flash with effort low, Hard without one'],
    [spawn(routed(FLASH)), 'match', 'shared', 'the same route without an effort'],
    [spawn(routed(FLASH, 'max')), 'effort_mismatch', 'shared', 'shared whatever the effort'],
    [spawn(routed(GONE, 'max')), 'unlisted_closed', null, 'no level shows it: its verdict already counts it'],
    [spawn(routed({ provider: 'Anthropic', model: OPUS.model }, 'xhigh')), 'unlisted_closed', null, 'the provider compares exactly'],
    [spawn(routed({ provider: OPUS.provider, model: `${OPUS.model} ` })), 'unlisted_closed', null, 'the model compares exactly'],
    [spawn(), 'inherit', null, 'inherit names no route'],
    [spawn({}, { agent_preset: 'reviewer' }), 'inherit', null, 'a preset only'],
    [spawn({ ...routed(OPUS), reasoning_effort: 3 }), 'malformed', null, 'a shown route with an effort that is no text'],
    [spawn({ ...routed(OPUS), reasoning_effort: '' }), 'malformed', null, 'a shown route with an empty effort'],
    [spawn({ ...routed(OPUS), reasoning_effort: null }), 'malformed', null, 'a shown route with a null effort'],
    [spawn({ provider: OPUS.provider }), 'malformed', null, 'a provider alone'],
    ['{', 'malformed', null, 'no JSON'],
    [`[${JSON.stringify(routed(OPUS))}]`, 'malformed', null, 'a list'],
  ]) {
    const toolCall = call(args)
    assert.equal(verdictOf(base, toolCall), verdict, why)
    assert.equal(levelOf(base, toolCall), level, why)
  }
  // A retry is attributed like the match before it.
  const matched = foldAudit(base, call(spawn(routed(OPUS, 'xhigh')), { turn: 4 }))
  assert.equal(verdictOf(matched, call(spawn(routed(OPUS)), { turn: 4 })), 'retry')
  assert.equal(levelOf(matched, call(spawn(routed(OPUS)), { turn: 4 })), 'hard')
  // One model in two levels with different efforts is shared, whichever effort the request carries.
  const twice = fold(session({ levels: { mechanical: `${label(OPUS)} effort=low`, hard: `${label(OPUS)} effort=xhigh` } }))
  for (const effort of ['low', 'xhigh', 'high', undefined]) assert.equal(levelOf(twice, call(spawn(routed(OPUS, effort)))), 'shared', String(effort))
  // Three levels showing it are still one shared request.
  const everywhere = fold(session({ levels: { mechanical: label(HAIKU), ordinary: label(HAIKU), hard: label(HAIKU) } }))
  assert.deepEqual(foldAudit(everywhere, call(spawn(routed(HAIKU)))).levels, { ...LEVELS_ZERO, shared: 1 })
})

test('levels: only prompt-visible entries attribute; before the session policy is recorded every saved entry does', () => {
  const levels = { mechanical: `${label(GONE)} effort=low`, ordinary: label(HAIKU), hard: `${label(GONE)},${label(OPUS)} effort=xhigh` }
  const known = fold(session({ levels }))
  // Gone is saved in Mechanical and Hard but not authorized: no level shows it (Mechanical reads Inherit).
  assert.equal(verdictOf(known, call(spawn(routed(GONE, 'low')))), 'unlisted_open')
  assert.equal(levelOf(known, call(spawn(routed(GONE, 'low')))), null, 'an unauthorized saved route is not shown')
  assert.equal(levelOf(known, call(spawn(routed(OPUS, 'xhigh')))), 'hard')
  const unknown = fold(session({ authorized: null, levels }))
  assert.equal(levelOf(unknown, call(spawn(routed(GONE, 'low')))), 'shared', 'authorization not recorded: every saved entry is shown')
  assert.equal(levelOf(fold([policy(AUTHORIZED)], unknown), call(spawn(routed(GONE, 'low')))), null, 'until the policy is recorded')
  // A provider or a model alone is not authorized.
  const BEDROCK_OPUS = { provider: 'bedrock', model: OPUS.model }
  const split = fold(session({ authorized: [OPUS, HAIKU], levels: { mechanical: label(OPUS), hard: `${label(BEDROCK_OPUS)},${label(HAIKU)}` } }))
  assert.equal(levelOf(split, call(spawn(routed(OPUS)))), 'mechanical', 'Bedrock Opus in Hard is another route')
  assert.equal(levelOf(split, call(spawn(routed(BEDROCK_OPUS)))), null)
  assert.equal(levelOf(split, call(spawn(routed(HAIKU)))), 'hard')
  assert.equal(levelOf(fold(session({ authorized: [], levels })), call(spawn(routed(OPUS, 'xhigh')))), null, 'nothing authorized: nothing shown')
})

test('levels: each request is attributed with the shortlists in force at its event', () => {
  const opus = () => call(spawn(routed(OPUS, 'xhigh')))
  let state = fold(session({ levels: { hard: `${label(OPUS)} effort=xhigh` } }))
  assert.equal(levelOf(state, opus()), 'hard')
  const [run, done] = command(`level ordinary ${label(OPUS)}`)
  state = foldAudit(state, run)
  assert.equal(levelOf(state, opus()), 'hard', 'a pending change does not apply yet')
  state = foldAudit(state, done)
  assert.equal(levelOf(state, opus()), 'shared')
  state = fold(command(`level mechanical ${label(OPUS)}`, 'error'), state)
  assert.equal(levelOf(state, opus()), 'shared', 'a rejected change keeps the levels')
  state = fold(command('level hard inherit'), state)
  assert.equal(levelOf(state, opus()), 'ordinary')
  state = fold(command('level ordinary inherit'), state)
  assert.equal(levelOf(state, opus()), null, 'no level shows it any more')
  const log = fold([
    ...session({ levels: { hard: label(OPUS) } }),
    opus(),
    ...command(`level ordinary ${label(OPUS)}`),
    opus(), opus(),
    ...command('level hard inherit'),
    opus(),
    ...command('level ordinary inherit'),
    opus(),
  ])
  assert.deepEqual(log.levels, { mechanical: 0, ordinary: 1, hard: 1, shared: 2 })
  assert.deepEqual(nonZero(log), { effort_mismatch: 4, no_shortlist: 1 })
})

test('attributeLevel: provider and model against the entries each level shows, effort ignored, own properties only', () => {
  const selections = { mechanical: [{ ...FLASH, effort: 'low' }], ordinary: [HAIKU], hard: [{ ...OPUS, effort: 'xhigh' }, FLASH] }
  const context = { selections, authorized: AUTHORIZED }
  assert.equal(attributeLevel(routed(OPUS), context), 'hard')
  assert.equal(attributeLevel(routed(OPUS, 'none of them'), context), 'hard')
  assert.equal(attributeLevel(routed(HAIKU, 'x'), context), 'ordinary')
  assert.equal(attributeLevel(routed(FLASH), context), 'shared')
  assert.equal(attributeLevel(routed(GONE), context), null)
  assert.equal(attributeLevel(routed(OPUS), { selections, authorized: [HAIKU] }), null)
  assert.equal(attributeLevel(routed(OPUS), { selections }), 'hard', 'authorization not recorded: every saved entry')
  for (const args of [undefined, null, 'anthropic/claude-opus-5-5', [OPUS], {}, { provider: OPUS.provider }, { model: OPUS.model }, { provider: '', model: OPUS.model }, { provider: OPUS.provider, model: 5 }]) {
    assert.equal(attributeLevel(args, context), null, JSON.stringify(args))
  }
  for (const bad of [undefined, null, 'all', [], { hard: label(OPUS) }, { hard: [null, 'x', 5] }, Object.create({ hard: [OPUS] })]) {
    assert.equal(attributeLevel(routed(OPUS), { selections: bad, authorized: null }), null, String(bad))
  }
  assert.equal(attributeLevel(routed(OPUS)), null, 'no context')
  assert.equal(attributeLevel(Object.create(routed(OPUS)), context), null, 'an inherited route is not read')
  const frozen = deepFreeze({ selections: structuredClone(selections), authorized: structuredClone(AUTHORIZED) })
  assert.equal(attributeLevel(deepFreeze(routed(FLASH)), frozen), 'shared')
})

test('reserved: Advisor-reserved subagent requests are counted only while Router is on, never classified, attributed or in total', () => {
  let state = fold([policy(AUTHORIZED), ...command(`level hard ${label(OPUS)} effort=xhigh`)])
  assert.equal(state.router.mode, 'off')
  assert.equal(foldAudit(state, reservedChild()), state, 'Router off: not counted')
  const [runOn, doneOn] = command('manual')
  state = foldAudit(state, runOn)
  assert.equal(foldAudit(state, reservedChild()), state, 'a pending switch is not on yet')
  state = foldAudit(state, doneOn)
  for (const name of ['advisor-verifier', 'advisor-planner', 'advisor-consult', 'advisor-planner-', 'advisor-consult-0123456789ab', 'advisor-verifier-typo']) {
    const next = foldAudit(state, reservedChild(1, name))
    assert.deepEqual(next, { ...state, reserved: state.reserved + 1 }, `${name}: only the reserved count moves`)
    state = next
  }
  assert.equal(state.reserved, 6)
  assert.equal(state.total, 0)
  assert.deepEqual(state.counts, ZERO)
  assert.deepEqual(state.levels, LEVELS_ZERO)
  assert.deepEqual(state.discovery, { turns: 0, listed: 0 })
  // Bare names, with any or no route around them.
  for (const args of [{ name: 'advisor-consult' }, { name: 'advisor-verifier', provider: 'anthropic' }, { name: 'advisor-planner', reasoning_effort: 7 }]) {
    assert.deepEqual(foldAudit(state, call(args)), { ...state, reserved: 7 }, JSON.stringify(args))
  }
  // Names that are not reserved are requests like any other.
  for (const name of ['advisor-verifiers', 'advisor-', 'Advisor-verifier-x', 'worker', 5, null]) {
    assert.equal(verdictOf(state, call(spawn(routed(OPUS, 'xhigh'), { name }))), 'match', String(name))
  }
  // Without a JSON object there is no name: malformed, not reserved. An inherited name is not read.
  assert.equal(verdictOf(state, call('{"name":"advisor-verifier-x"')), 'malformed')
  assert.equal(verdictOf(state, call('{"__proto__":{"name":"advisor-verifier-x"}}')), 'inherit')
  // Other delegation tools with a reserved name are not counted at all.
  for (const name of ['subagent_fork', 'subagent_codex', 'subagent_claude_code', 'spawn_teammate', 'Subagent']) {
    assert.equal(foldAudit(state, call(spawn({}, { name: 'advisor-verifier-x' }), { name })), state, name)
  }
  // A reserved child between an effort match and its retry keeps the retry.
  const matched = foldAudit(state, call(spawn(routed(OPUS, 'xhigh')), { turn: 4 }))
  const between = foldAudit(matched, reservedChild(4))
  assert.deepEqual(between, { ...matched, reserved: 7 })
  assert.equal(verdictOf(between, call(spawn(routed(OPUS)), { turn: 4 })), 'retry')
  // After Router is off again nothing more is counted; the count stays.
  const off = fold(command('off'), between)
  assert.equal(foldAudit(off, reservedChild()), off)
  assert.equal(off.reserved, 7)
})

test('discovery: turns with a counted request, and how many of them listed models before their first one', () => {
  const on = fold(session({ levels: { hard: `${label(OPUS)} effort=xhigh` } }))
  const ask = (turn, args = spawn(routed(OPUS, 'xhigh'))) => call(args, { turn })
  for (const [events, expected, why] of [
    [[], { turns: 0, listed: 0 }, 'nothing requested'],
    [[list(1)], { turns: 0, listed: 0 }, 'a list call alone is no turn with a request'],
    [[list(1), ask(1)], { turns: 1, listed: 1 }, 'listed before the first request of the turn'],
    [[ask(1), list(1)], { turns: 1, listed: 0 }, 'listed after the first request'],
    [[ask(1), list(1), ask(1)], { turns: 1, listed: 0 }, 'a later request in the turn does not count the late list call'],
    [[ask(1), ask(1)], { turns: 1, listed: 0 }, 'no list call'],
    [[list(1), ask(2)], { turns: 1, listed: 0 }, 'listed in an earlier turn only'],
    [[list(1), ask(1), ask(2)], { turns: 2, listed: 1 }, 'the next turn needs its own list call'],
    [[list(1), list(1), ask(1)], { turns: 1, listed: 1 }, 'two list calls'],
    [[list(2), list(1), ask(2)], { turns: 1, listed: 0 }, 'the latest list call decides'],
    [[list(1), ask(1), ask(1), ask(1, spawn()), ask(1, '{'), ask(1, spawn(routed(GONE)))], { turns: 1, listed: 1 }, 'several requests in one turn count once, whatever their verdicts'],
    [[list(1), ask(1), ask(2), list(3), ask(3), ask(3), ask(4)], { turns: 4, listed: 2 }, 'every new turn counts again'],
    [[list(0), ask(0)], { turns: 1, listed: 1 }, 'turn 0 is a turn'],
    [[list(4), reservedChild(4)], { turns: 0, listed: 0 }, 'a turn with only an Advisor-reserved request does not count'],
    [[reservedChild(4), ask(4)], { turns: 1, listed: 0 }, 'a reserved child is no first request'],
    [[list(4), reservedChild(4), ask(4)], { turns: 1, listed: 1 }, 'a reserved child before the first counted request'],
    [['4', undefined, null, Number.NaN, Infinity, -Infinity, [4], { turn: 4 }].map((turn) => ask(turn)), { turns: 0, listed: 0 }, 'a request turn that is no finite number is skipped'],
    [[list('1'), ask(1)], { turns: 1, listed: 0 }, 'a list call turn that is no finite number records nothing'],
    [[list(1), list(undefined), list('1'), ask(1)], { turns: 1, listed: 1 }, 'an unnumbered list call keeps the latest numbered one'],
    [[ask(1), ask('2'), ask(1)], { turns: 1, listed: 0 }, 'a skipped turn does not reopen the current one'],
    [[list(1.5), ask(1.5)], { turns: 1, listed: 1 }, 'any finite number is a turn number'],
    [[call({}, { turn: 1, name: 'List_subagent_models' }), call({}, { turn: 1, name: 'list_subagent_models ' }), call({}, { turn: 1, name: 'subagent_fork' }), ask(1)],
      { turns: 1, listed: 0 }, 'only the tool named exactly list_subagent_models'],
    [[call('not even json', { turn: 1, name: 'list_subagent_models' }), ask(1)], { turns: 1, listed: 1 }, 'the arguments of a list call are not read'],
  ]) {
    const state = fold(events, on)
    assert.deepEqual(state.discovery, expected, why)
    assert.ok(state.discovery.listed <= state.discovery.turns, why)
  }
  // Discovery never changes a verdict.
  assert.deepEqual(verdictState(fold([ask(1), list(1), ask(2), list(2), ask(2)], on)), verdictState(fold([ask(1), ask(2), ask(2)], on)))
  // Requests while Router is off open no turn; a list call made while it is off still counts for its turn.
  const off = fold([policy(AUTHORIZED), ...command(`level hard ${label(OPUS)} effort=xhigh`)])
  let state = fold([list(3), ask(3)], off)
  assert.deepEqual(state.discovery, { turns: 0, listed: 0 })
  assert.equal(state.listTurn, 3, 'list calls are recorded whatever the mode')
  assert.equal(state.lastRequestTurn, null)
  state = fold([...command('manual'), ask(3)], state)
  assert.deepEqual(state.discovery, { turns: 1, listed: 1 }, 'the list call made while Router was off counts for its turn')
  state = fold([ask(3), ...command('off'), list(4), ask(4), ...command('on'), ask(4), ask(5)], state)
  assert.deepEqual(state.discovery, { turns: 3, listed: 2 })
  // The bookkeeping keeps turn numbers only; -0 is kept as 0, so a JSON round trip keeps it.
  const kept = fold([list(1), ask(1), list(2)], on)
  assert.equal(kept.listTurn, 2)
  assert.equal(kept.lastRequestTurn, 1)
  const zero = fold([list(-0), ask(-0)], on)
  assert.ok(Object.is(zero.listTurn, 0) && Object.is(zero.lastRequestTurn, 0))
  assert.deepEqual(zero.discovery, { turns: 1, listed: 1 })
})

test('status: a second line with the levels, the reserved count and discovery, joined by one newline', () => {
  const v2 = (fields) => ({ ...initAudit(), ...fields })
  assert.equal(auditStatusLine(() => v2({
    counts: { ...ZERO, match: 3, unlisted_closed: 1 }, total: 4, levels: { mechanical: 1, ordinary: 0, hard: 2, shared: 0 }, reserved: 5, discovery: { turns: 3, listed: 1 },
  })), 'Observed subagent requests while Router was on: 4 (match 3, unlisted_closed 1). Observe only; nothing is blocked.\n'
    + 'Shortlist that ran (route shown by): mechanical 1, ordinary 0, hard 2, shared 0. Advisor-reserved subagent requests: 5. Listed models first in 1 of 3 turns with routed requests.')
  // Only reserved children: the second line alone.
  assert.equal(auditStatusLine(() => v2({ reserved: 2 })),
    'Shortlist that ran (route shown by): mechanical 0, ordinary 0, hard 0, shared 0. Advisor-reserved subagent requests: 2. Listed models first in 0 of 0 turns with routed requests.')
  // From the fold: two lines, the first one the v1 line.
  const lines = auditStatusLine(() => fold(realisticLog())).split('\n')
  assert.deepEqual(lines, [
    'Observed subagent requests while Router was on: 9 (inherit 1, match 2, retry 1, effort_mismatch 1, effort_omitted 1, unlisted_closed 1, unlisted_open 1, malformed 1). Observe only; nothing is blocked.',
    'Shortlist that ran (route shown by): mechanical 0, ordinary 1, hard 3, shared 1. Advisor-reserved subagent requests: 1. Listed models first in 1 of 2 turns with routed requests.',
  ])
  // Nothing observed: no line.
  for (const [name, read] of [
    ['initial', () => initAudit()],
    ['total 0 and reserved 0, other counts set', () => v2({ levels: { ...LEVELS_ZERO, hard: 3 }, discovery: { turns: 2, listed: 1 } })],
    ['only requests while Router was off', () => fold([policy(AUTHORIZED), reservedChild(), call(spawn(routed(OPUS))), list(1)])],
  ]) assert.equal(auditStatusLine(read), '', name)
  // Any problem gives '' and nothing throws, whatever the value does while it is read.
  const good = fold(realisticLog())
  for (const [name, read] of [
    ['a v1-shaped state', () => ({ router: good.router, authorized: good.authorized, ...verdictState(good) })],
    ['levels missing', () => ({ ...good, levels: undefined })],
    ['a level count missing', () => ({ ...good, levels: { mechanical: 0, ordinary: 1, hard: 3 } })],
    ['a level count as text', () => ({ ...good, levels: { ...good.levels, hard: '3' } })],
    ['a negative shared count', () => ({ ...good, levels: { ...good.levels, shared: -1 } })],
    ['an inherited level count', () => ({ ...good, levels: Object.create(good.levels) })],
    ['reserved missing', () => ({ ...good, reserved: undefined })],
    ['reserved as text', () => ({ ...good, reserved: '1' })],
    ['a fractional reserved count', () => ({ ...good, reserved: 0.5 })],
    ['discovery as a list', () => ({ ...good, discovery: [2, 1] })],
    ['a negative listed count', () => ({ ...good, discovery: { turns: 2, listed: -1 } })],
    ['an unsafe turns count', () => ({ ...good, discovery: { turns: 2 ** 53, listed: 1 } })],
    ['a levels getter that throws', () => ({ ...good, get levels() { throw new Error('levels') } })],
    ['a reserved getter that throws', () => ({ ...good, get reserved() { throw new Error('reserved') } })],
    ['a level getter that throws', () => ({ ...good, levels: { ...LEVELS_ZERO, get shared() { throw new Error('shared') } } })],
    ['a discovery proxy whose traps throw', () => ({ ...good, discovery: new Proxy({}, { get() { throw new Error('get') }, getOwnPropertyDescriptor() { throw new Error('descriptor') } }) })],
    ['a revoked proxy as levels', () => {
      const { proxy, revoke } = Proxy.revocable({ ...good.levels }, {})
      revoke()
      return { ...good, levels: proxy }
    }],
  ]) assert.equal(auditStatusLine(read), '', name)
})

/** A 40-event log shaped like the measured session: Hard-heavy routing, a shared route, Advisor critics, discovery in some turns. */
function measuredLog() {
  const ask = (args, turn) => call(args, { turn, step: 1 })
  const critic = (turn, role = 'advisor-verifier') => call(spawn({}, { name: `${role}-0123456789ab` }), { turn })
  const FABLE = { provider: 'anthropic', model: 'claude-fable-5-2' }
  return [
    policy(AUTHORIZED), // 1
    ...command('manual'), // 2-3
    ...command(`level hard ${label(OPUS)} effort=xhigh,${label(FLASH)}`), // 4-5
    ...command(`level ordinary ${label(HAIKU)}`), // 6-7
    ...command(`level mechanical ${label(FLASH)} effort=low`), // 8-9
    list(1), // 10
    ask(spawn(routed(OPUS, 'xhigh')), 1), // 11 match, hard
    ask(spawn(routed(OPUS, 'xhigh')), 1), // 12 match, hard
    critic(1), // 13 reserved
    critic(1), // 14 reserved
    ask(spawn(routed(OPUS, 'high')), 2), // 15 effort_mismatch, hard (no list call in turn 2)
    ask(spawn(routed(OPUS)), 2), // 16 effort_omitted, hard
    ask(spawn(routed(HAIKU)), 2), // 17 match, ordinary
    critic(2, 'advisor-consult'), // 18 reserved
    ask(spawn(routed(OPUS, 'xhigh')), 3), // 19 match, hard
    list(3), // 20 after the turn's first request: turn 3 is not listed
    ask(spawn(routed(FLASH)), 3), // 21 match, shared (Mechanical and Hard)
    ask(spawn(routed(FLASH, 'low')), 3), // 22 match, shared
    list(4), // 23
    ask(spawn(routed(OPUS, 'xhigh')), 4), // 24 match, hard
    event('tool/result', { turn: 4, step: 1, message: { role: 'tool', content: [{ type: 'text', text: 'unsupported reasoning_effort' }], isError: true } }), // 25
    ask(spawn(routed(OPUS)), 4), // 26 retry, hard
    ask(spawn(), 4), // 27 inherit
    critic(4, 'advisor-planner'), // 28 reserved
    critic(5), // 29 reserved: a turn of critics only
    critic(5), // 30 reserved
    list(6), // 31
    ask(spawn(routed(FABLE)), 6), // 32 unlisted_closed
    ask(spawn(routed(OPUS, 'xhigh')), 6), // 33 match, hard
    ask('{"provider":"anthropic"', 6), // 34 malformed
    ...command('off'), // 35-36
    ask(spawn(routed(OPUS, 'xhigh')), 7), // 37 Router off
    critic(7), // 38 Router off
    list(7), // 39
    event('assistant/message', { turn: 7, step: 2, message: { role: 'assistant', content: 'router: hard → anthropic/claude-opus-5-5 because review; effort: xhigh' } }), // 40
  ]
}
const MEASURED = Object.freeze({
  events: 40,
  router: { mode: 'off', selections: { mechanical: [{ ...FLASH, effort: 'low' }], ordinary: [HAIKU], hard: [{ ...OPUS, effort: 'xhigh' }, FLASH] } },
  total: 14,
  counts: { ...ZERO, inherit: 1, match: 8, retry: 1, effort_mismatch: 1, effort_omitted: 1, unlisted_closed: 1, malformed: 1 },
  levels: { mechanical: 0, ordinary: 1, hard: 8, shared: 2 },
  reserved: 6,
  discovery: { turns: 5, listed: 3 },
})
const MEASURED_STATUS = [
  'Observed subagent requests while Router was on: 14 (inherit 1, match 8, retry 1, effort_mismatch 1, effort_omitted 1, unlisted_closed 1, malformed 1). Observe only; nothing is blocked.',
  'Shortlist that ran (route shown by): mechanical 0, ordinary 1, hard 8, shared 2. Advisor-reserved subagent requests: 6. Listed models first in 3 of 5 turns with routed requests.',
].join('\n')
const summary = (state, events) => ({
  events, router: { mode: state.router.mode, selections: state.router.selections }, total: state.total, counts: state.counts, levels: state.levels, reserved: state.reserved, discovery: state.discovery,
})

test('a 40-event log shaped like the measured session folds to exact counts and status lines, deterministically', async () => {
  const { routerAudit } = await definitions()
  const log = measuredLog()
  assert.equal(log.length, 40)
  const once = fold(log, routerAudit.init())
  assert.deepEqual(summary(once, log.length), MEASURED)
  assert.equal(auditStatusLine(() => once), MEASURED_STATUS)
  assert.deepEqual(routerAudit.stateSchema.parse(JSON.parse(JSON.stringify(once))), once)
  // Replay: the same log folds to the same state; a checkpoint plus its suffix equals the full fold.
  assert.deepEqual(fold(log, routerAudit.init()), once)
  for (let cut = 0; cut <= log.length; cut++) {
    const checkpoint = routerAudit.stateSchema.parse(JSON.parse(JSON.stringify(fold(log.slice(0, cut), routerAudit.init()))))
    assert.deepEqual(fold(log.slice(cut), checkpoint), once, `cut ${cut}`)
  }
  // Deep-frozen events and state fold to the same result: nothing is written to the inputs
  // (a write would throw, and the fold would return the state it was given).
  const realNow = Date.now
  Date.now = () => { throw new Error('the audit fold must not read the clock') }
  let frozen
  try {
    frozen = deepFreeze(log).reduce(foldAudit, deepFreeze(routerAudit.init()))
  } finally {
    Date.now = realNow
  }
  assert.deepEqual(frozen, once)
})

const SCRIPT = fileURLToPath(new URL('../scripts/audit-replay.mjs', import.meta.url))
/** Run the replay script in an empty temp directory, with a temp HOME, and the given stdin. */
function replay(input) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'router-audit-replay-'))
  try {
    const result = spawnSync(process.execPath, [SCRIPT], { input, cwd, encoding: 'utf8', env: { HOME: cwd }, timeout: 60_000 })
    assert.deepEqual(readdirSync(cwd), [], 'the script writes no file')
    return result
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}
const jsonl = (events) => events.map((entry) => JSON.stringify(entry)).join('\n')
const EMPTY_SUMMARY = Object.freeze({
  events: 0, router: { mode: 'off', selections: { mechanical: null, ordinary: null, hard: null } }, total: 0, counts: ZERO, levels: LEVELS_ZERO, reserved: 0, discovery: { turns: 0, listed: 0 },
})

test('scripts/audit-replay.mjs folds a JSONL session log from stdin into one JSON object on stdout', () => {
  const log = measuredLog()
  const result = replay(`${jsonl(log)}\n`)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.ok(result.stdout.endsWith('}\n'))
  assert.equal(result.stdout.slice(0, -1).includes('\n'), false, 'one line, one object')
  const printed = JSON.parse(result.stdout)
  assert.deepEqual(printed, MEASURED)
  assert.deepEqual(Object.keys(printed), ['events', 'router', 'total', 'counts', 'levels', 'reserved', 'discovery'])
  assert.deepEqual(Object.keys(printed.router), ['mode', 'selections'])
  assert.deepEqual(printed, summary(fold(log), log.length), 'exactly the fold')
  // Lines that are no JSON are skipped; JSON that is no event is folded and changes nothing; CRLF and no final newline are fine.
  const garbage = ['', 'not json', '{', '[1,2', '   ', '\u0000', '{"type":"tool/call","data":']
  const noise = ['42', 'null', '"tool/call"', '[]', '{}', '{"type":"tool/call"}', '{"type":"tool/call","data":{"name":"bash","turn":2}}']
  const lines = jsonl(log).split('\n')
  const mixed = replay([...garbage, ...lines.slice(0, 20), ...noise, ...garbage, ...lines.slice(20)].join('\r\n'))
  assert.equal(mixed.status, 0, mixed.stderr)
  assert.deepEqual(JSON.parse(mixed.stdout), { ...MEASURED, events: 40 + noise.length })
  // Empty stdin, or nothing but garbage: the initial state and its event count.
  for (const [input, events] of [['', 0], ['\n\n', 0], ['nothing\n{\n', 0], ['null\n', 1]]) {
    const empty = replay(input)
    assert.equal(empty.status, 0, empty.stderr)
    assert.deepEqual(JSON.parse(empty.stdout), { ...EMPTY_SUMMARY, events }, JSON.stringify(input))
  }
})

test('scripts/audit-replay.mjs ignores a leading byte-order mark and a closed output pipe', () => {
  const log = measuredLog()
  const withBom = replay(`\ufeff${jsonl(log)}\n`)
  assert.equal(withBom.status, 0, withBom.stderr)
  assert.deepEqual(JSON.parse(withBom.stdout), MEASURED, 'the first line is not lost to the mark')
  // A mark that is not at the very start is still no JSON: that line stays skipped.
  const inside = replay([jsonl(log.slice(0, 5)), `\ufeff${JSON.stringify(log[5])}`, jsonl(log.slice(6))].join('\n'))
  assert.equal(inside.status, 0, inside.stderr)
  assert.equal(JSON.parse(inside.stdout).events, 40 - 1, 'only the first line may carry a mark')
  // A closed stdout ends the run with status 0 and no stack trace.
  const cwd = mkdtempSync(path.join(tmpdir(), 'router-audit-replay-'))
  try {
    const closed = spawnSync('sh', ['-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(SCRIPT)} | true`], { input: `${jsonl(log)}\n`, cwd, encoding: 'utf8', env: { HOME: cwd }, timeout: 60_000 })
    assert.equal(closed.status, 0, closed.stderr)
    assert.doesNotMatch(closed.stderr, /Error|EPIPE|at /)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('scripts/audit-replay.mjs reads stdin only (no file, network, clock or environment access) and is not published', () => {
  const source = readFileSync(new URL('../scripts/audit-replay.mjs', import.meta.url), 'utf8')
  assert.deepEqual([...source.matchAll(/^import .* from '([^']+)'$/gm)].map((match) => match[1]), ['node:readline', '../src/audit.js'])
  for (const forbidden of [/Date/, /performance/, /hrtime/, /node:fs/, /node:net/, /node:http/, /node:child_process/, /fetch\(/, /process\.env/, /process\.argv/, /require\(/, /import\(/, /setTimeout|setInterval/]) {
    assert.doesNotMatch(source, forbidden)
  }
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(Array.isArray(manifest.files))
  assert.equal(manifest.files.some((entry) => entry.replace(/^\.\//, '').startsWith('scripts')), false, 'a development tool: not in the published files')
})

test('mutation checks: each audit v2 rule is caught on a temp copy of the source', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'router-audit-mutants-'))
  try {
    const zodUrl = import.meta.resolve('zod')
    const urlOf = (file) => new URL(`../src/${file}`, import.meta.url).href
    const sources = { 'audit.js': readFileSync(new URL('../src/audit.js', import.meta.url), 'utf8'), 'index.host.js': readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8') }
    let serialFile = 0
    // A copy imports zod, state.js and (for the host) audit.js from the checkout by URL.
    const load = (file, source) => {
      const target = path.join(dir, `${serialFile++}-${file.replace(/\.js$/, '.mjs')}`)
      writeFileSync(target, source
        .replaceAll("from 'zod'", `from '${zodUrl}'`)
        .replaceAll("from './state.js'", `from '${urlOf('state.js')}'`)
        .replaceAll("from './audit.js'", `from '${urlOf('audit.js')}'`))
      return import(pathToFileURL(target).href)
    }
    const run = (m, events) => events.reduce(m.foldAudit, m.initAudit())
    const ask = (turn, args = spawn(routed(OPUS, 'xhigh'))) => call(args, { turn })
    const on = () => session({ levels: BASE_LEVELS })
    const { router } = await definitions()
    const probes = {
      attribution: (m) => isDeepStrictEqual(run(m, [...on(), call(spawn(routed(HAIKU))), call(spawn({ ...routed(OPUS), reasoning_effort: 3 })), call(spawn(routed(GONE)))]).levels, { ...LEVELS_ZERO, ordinary: 1 }),
      // In the fold an unshown route never gets a shown-route verdict, so this rule is probed on attributeLevel itself.
      visibility: (m) => m.attributeLevel(routed(GONE), { selections: { mechanical: [GONE], ordinary: null, hard: [OPUS] }, authorized: AUTHORIZED }) === null
        && run(m, [...session({ levels: { mechanical: label(GONE), hard: label(OPUS) } }), call(spawn(routed(GONE)))]).levels.mechanical === 0,
      shared: (m) => isDeepStrictEqual(run(m, [...on(), call(spawn(routed(FLASH)))]).levels, { ...LEVELS_ZERO, shared: 1 }),
      reservedWindow: (m) => run(m, [policy(AUTHORIZED), reservedChild()]).reserved === 0 && run(m, [...on(), reservedChild()]).reserved === 1,
      reservedNotTotal: (m) => run(m, [...on(), reservedChild()]).total === 0,
      turnCounting: (m) => run(m, [...on(), list(1), ask(1), ask(1), ask(2)]).discovery.turns === 2,
      listBefore: (m) => run(m, [...on(), ask(1), list(1), ask(1)]).discovery.listed === 0 && run(m, [...on(), list(1), ask(1)]).discovery.listed === 1,
      listEarlierTurn: (m) => run(m, [...on(), list(1), ask(2)]).discovery.listed === 0,
      skipBadRequestTurn: (m) => run(m, [...on(), ask('4'), ask(null)]).discovery.turns === 0,
      skipBadListTurn: (m) => run(m, [...on(), list(1), list('x'), ask(1)]).discovery.listed === 1,
      statusJoin: (m) => m.auditStatusLine(() => run(m, measuredLog())) === MEASURED_STATUS,
      statusReservedOnly: (m) => m.auditStatusLine(() => ({ ...m.initAudit(), reserved: 2 })).startsWith('Shortlist that ran (route shown by): '),
      requiredFields: (m) => !m.auditStateSchema(router.stateSchema).safeParse((({ discovery, ...rest }) => rest)(m.initAudit())).success, // eslint-disable-line no-unused-vars
      versionBump: async (m) => {
        const units = {}
        await m.apply({ sessionProjections: { async register(unit) { units[unit.key] = unit; return { stateOf: () => undefined } } }, systemPrompt: { getSectionOrder: () => 500, section() {} }, inject() {} })
        return units.routerAudit.stateVersion === 2 && units.router.stateVersion === 5
      },
    }
    const mutations = [
      ['attribution', 'audit.js', [['SHOWN_ROUTE.has(result.verdict) ?', "result.verdict !== 'inherit' ?"]]],
      ['visibility', 'audit.js', [['shownLevels(selections, authorized).flatMap(', 'shownLevels(selections, null).flatMap(']]],
      ['shared', 'audit.js', [["showing.length === 1 ? showing[0] : 'shared'", 'showing[0]']]],
      ['reservedWindow', 'audit.js', [
        ["if (name !== 'subagent' || state.router.mode !== 'manual') return state", "if (name !== 'subagent') return state"],
        ['const result = classifyDelegation(args, {', "if (state.router.mode !== 'manual') return state\n  const result = classifyDelegation(args, {"],
      ]],
      ['reservedNotTotal', 'audit.js', [['return { ...state, reserved: state.reserved + 1 }', 'return { ...state, reserved: state.reserved + 1, total: state.total + 1 }']]],
      ['turnCounting', 'audit.js', [['|| turn === state.lastRequestTurn)', '|| false)']]],
      ['listBefore', 'audit.js', [['return { ...state, listTurn: plainTurn(turn) }',
        'return { ...state, listTurn: plainTurn(turn), discovery: turn === state.lastRequestTurn ? { ...state.discovery, listed: state.discovery.listed + 1 } : state.discovery }']]],
      ['listEarlierTurn', 'audit.js', [['listed: state.listTurn === turn ? listed + 1 : listed', 'listed: state.listTurn !== null ? listed + 1 : listed']]],
      ['skipBadRequestTurn', 'audit.js', [['!Number.isFinite(turn) || turn === state.lastRequestTurn', 'turn === undefined || turn === state.lastRequestTurn']]],
      ['skipBadListTurn', 'audit.js', [['!Number.isFinite(turn) || turn === state.listTurn', 'turn === undefined || turn === state.listTurn']]],
      ['statusJoin', 'audit.js', [["return lines.join('\\n')", "return lines.join('\\n\\n')"]]],
      ['statusReservedOnly', 'audit.js', [['if (total > 0 || reserved > 0)', 'if (total > 0)']]],
      ['requiredFields', 'audit.js', [['discovery: z.object({ turns: count, listed: count }),', 'discovery: z.object({ turns: count, listed: count }).optional(),']]],
      ['versionBump', 'index.host.js', [["key: 'routerAudit',\n      stateVersion: 2,", "key: 'routerAudit',\n      stateVersion: 1,"]]],
    ]
    assert.deepEqual(mutations.map(([name]) => name).sort(), Object.keys(probes).sort(), 'one mutation per probe')
    const holds = async (probe, m) => {
      try {
        return (await probe(m)) === true
      } catch {
        return false
      }
    }
    // The unmutated copies pass every probe, so a failing mutant fails for its mutation alone.
    const pristine = { 'audit.js': await load('audit.js', sources['audit.js']), 'index.host.js': await load('index.host.js', sources['index.host.js']) }
    for (const [name, file] of mutations) assert.equal(await holds(probes[name], pristine[file]), true, `${name}: the unmutated copy passes`)
    for (const [name, file, edits] of mutations) {
      let source = sources[file]
      for (const [find, replace] of edits) {
        assert.equal(source.split(find).length, 2, `${name}: ${JSON.stringify(find)} occurs exactly once in ${file}`)
        source = source.replace(find, () => replace)
      }
      assert.equal(await holds(probes[name], await load(file, source)), false, `${name}: the mutant is caught`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
