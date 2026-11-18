// Prune flow and Trash tab tests for dsh-plugin-sessions (T13): the three
// prune steps on a Host plan (scope, preview, confirm), plan-token handling,
// the result card with Undo, the Trash list with Restore batch and the typed,
// twice-confirmed permanent delete, the in-page dialogs (role, label, focus
// moves in and is trapped, Escape and Cancel, focus return, inert background),
// mutation progress and refetch, error texts, and the rule that apply, restore
// and purge run only from a click. The client runs in the vm harness
// (test/helpers/client-harness.mjs, with fake DOM nodes and focus tracking);
// nothing here touches the real DSH home or session store.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  APPLY_STATES, BATCH_ID_PATTERN, BATCH_STATES, ERROR_CODES, METHOD_NAMES, METHODS, NAMESPACE, PLAN_SCOPES, WARNING_CODES,
  assertApplyResult, assertPlan, assertPurgeResult, assertRequest, assertTrashList,
} from '../src/contract.js'
import { applyResultFixture, archivedPageFixture, overviewFixture, planFixture, purgeResultFixture, trashListFixture } from './helpers/fixtures.mjs'
import { CLIENT_SOURCE, NOW, byRole, createApi, createLocale, event, loadClient, plain, settle, textOf } from './helpers/client-harness.mjs'

const MB = 1024 * 1024
const DAY = 86_400_000
const MUTATING = METHOD_NAMES.filter((name) => METHODS[name].mutates)

// Every rejection that nobody handled, in this process (the vm realm shares it).
const unhandled = []
process.on('unhandledRejection', (reason) => { unhandled.push(reason) })

// ---------------------------------------------------------------------------
// Fixtures and helpers.
// ---------------------------------------------------------------------------

const ok = (value) => ({ ok: true, value })
const fail = (code, message = 'host detail') => ({ ok: false, error: { code, message } })

/** A plan that passes assertPlan: totals and byWorkspace are derived from the units. */
function makePlan(units, planId = 'plan-1') {
  const ready = units.filter((unit) => unit.status === 'ready')
  const sum = (list, pick) => list.reduce((n, unit) => n + pick(unit), 0)
  const byWorkspace = []
  for (const unit of ready) {
    let entry = byWorkspace.find((item) => item.workspaceId === unit.workspaceId)
    if (!entry) { entry = { workspaceId: unit.workspaceId, units: 0, sessions: 0, bytes: 0 }; byWorkspace.push(entry) }
    entry.units += 1
    entry.sessions += unit.memberIds.length
    entry.bytes += unit.bytes
  }
  const value = {
    planId,
    expiresAt: NOW + 10 * 60_000,
    digest: `digest-${planId}`,
    units,
    totals: {
      units: units.length, ready: ready.length, blocked: units.length - ready.length,
      sessions: sum(units, (unit) => unit.memberIds.length), readySessions: sum(ready, (unit) => unit.memberIds.length),
      bytes: sum(units, (unit) => unit.bytes), readyBytes: sum(ready, (unit) => unit.bytes),
    },
    byWorkspace,
  }
  assertPlan(value)
  return value
}
const unit = (rootId, members, bytes, workspaceId, reasons = []) => ({
  rootId, memberIds: [rootId, ...members], bytes, workspaceId, status: reasons.length > 0 ? 'blocked' : 'ready', reasons,
})
/** Two ready units (4 sessions, 6 MB) and three blocked ones (two by recent, one by live and locked). */
const RICH_UNITS = [
  unit('s0001', ['s0002', 's0003'], 4 * MB, 'ws-alpha'),
  unit('s0010', [], 2 * MB, 'ws-beta'),
  unit('s0020', ['s0021'], 6 * MB, null, [{ code: 'recent', sessionId: 's0021' }]),
  unit('s0030', [], MB, 'ws-alpha', [{ code: 'recent', sessionId: 's0030' }]),
  unit('s0040', ['s0041', 's0042'], 3 * MB, 'ws-alpha', [{ code: 'live', sessionId: 's0041' }, { code: 'locked', sessionId: 's0042' }, { code: 'live', sessionId: 's0042' }]),
]
const richPlan = (planId = 'plan-1') => makePlan(RICH_UNITS.map((entry) => ({ ...entry, memberIds: [...entry.memberIds], reasons: [...entry.reasons] })), planId)

const applyResult = (extra = {}) => {
  const value = { ...applyResultFixture(), ...extra }
  assertApplyResult(value)
  return value
}
const restoreResult = (extra = {}) => applyResult({ skipped: [], warnings: [], moved: { units: 2, sessions: 4, bytes: 6 * MB }, ...extra })
const trashOf = (batches, extra = {}) => {
  const value = { trashDir: '/fake/state/sessions-manager/trash', batches, ...extra }
  assertTrashList(value)
  return value
}
const batch = (batchId, extra = {}) => ({ batchId, createdAt: NOW - DAY, units: 1, sessions: 2, bytes: 3 * MB, state: 'complete', ...extra })

function findAllIn(node, predicate, found = []) {
  if (Array.isArray(node)) { node.forEach((child) => findAllIn(child, predicate, found)); return found }
  if (node === null || typeof node !== 'object') return found
  if (predicate(node)) found.push(node)
  for (const child of node.children ?? []) findAllIn(child, predicate, found)
  return found
}
const buttonIn = (node, text) => findAllIn(node, (n) => n.type === 'button' && textOf(n) === text)[0]
const byId = (node, id) => findAllIn(node, (n) => n.props?.id === id)[0]
const callsOf = (env, method) => env.calls.filter((call) => call.method === method)
const mutatingCalls = (env) => env.calls.filter((call) => MUTATING.includes(call.method))
const tabs = (root) => byRole(root, 'tab')
const tabpanel = (root) => byRole(root, 'tabpanel')[0]
const pruneDialog = (root) => root.find((node) => node.props?.role === 'dialog' && node.props['data-dialog'] === 'prune')
const purgeDialog = (root) => root.find((node) => node.props?.role === 'dialog' && node.props['data-dialog'] === 'purge')
const radios = (root) => findAllIn(pruneDialog(root), (n) => n.type === 'input' && n.props.type === 'radio')
const radio = (root, value) => radios(root).find((n) => n.props.value === value)
const statusOf = (root, id) => byId(root.tree, id)
const batchRow = (root, id) => root.find((node) => node.props?.role === 'row' && node.props['data-batch'] === id)
const archivedRow = (root, id) => root.find((node) => node.props?.role === 'row' && node.props['data-id'] === id)

/** Press a button the way a browser does: the event names it as currentTarget. */
async function press(root, node, extra = {}) {
  assert.ok(node, 'a button to press')
  node.props.onClick(event({ currentTarget: root.nodeOf(node), ...extra }))
  await settle()
}
const type = async (root, id, value) => { byId(root.tree, id).props.onChange(event({ target: { value } })); await settle() }
const tick = async (root, id, checked = true) => { byId(root.tree, id).props.onChange(event({ target: { checked } })); await settle() }
const pick = async (root, value) => { radio(root, value).props.onChange(event({ target: { value, checked: true } })); await settle() }
const key = async (node, name, extra = {}) => { const e = event({ key: name, ...extra }); node.props.onKeyDown(e); await settle(); return e }

/** Load the client, render the page on the Overview tab. */
async function openPage(options = {}) {
  const env = loadClient({ locale: createLocale(), ...options })
  await settle()
  const root = env.renderPage()
  await settle()
  return { env, root }
}
/** Open the prune panel from the Reclaimable card. */
async function openFromCard(root) {
  await press(root, buttonIn(root.tree, 'Review prune…'))
  assert.ok(pruneDialog(root), 'the prune panel is open')
}
/** Open the Archived tab and let its list load. */
async function showArchived(env, root) {
  await press(root, tabs(root)[1])
  await env.advance(0)
}
/** Open the Trash tab and let its list load. */
async function showTrash(env, root) {
  await press(root, tabs(root)[2])
  await env.advance(0)
}
/** Scope -> Preview -> Continue: the confirm step of the current plan. */
async function toConfirm(root) {
  await press(root, buttonIn(pruneDialog(root), 'Preview'))
  await press(root, buttonIn(pruneDialog(root), 'Continue'))
}
const moveButton = (root) => buttonIn(pruneDialog(root), 'Move to trash')
async function confirmWith(root, count, checked = true) {
  if (checked) await tick(root, 'sm-prune-check')
  await type(root, 'sm-prune-count', String(count))
}
const validCalls = (env) => { for (const call of env.calls) assertRequest(call.method, call.request) }

// ---------------------------------------------------------------------------
// 1. The three steps.
// ---------------------------------------------------------------------------

test('the panel opens on the scope step: all archived is the default; older than N days and the current selection are offered; opening calls nothing', async () => {
  const { env, root } = await openPage({ api: createApi({ plan: async () => ok(richPlan()) }) })
  await openFromCard(root)
  const dialog = pruneDialog(root)
  assert.match(textOf(byId(dialog, dialog.props['aria-labelledby'])), /^Prune archived sessions$/)
  assert.match(textOf(dialog), /Step 1 of 3: Scope/)
  assert.deepEqual(radios(root).map((n) => [n.props.value, n.props.checked]), [['all', true], ['olderThan', false], ['selection', false]])
  assert.match(textOf(dialog), /All archived sessions/)
  assert.match(textOf(dialog), /80 archived roots with their children/)
  assert.equal(radio(root, 'selection').props.disabled, true, 'no selection yet')
  assert.match(textOf(dialog), /Select sessions in the Archived tab first/)
  assert.match(textOf(dialog), /Nothing was moved yet/)
  assert.equal(buttonIn(dialog, 'Move to trash'), undefined, 'no move before the last step')
  assert.deepEqual(env.calls.map((call) => call.method), ['overview'], 'opening the panel calls nothing')

  // From an Archived row: the selection scope with exactly that root.
  const archived = await openPage()
  await showArchived(archived.env, archived.root)
  await press(archived.root, buttonIn(archivedRow(archived.root, 's0001'), 'Prune…'))
  assert.equal(radio(archived.root, 'selection').props.checked, true)
  assert.match(textOf(pruneDialog(archived.root)), /1 archived session selected/)
  assert.deepEqual(mutatingCalls(archived.env), [])
  assert.deepEqual(callsOf(archived.env, 'plan'), [])
})

test('Preview sends plan(request) for each scope; invalid days are marked and not sent', async () => {
  const { env, root } = await openPage({ api: createApi({ plan: async () => ok(richPlan()) }) })
  await showArchived(env, root)
  await press(root, buttonIn(archivedRow(root, 's0004'), 'Prune…'))
  await press(root, buttonIn(pruneDialog(root), 'Preview'))
  assert.deepEqual(callsOf(env, 'plan').at(-1).request, { scope: 'selection', rootIds: ['s0004'] })
  await press(root, buttonIn(pruneDialog(root), 'Back'))

  await pick(root, 'all')
  await press(root, buttonIn(pruneDialog(root), 'Preview'))
  assert.deepEqual(callsOf(env, 'plan').at(-1).request, { scope: 'all' })
  await press(root, buttonIn(pruneDialog(root), 'Back'))

  await pick(root, 'olderThan')
  assert.equal(byId(pruneDialog(root), 'sm-prune-days').props.value, '30', 'a default age')
  await type(root, 'sm-prune-days', '45')
  await press(root, buttonIn(pruneDialog(root), 'Preview'))
  assert.deepEqual(callsOf(env, 'plan').at(-1).request, { scope: 'olderThan', olderThanDays: 45 })
  await press(root, buttonIn(pruneDialog(root), 'Back'))

  for (const bad of ['-1', '2.5', 'abc', '']) {
    await type(root, 'sm-prune-days', bad)
    assert.equal(byId(pruneDialog(root), 'sm-prune-days').props['aria-invalid'], true, bad)
    assert.match(textOf(pruneDialog(root)), /Enter a whole number of days, 0 or more/)
    assert.equal(buttonIn(pruneDialog(root), 'Preview').props.disabled, true)
  }
  assert.equal(callsOf(env, 'plan').length, 3)
  validCalls(env)
  assert.deepEqual(mutatingCalls(env), [])
})

test('the preview shows roots, descendants, total size, a per-workspace breakdown, checks by reason with counts, and blocked units as excluded', async () => {
  const { root } = await openPage({ api: createApi({ plan: async () => ok(richPlan()) }) })
  await openFromCard(root)
  await press(root, buttonIn(pruneDialog(root), 'Preview'))
  const dialog = pruneDialog(root)
  assert.match(textOf(dialog), /Step 2 of 3: Preview/)
  const facts = Object.fromEntries(findAllIn(byId(dialog, 'sm-prune-summary'), (n) => n.type === 'div' && n.children.length === 2 && n.children[0].type === 'dt')
    .map((n) => [textOf(n.children[0]), textOf(n.children[1])]))
  assert.deepEqual(facts, { Roots: '2', Descendants: '2', Sessions: '4', 'Total size': '6 MB' })
  assert.match(textOf(dialog), /Excluded as blocked: 3 units with 6 sessions \(10 MB\)\./)

  const wsRows = findAllIn(byId(dialog, 'sm-prune-ws'), (n) => n.props?.role === 'row').slice(1).map(textOf)
  assert.deepEqual(wsRows, ['alpha134 MB', 'ws-beta112 MB'], 'workspace, units, sessions, size; an unknown workspace shows its id')

  const checks = findAllIn(byId(dialog, 'sm-prune-checks'), (n) => n.type === 'li').map((n) => [n.props['data-code'], textOf(n)])
  assert.deepEqual(checks, [
    ['recent', 'A session in this tree was active recently.2 units'],
    ['live', 'A session in this tree is open in the running app. Close it, or restart the host, then try again.1 unit'],
    ['locked', 'A session folder is locked by a running process, usually the host holding that session open.1 unit'],
  ])

  const excluded = findAllIn(byId(dialog, 'sm-prune-excluded'), (n) => n.type === 'li' && n.props['data-root'])
  assert.deepEqual(excluded.map((n) => n.props['data-root']), ['s0020', 's0030', 's0040'])
  assert.match(textOf(byId(dialog, 'sm-prune-excluded')), /^Excluded \(3\)/)
  const last = textOf(excluded[2])
  assert.match(last, /s0040.*alpha.*3 sessions · 3 MB/)
  assert.match(last, /A session in this tree is open in the running app\. Close it, or restart the host, then try again\. \(s0041, s0042\)/)
  assert.match(last, /A session folder is locked by a running process, usually the host holding that session open\. \(s0042\)/)
  assert.match(textOf(excluded[0]), /Unassigned/)
  assert.equal(buttonIn(dialog, 'Continue').props.disabled, undefined)

  // A plan with every unit blocked, and an empty plan: nothing to continue with.
  for (const [units, text] of [
    [[unit('s0020', [], MB, null, [{ code: 'cycle', sessionId: 's0020' }])], /Every unit in this scope is blocked\. Nothing can be moved\./],
    [[], /No archived session is in this scope\./],
  ]) {
    const next = await openPage({ api: createApi({ plan: async () => ok(makePlan(units)) }) })
    await openFromCard(next.root)
    await press(next.root, buttonIn(pruneDialog(next.root), 'Preview'))
    assert.match(textOf(pruneDialog(next.root)), text)
    assert.equal(buttonIn(pruneDialog(next.root), 'Continue').props.disabled, true)
  }
})

test('confirm: only the ticked box together with the typed session count of the plan enables Move to trash', async () => {
  const { env, root } = await openPage({ api: createApi({ plan: async () => ok(richPlan()) }) })
  await openFromCard(root)
  await toConfirm(root)
  const dialog = () => pruneDialog(root)
  assert.match(textOf(dialog()), /Step 3 of 3: Confirm/)
  assert.match(textOf(dialog()), /4 sessions \(6 MB\) move to the trash: 2 roots and 2 descendants\. You can restore them from the Trash tab\./)
  assert.match(textOf(byId(dialog(), 'sm-prune-count-label')), /Type the number of sessions, 4, to confirm/)
  assert.doesNotMatch(textOf(moveButton(root)), /delete/i, 'the button says trash, never delete')
  assert.equal(moveButton(root).props.disabled, true)

  await tick(root, 'sm-prune-check')
  assert.equal(moveButton(root).props.disabled, true, 'the box alone is not enough')
  for (const wrong of ['3', '6', '04x', ' ', '4.0', '-4']) {
    await type(root, 'sm-prune-count', wrong)
    assert.equal(moveButton(root).props.disabled, true, `typed ${JSON.stringify(wrong)}`)
  }
  await type(root, 'sm-prune-count', '6')
  assert.match(textOf(dialog()), /The number must be 4\./)
  await press(root, moveButton(root))
  await tick(root, 'sm-prune-check', false)
  await type(root, 'sm-prune-count', '4')
  await press(root, moveButton(root))
  assert.deepEqual(callsOf(env, 'apply'), [], 'a press on the disabled button sends nothing')
  await tick(root, 'sm-prune-check', true)
  await type(root, 'sm-prune-count', ' 4 ')
  assert.equal(moveButton(root).props.disabled, undefined, 'box and count')
  await tick(root, 'sm-prune-check', false)
  assert.equal(moveButton(root).props.disabled, true, 'the count alone is not enough')
  await tick(root, 'sm-prune-check', true)
  assert.equal(moveButton(root).props.disabled, undefined)
  assert.deepEqual(mutatingCalls(env), [], 'nothing moves before the click')
})

// ---------------------------------------------------------------------------
// 2. Plan tokens.
// ---------------------------------------------------------------------------

test('apply carries only the planId of the latest plan response and the typed count; a late older plan is ignored; a double click is one call', async () => {
  const pending = []
  let n = 0
  const api = createApi({
    plan: () => new Promise((resolve) => { const id = `plan-${++n}`; pending.push({ id, release: () => resolve(ok(richPlan(id))) }) }),
    apply: () => new Promise(() => {}),
  })
  const { env, root } = await openPage({ api })
  await openFromCard(root)
  await press(root, buttonIn(pruneDialog(root), 'Preview'))
  assert.match(statusOf(root, 'sm-prune-status').children.join(''), /Making a plan… Nothing moves\./)
  // The scope changes while plan-1 is in flight; plan-2 is asked for and answers first.
  await pick(root, 'olderThan')
  await press(root, buttonIn(pruneDialog(root), 'Preview'))
  assert.deepEqual(callsOf(env, 'plan').map((call) => call.request), [{ scope: 'all' }, { scope: 'olderThan', olderThanDays: 30 }])
  pending[1].release()
  await settle()
  pending[0].release()
  await settle()
  assert.match(textOf(pruneDialog(root)), /Step 2 of 3: Preview/)

  // Back and Preview again with the same scope: plan-3 is the latest.
  await press(root, buttonIn(pruneDialog(root), 'Back'))
  await press(root, buttonIn(pruneDialog(root), 'Preview'))
  pending[2].release()
  await settle()
  // Two requests for the same scope in flight (the scope changed and changed back): the older answer still loses.
  await press(root, buttonIn(pruneDialog(root), 'Back'))
  await press(root, buttonIn(pruneDialog(root), 'Preview'))
  await pick(root, 'all')
  await pick(root, 'olderThan')
  await press(root, buttonIn(pruneDialog(root), 'Preview'))
  assert.equal(callsOf(env, 'plan').length, 5)
  pending[4].release()
  await settle()
  pending[3].release()
  await settle()
  await press(root, buttonIn(pruneDialog(root), 'Continue'))
  await confirmWith(root, 4)
  const move = moveButton(root)
  move.props.onClick(event({ currentTarget: root.nodeOf(move) }))
  move.props.onClick(event({ currentTarget: root.nodeOf(move) }))
  await settle()
  moveButton(root).props.onClick(event())
  await settle()
  assert.deepEqual(callsOf(env, 'apply').map((call) => call.request), [{ planId: 'plan-5', confirmCount: 4 }])
  assert.equal(findAllIn(pruneDialog(root), (n) => n.props?.role === 'alert').length, 0, 'the second click left no error behind')
  assert.match(statusOf(root, 'sm-prune-status').children.join(''), /Moving 4 sessions to the trash…/, 'the first call still runs')
  validCalls(env)
})

test('changing the scope, the days or the selection discards the plan; apply never sees the old plan', async () => {
  const { env, root } = await openPage({ api: createApi({ plan: async (request) => ok(richPlan(`plan-${request.scope}`)), apply: async () => ok(applyResult()) }) })
  await openFromCard(root)
  await toConfirm(root)
  await confirmWith(root, 4)
  // Back keeps the plan (one step back is the preview of the same plan) ...
  await press(root, buttonIn(pruneDialog(root), 'Back'))
  assert.match(textOf(pruneDialog(root)), /Step 2 of 3: Preview/)
  await press(root, buttonIn(pruneDialog(root), 'Continue'))
  assert.equal(byId(pruneDialog(root), 'sm-prune-check').props.checked, false, 'the confirmation starts over')
  await press(root, buttonIn(pruneDialog(root), 'Back'))
  await press(root, buttonIn(pruneDialog(root), 'Back'))
  assert.doesNotMatch(textOf(pruneDialog(root)), /plan was discarded/)
  // ... a new scope discards it.
  await pick(root, 'olderThan')
  assert.match(textOf(pruneDialog(root)), /Step 1 of 3: Scope/)
  assert.match(textOf(pruneDialog(root)), /The scope or the selection changed, so the plan was discarded\. Preview again\./)
  assert.equal(buttonIn(pruneDialog(root), 'Continue'), undefined)
  await press(root, buttonIn(pruneDialog(root), 'Preview'))
  assert.deepEqual(callsOf(env, 'plan').at(-1).request, { scope: 'olderThan', olderThanDays: 30 })
  await press(root, buttonIn(pruneDialog(root), 'Back'))
  await type(root, 'sm-prune-days', '31')
  assert.match(textOf(pruneDialog(root)), /plan was discarded/, 'a new age discards the olderThan plan')
  await type(root, 'sm-prune-days', '30')
  assert.equal(buttonIn(pruneDialog(root), 'Continue'), undefined, 'the old age does not bring the plan back')
  assert.equal(callsOf(env, 'plan').length, 2)

  // The selection: 'Prune selected…' follows the live Archived selection; a change discards the plan.
  const archived = await openPage({ api: createApi({ plan: async () => ok(richPlan()) }) })
  await showArchived(archived.env, archived.root)
  const [shell] = archived.root.componentProps('ArchivedTab').map((props) => props.shell)
  shell.setArchivedView((current) => ({ ...current, selection: ['s0001', 's0004'] }))
  await settle()
  await press(archived.root, buttonIn(archived.root.tree, 'Prune selected…'))
  await toConfirm(archived.root)
  assert.deepEqual(callsOf(archived.env, 'plan').at(-1).request, { scope: 'selection', rootIds: ['s0001', 's0004'] })
  shell.setArchivedView((current) => ({ ...current, selection: ['s0001'] }))
  await settle()
  assert.equal(moveButton(archived.root), undefined, 'the selection changed: the plan is gone')
  assert.match(textOf(pruneDialog(archived.root)), /plan was discarded/)
  assert.match(textOf(pruneDialog(archived.root)), /1 archived session selected/)
  await press(archived.root, buttonIn(pruneDialog(archived.root), 'Preview'))
  assert.deepEqual(callsOf(archived.env, 'plan').at(-1).request, { scope: 'selection', rootIds: ['s0001'] })

  // A row's Prune… names its own root; a change of the live selection still discards the plan.
  await press(archived.root, buttonIn(pruneDialog(archived.root), 'Cancel'))
  await press(archived.root, buttonIn(archivedRow(archived.root, 's0004'), 'Prune…'))
  assert.match(textOf(pruneDialog(archived.root)), /1 archived session selected/)
  await toConfirm(archived.root)
  assert.deepEqual(callsOf(archived.env, 'plan').at(-1).request, { scope: 'selection', rootIds: ['s0004'] })
  shell.setArchivedView((current) => ({ ...current, selection: [] }))
  await settle()
  assert.equal(moveButton(archived.root), undefined)
  assert.match(textOf(pruneDialog(archived.root)), /plan was discarded/)
  await press(archived.root, buttonIn(pruneDialog(archived.root), 'Preview'))
  assert.deepEqual(callsOf(archived.env, 'plan').at(-1).request, { scope: 'selection', rootIds: ['s0004'] }, 'the row keeps its own root')

  // A new hand-off (openPrune with other roots) discards the plan too.
  await press(archived.root, buttonIn(pruneDialog(archived.root), 'Continue'))
  assert.ok(moveButton(archived.root))
  shell.openPrune({ scope: 'selection', rootIds: ['s0001'] })
  await settle()
  assert.equal(moveButton(archived.root), undefined)
  assert.match(textOf(pruneDialog(archived.root)), /Step 1 of 3: Scope/)
  assert.match(textOf(pruneDialog(archived.root)), /plan was discarded/)
  await press(archived.root, buttonIn(pruneDialog(archived.root), 'Preview'))
  assert.deepEqual(callsOf(archived.env, 'plan').at(-1).request, { scope: 'selection', rootIds: ['s0001'] })
  assert.deepEqual(callsOf(env, 'apply'), [])
  assert.deepEqual(mutatingCalls(archived.env), [])
})

for (const code of ['sessions-manager/plan-expired', 'sessions-manager/confirmation-mismatch']) {
  test(`a ${code.split('/')[1]} answer to apply returns to the preview with a message; the next apply needs a new plan`, async () => {
    let n = 0
    let answer = fail(code, 'digest moved')
    const api = createApi({ plan: async () => ok(richPlan(`plan-${++n}`)), apply: async () => answer })
    const { env, root } = await openPage({ api })
    await openFromCard(root)
    await toConfirm(root)
    await confirmWith(root, 4)
    await press(root, moveButton(root))
    const dialog = pruneDialog(root)
    assert.match(textOf(dialog), /Step 2 of 3: Preview/)
    const alert = findAllIn(dialog, (node) => node.props?.role === 'alert')[0]
    const { en } = env.locale.dictionaries(NAMESPACE)
    assert.ok(textOf(alert).includes(en[`error.${code.split('/')[1]}`]), 'the localized error')
    assert.match(textOf(alert), /Host message: digest moved/)
    assert.match(textOf(alert), /The plan can no longer be used\. Make a new plan, then confirm again\./)
    assert.equal(buttonIn(dialog, 'Continue'), undefined, 'the old plan is not offered again')
    await press(root, buttonIn(dialog, 'Preview again'))
    assert.equal(callsOf(env, 'plan').length, 2)
    answer = ok(applyResult())
    await press(root, buttonIn(pruneDialog(root), 'Continue'))
    assert.equal(byId(pruneDialog(root), 'sm-prune-check').props.checked, false, 'the confirmation starts over')
    await confirmWith(root, 4)
    await press(root, moveButton(root))
    assert.deepEqual(callsOf(env, 'apply').map((call) => call.request), [{ planId: 'plan-1', confirmCount: 4 }, { planId: 'plan-2', confirmCount: 4 }])
    validCalls(env)
  })
}

// ---------------------------------------------------------------------------
// 3. The result card and Undo.
// ---------------------------------------------------------------------------

test('the result card shows moved and skipped counts with reasons, the trash location, warnings, and Undo calls restore({ batchId })', async () => {
  let releaseRestore
  const value = applyResult({
    state: 'partial',
    warnings: [{ code: 'stale-backend-entry', sessionId: 's0001' }, { code: 'restart-recommended', sessionId: null }],
  })
  const api = createApi({
    plan: async () => ok(richPlan()),
    apply: async () => ok(value),
    restore: () => new Promise((resolve) => { releaseRestore = () => resolve(ok(restoreResult({ skipped: [{ rootId: 's0010', reasons: [{ code: 'conflict', sessionId: 's0010' }] }], state: 'conflict' }))) }),
  })
  const { env, root } = await openPage({ api })
  await openFromCard(root)
  await toConfirm(root)
  await confirmWith(root, 4)
  await press(root, moveButton(root))
  const card = () => byId(pruneDialog(root).children, 'sm-prune-result')
  assert.ok(card(), 'a result card')
  const text = textOf(card())
  assert.match(text, /Moved to the trash, with skipped units/)
  assert.match(text, /Moved2 units · 4 sessions · 6 MB/)
  assert.match(text, /Skipped1 unit/)
  assert.match(text, /s0020.*The session changed after the plan was made\. \(s0021\)/)
  assert.match(text, /Trash folder\/fake\/state\/sessions-manager\/trash/)
  assert.match(text, /Batchb-20261117T203000Z-a1b2/)
  assert.match(text, /The session store still listed a moved session after the move\. Restart the Host to be sure it is gone\. \(s0001\)/)
  assert.match(text, /Restart the Host so that it stops serving the moved sessions\./)
  assert.ok(root.focused.includes('sm-prune-result-title'), 'focus moves to the result')
  assert.equal(byRole(root, 'dialog').length, 1)

  const undo = buttonIn(pruneDialog(root), 'Undo')
  undo.props.onClick(event())
  undo.props.onClick(event())
  await settle()
  assert.deepEqual(callsOf(env, 'restore').map((call) => call.request), [{ batchId: 'b-20261117T203000Z-a1b2' }], 'one restore for a double click')
  assert.match(statusOf(root, 'sm-prune-status').children.join(''), /Restoring the batch…/)
  assert.equal(buttonIn(pruneDialog(root), 'Undo').props.disabled, true)
  releaseRestore()
  await settle()
  assert.match(textOf(card()), /Restored 4 sessions to their folders\./)
  assert.match(textOf(card()), /s0010.*The destination already exists\. Nothing was overwritten\./)
  assert.equal(buttonIn(pruneDialog(root), 'Undo').props.disabled, true, 'a batch is undone once')
  await press(root, buttonIn(pruneDialog(root), 'Undo'))
  assert.equal(callsOf(env, 'restore').length, 1, 'a press on the disabled Undo sends nothing')
  validCalls(env)

  // Nothing moved: no batch, no Undo.
  const none = await openPage({ api: createApi({ plan: async () => ok(richPlan()), apply: async () => ok(applyResult({ batchId: null, moved: { units: 0, sessions: 0, bytes: 0 }, state: 'partial' })) }) })
  await openFromCard(none.root)
  await toConfirm(none.root)
  await confirmWith(none.root, 4)
  await press(none.root, moveButton(none.root))
  assert.match(textOf(pruneDialog(none.root)), /Nothing was moved/)
  assert.equal(buttonIn(pruneDialog(none.root), 'Undo'), undefined)
  await press(none.root, buttonIn(pruneDialog(none.root), 'Done'))
  assert.equal(pruneDialog(none.root), undefined)
})

test('every apply state and warning code has its own localized text', async () => {
  const { en } = loadClient({ locale: createLocale() }).locale.dictionaries(NAMESPACE)
  for (const state of APPLY_STATES) assert.ok(Object.hasOwn(en, `prune.result.${state}`), state)
  for (const state of BATCH_STATES) assert.ok(Object.hasOwn(en, `batchState.${state}`), state)
  for (const code of WARNING_CODES) assert.ok(Object.hasOwn(en, `warning.${code}`), code)
  for (const state of APPLY_STATES) {
    const { root } = await openPage({ api: createApi({ plan: async () => ok(richPlan()), apply: async () => ok(applyResult({ state, warnings: WARNING_CODES.map((code) => ({ code, sessionId: null })) })) }) })
    await openFromCard(root)
    await toConfirm(root)
    await confirmWith(root, 4)
    await press(root, moveButton(root))
    const text = textOf(pruneDialog(root))
    assert.ok(text.includes(en[`prune.result.${state}`]), state)
    for (const code of WARNING_CODES) assert.ok(text.includes(en[`warning.${code}`]), code)
    if (state === 'needs-recovery') assert.match(text, /Nothing is deleted/)
  }
})

// ---------------------------------------------------------------------------
// 4. The Trash tab.
// ---------------------------------------------------------------------------

test('the Trash tab lists batches with time, sessions, size and state; Restore batch calls restore({ batchId }) and reports the result', async () => {
  const batches = [
    batch('b-20261117T203000Z-a1b2', { createdAt: NOW - 2 * 3_600_000, units: 2, sessions: 4, bytes: 6 * MB }),
    batch('b-20261110T090000Z-c3d4', { createdAt: NOW - 7 * DAY, state: 'needs-recovery', units: 1, sessions: 1, bytes: MB }),
    batch('b-20261101T090000Z-e5f6', { createdAt: NOW - 16 * DAY, state: 'conflict' }),
  ]
  const api = createApi({ trash: async () => ok(trashOf(batches)), restore: async () => ok(restoreResult({ moved: { units: 2, sessions: 4, bytes: 6 * MB } })) })
  const { env, root } = await openPage({ api })
  await press(root, tabs(root)[2])
  assert.ok(findAllIn(tabpanel(root), (node) => node.props?.['data-placeholder'] === 'trash').length === 1, 'the loading state')
  assert.match(textOf(tabpanel(root)), /Reading the trash…/)
  assert.deepEqual(callsOf(env, 'trash'), [], 'the first read waits for the 0 ms timer')
  await env.advance(0)
  assert.deepEqual(callsOf(env, 'trash').map((call) => call.request), [{}])
  assert.equal(textOf(tabs(root)[2]), 'Trash (3)', 'the tab counts the batches')

  const panel = tabpanel(root)
  assert.match(textOf(panel), /Trash folder\/fake\/state\/sessions-manager\/trash/)
  assert.match(textOf(panel), /3 batches · 10 MB/)
  const at = new Date(NOW - 2 * 3_600_000)
  const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
  const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const first = textOf(batchRow(root, 'b-20261117T203000Z-a1b2'))
  assert.ok(first.startsWith(`${day} ${clock}b-20261117T203000Z-a1b2`), first)
  assert.match(first, /42 units6 MBcomplete/)
  const state = (id) => findAllIn(batchRow(root, id), (n) => n.props?.className === 'sm-tag')[0]
  assert.deepEqual(batches.map((entry) => [textOf(state(entry.batchId)), state(entry.batchId).props['data-tone']]), [
    ['complete', 'success'], ['needs recovery', 'warning'], ['conflict', 'danger'],
  ])
  const hint = (id) => byId(root.tree, state(id).props['aria-describedby'])
  assert.match(textOf(hint('b-20261110T090000Z-c3d4')), /was interrupted\. Nothing is deleted/)
  assert.match(textOf(hint('b-20261101T090000Z-e5f6')), /Nothing was overwritten/)

  const restore = buttonIn(batchRow(root, 'b-20261110T090000Z-c3d4'), 'Restore batch')
  assert.equal(restore.props['aria-label'], 'Restore batch b-20261110T090000Z-c3d4')
  restore.props.onClick(event())
  restore.props.onClick(event())
  await settle()
  assert.deepEqual(callsOf(env, 'restore').map((call) => call.request), [{ batchId: 'b-20261110T090000Z-c3d4' }], 'no confirmation, one call')
  const notice = root.find((node) => node.props?.['data-notice'] === 'trash')
  assert.match(textOf(notice), /Restored 4 sessions from batch b-20261110T090000Z-c3d4\./)
  assert.ok(root.focused.includes('sm-trash-notice'))
  await env.advance(0)
  assert.deepEqual(callsOf(env, 'trash').map((call) => call.request), [{}, { fresh: true }], 'read again, fresh, after the change')
  assert.deepEqual(callsOf(env, 'overview').at(-1).request, { fresh: true })
  assert.deepEqual(mutatingCalls(env).map((call) => call.method), ['restore'])
  validCalls(env)
})

test('Delete permanently… needs the typed batch id and a second confirmation before purge({ batchId, confirm })', async () => {
  const id = 'b-20261110T090000Z-c3d4'
  const api = createApi({ purge: async () => ok(purgeResultFixture()) })
  const { env, root } = await openPage({ api })
  await showTrash(env, root)
  const open = buttonIn(batchRow(root, id), 'Delete permanently…')
  assert.equal(open.props['aria-label'], `Delete batch ${id} permanently…`)
  assert.match(open.props.className, /\bsm-button-danger\b/)
  await press(root, open)
  const dialog = () => purgeDialog(root)
  assert.ok(dialog())
  assert.match(textOf(byId(dialog(), dialog().props['aria-labelledby'])), /^Delete batch permanently$/)
  assert.match(textOf(dialog()), /Batch b-20261110T090000Z-c3d4 holds 1 session \(1 MB\)\. Deleting it removes their folders for good\. This cannot be undone\./)
  const next = () => buttonIn(dialog(), 'Delete permanently')
  assert.equal(next().props.disabled, true)
  for (const wrong of ['b-20261110T090000Z', 'B-20261110T090000Z-C3D4', `${id}x`, 'b-20261117T203000Z-a1b2']) {
    await type(root, 'sm-purge-id', wrong)
    assert.equal(next().props.disabled, true, wrong)
  }
  await type(root, 'sm-purge-id', ` ${id} `)
  assert.equal(next().props.disabled, undefined)
  await press(root, next())
  assert.deepEqual(callsOf(env, 'purge'), [], 'the typed id alone sends nothing')
  assert.match(textOf(dialog()), /Last confirmation/)
  assert.match(textOf(dialog()), /Delete 1 session \(1 MB\) of batch b-20261110T090000Z-c3d4 for good\? They cannot be restored\./)
  assert.equal(root.focused.at(-1), 'sm-purge-cancel', 'the second confirmation starts on Cancel')
  await press(root, buttonIn(dialog(), 'Back'))
  assert.equal(byId(dialog(), 'sm-purge-id').props.value, ` ${id} `, 'Back keeps the typed id')
  await press(root, next())
  const yes = buttonIn(dialog(), 'Yes, delete for good')
  assert.match(yes.props.className, /\bsm-button-danger\b/)
  yes.props.onClick(event())
  yes.props.onClick(event())
  await settle()
  assert.deepEqual(callsOf(env, 'purge').map((call) => call.request), [{ batchId: id, confirm: id }])
  assert.equal(purgeDialog(root), undefined, 'the dialog closes after success')
  assert.match(textOf(root.find((node) => node.props?.['data-notice'] === 'trash')), /Deleted batch b-20261110T090000Z-c3d4 for good: 1 session, 1 MB\./)
  assert.equal(root.focused.at(-1), 'sm-trash-notice')
  validCalls(env)

  // A confirmation mismatch from the Host returns to the typing stage with the message.
  const mismatch = await openPage({ api: createApi({ purge: async () => fail('sessions-manager/confirmation-mismatch', 'typed id differs') }) })
  await showTrash(mismatch.env, mismatch.root)
  await press(mismatch.root, buttonIn(batchRow(mismatch.root, id), 'Delete permanently…'))
  await type(mismatch.root, 'sm-purge-id', id)
  await press(mismatch.root, buttonIn(purgeDialog(mismatch.root), 'Delete permanently'))
  await press(mismatch.root, buttonIn(purgeDialog(mismatch.root), 'Yes, delete for good'))
  const text = textOf(purgeDialog(mismatch.root))
  assert.match(text, /The typed confirmation does not match\..*Host message: typed id differs/)
  assert.equal(byId(purgeDialog(mismatch.root), 'sm-purge-id').props.value, '', 'the typed id starts over')
  assert.equal(buttonIn(purgeDialog(mismatch.root), 'Yes, delete for good'), undefined)
})

test('Delete permanently… is disabled with an explanation when allowPermanentDelete is false', async () => {
  const value = overviewFixture()
  value.config.allowPermanentDelete = false
  const { env, root } = await openPage({ api: createApi({ overview: async () => ok(value) }) })
  await showTrash(env, root)
  const button = buttonIn(batchRow(root, 'b-20261117T203000Z-a1b2'), 'Delete permanently…')
  assert.equal(button.props.disabled, true)
  const why = byId(root.tree, button.props['aria-describedby'])
  assert.match(textOf(why), /Permanent delete is turned off: allowPermanentDelete is false in the plugin settings\./)
  button.props.onClick(event())
  await settle()
  assert.equal(purgeDialog(root), undefined)
  assert.equal(buttonIn(batchRow(root, 'b-20261117T203000Z-a1b2'), 'Restore batch').props.disabled, undefined, 'restore still works')

  // Read-only: the trash cannot be changed; both actions are off and the reason is named.
  const readOnly = overviewFixture()
  readOnly.capabilities = { prune: false, reason: 'sessions-manager/unsupported-platform' }
  const ro = await openPage({ api: createApi({ overview: async () => ok(readOnly) }) })
  await showTrash(ro.env, ro.root)
  assert.match(textOf(byRole(ro.root, 'note')[0]), /Read-only: pruning is off, so the trash cannot be changed\. Pruning needs the session lock check/)
  assert.equal(buttonIn(batchRow(ro.root, 'b-20261117T203000Z-a1b2'), 'Restore batch').props.disabled, true)
  assert.equal(buttonIn(batchRow(ro.root, 'b-20261117T203000Z-a1b2'), 'Delete permanently…').props.disabled, true)
  assert.deepEqual(mutatingCalls(ro.env), [])
})

test('the Trash tab: empty, error with retry, stale, malformed and rejecting states', async () => {
  const empty = await openPage({ api: createApi({ trash: async () => ok(trashOf([])) }) })
  await showTrash(empty.env, empty.root)
  assert.match(textOf(tabpanel(empty.root)), /The trash is empty\./)
  assert.equal(textOf(tabs(empty.root)[2]), 'Trash (0)')

  let mode = 'fail'
  const api = createApi({ trash: async () => (mode === 'fail' ? fail('sessions-manager/trash-unusable', 'not writable') : mode === 'throw' ? Promise.reject(new Error('socket closed')) : mode === 'bad' ? ok({ batches: 'x' }) : ok(trashListFixture())) })
  const { env, root } = await openPage({ api })
  await showTrash(env, root)
  let alert = byRole(root, 'alert')[0]
  assert.match(textOf(alert), /Could not read the trash\.The trash folder cannot be used\.Host message: not writable/)
  mode = 'ok'
  await press(root, buttonIn(alert, 'Try again'))
  await env.advance(0)
  assert.equal(byRole(root, 'alert').length, 0)
  assert.ok(batchRow(root, 'b-20261117T203000Z-a1b2'))
  mode = 'throw'
  await press(root, buttonIn(root.tree, 'Refresh'))
  await env.advance(0)
  alert = byRole(root, 'alert')[0]
  assert.match(textOf(alert), /The last refresh failed\. The list below is from the previous read\.The Host call failed\.Host message: socket closed/)
  assert.ok(batchRow(root, 'b-20261117T203000Z-a1b2'), 'the rows stay')
  mode = 'bad'
  await press(root, buttonIn(root.tree, 'Refresh'))
  await env.advance(0)
  assert.match(textOf(byRole(root, 'alert')[0]), /The Host sent a trash list that this page cannot read\./)
  assert.equal(env.consoleErrors.length, 0)
  await settle()
  assert.deepEqual(unhandled, [])
})

// ---------------------------------------------------------------------------
// 5. Dialogs: role, label, focus, Escape, Cancel, inert background, error token.
// ---------------------------------------------------------------------------

test('the prune dialog: role dialog, aria-modal, a label; initial focus on Cancel; Tab is trapped; Escape and Cancel close and focus returns to the invoker', async () => {
  const { env, root } = await openPage({ api: createApi({ plan: async () => ok(richPlan()) }) })
  const review = buttonIn(root.tree, 'Review prune…')
  const reviewNode = root.nodeOf(review)
  reviewNode.focus()
  await press(root, review)
  const dialog = pruneDialog(root)
  assert.equal(dialog.props['aria-modal'], 'true')
  assert.equal(typeof dialog.props['aria-labelledby'], 'string')
  assert.equal(env.document.activeElement.id, 'sm-prune-cancel', 'initial focus on Cancel')
  assert.equal(textOf(byId(dialog, 'sm-prune-cancel')), 'Cancel')

  // The background is inert while the panel is open.
  const inert = (node) => node.props.inert !== undefined && node.props.inert !== false && node.props.inert !== null
  assert.equal(inert(root.find((node) => node.type === 'header')), true)
  assert.equal(inert(byRole(root, 'tablist')[0]), true)
  assert.equal(inert(tabpanel(root)), true)
  assert.equal(inert(dialog), false)

  // Tab from the last control wraps to the first, Shift+Tab from the first to the last.
  const node = root.nodeOf(pruneDialog(root))
  const focusables = node.querySelectorAll('button, input, select, textarea, a[href], [tabindex]').filter((n) => !n.disabled && n.tabIndex >= 0)
  assert.ok(focusables.length >= 3)
  focusables.at(-1).focus()
  const tab = await key(pruneDialog(root), 'Tab')
  assert.equal(tab.defaultPrevented, true)
  assert.equal(env.document.activeElement, focusables[0])
  const back = await key(pruneDialog(root), 'Tab', { shiftKey: true })
  assert.equal(back.defaultPrevented, true)
  assert.equal(env.document.activeElement, focusables.at(-1))
  focusables[1].focus()
  const inside = await key(pruneDialog(root), 'Tab')
  assert.equal(inside.defaultPrevented, false, 'Tab inside the dialog moves normally')
  env.document.body.focus()
  await key(pruneDialog(root), 'Tab')
  assert.equal(env.document.activeElement, focusables[0], 'focus outside the dialog is pulled back in')

  // Escape closes, stops there, and focus returns to the control that opened the panel.
  const escape = await key(pruneDialog(root), 'Escape')
  assert.equal(escape.defaultPrevented, true)
  assert.equal(escape.propagationStopped, true)
  assert.equal(pruneDialog(root), undefined)
  assert.equal(env.document.activeElement, reviewNode)
  assert.equal(inert(byRole(root, 'tablist')[0]), false, 'the background is live again')

  // Cancel closes too, after a preview, and focus returns to the row button that opened it.
  await showArchived(env, root)
  const rowPrune = buttonIn(archivedRow(root, 's0001'), 'Prune…')
  const rowNode = root.nodeOf(rowPrune)
  await press(root, rowPrune)
  await press(root, buttonIn(pruneDialog(root), 'Preview'))
  assert.equal(root.focused.at(-1), 'sm-prune-step', 'a new step moves focus to its heading, inside the dialog')
  await press(root, buttonIn(pruneDialog(root), 'Cancel'))
  assert.equal(pruneDialog(root), undefined)
  assert.equal(env.document.activeElement, rowNode)

  // The Close button in the header closes as well; a mask click closes; a click inside does not.
  await press(root, rowPrune)
  const layer = root.find((n) => n.props?.['data-layer'] === 'prune')
  layer.props.onMouseDown(event({ target: 'inside', currentTarget: 'mask' }))
  layer.props.onClick(event({ target: 'inside', currentTarget: 'mask' }))
  await settle()
  assert.ok(pruneDialog(root), 'a click inside the card keeps it open')
  const mask = {}
  layer.props.onMouseDown(event({ target: mask, currentTarget: mask }))
  layer.props.onClick(event({ target: mask, currentTarget: mask }))
  await settle()
  assert.equal(pruneDialog(root), undefined)
  await press(root, rowPrune)
  await press(root, buttonIn(pruneDialog(root), 'Close'))
  assert.equal(pruneDialog(root), undefined)
  assert.deepEqual(mutatingCalls(env), [])
})

test('the purge dialog: role, label, initial focus on Cancel, Escape and Cancel close, focus returns to its Delete permanently… button; the list behind is inert', async () => {
  const { env, root } = await openPage()
  await showTrash(env, root)
  const id = 'b-20261117T203000Z-a1b2'
  const open = buttonIn(batchRow(root, id), 'Delete permanently…')
  const openNode = root.nodeOf(open)
  await press(root, open)
  const dialog = purgeDialog(root)
  assert.equal(dialog.props['aria-modal'], 'true')
  assert.ok(byId(dialog, dialog.props['aria-labelledby']))
  assert.ok(byId(dialog, dialog.props['aria-describedby']))
  assert.equal(env.document.activeElement.id, 'sm-purge-cancel')
  const inert = (node) => node.props.inert !== undefined && node.props.inert !== null && node.props.inert !== false
  assert.equal(inert(root.find((node) => node.type === 'header')), true)
  assert.equal(inert(byRole(root, 'tablist')[0]), true)
  assert.equal(inert(root.find((node) => node.props?.['data-trash'] === 'list')), true, 'the batch list behind the dialog')
  assert.equal(inert(tabpanel(root)), false, 'the tab panel holds the dialog itself')

  const escape = await key(purgeDialog(root), 'Escape')
  assert.equal(escape.propagationStopped, true)
  assert.equal(purgeDialog(root), undefined)
  assert.equal(env.document.activeElement, openNode)
  assert.equal(inert(root.find((node) => node.type === 'header')), false)
  assert.equal(inert(root.find((node) => node.props?.['data-trash'] === 'list')), false)

  await press(root, open)
  await type(root, 'sm-purge-id', id)
  await press(root, buttonIn(purgeDialog(root), 'Delete permanently'))
  await press(root, buttonIn(purgeDialog(root), 'Cancel'))
  assert.equal(purgeDialog(root), undefined)
  assert.equal(env.document.activeElement, openNode)
  // Tab is trapped here too.
  await press(root, open)
  const node = root.nodeOf(purgeDialog(root))
  const focusables = node.querySelectorAll('button, input, select, textarea, a[href], [tabindex]').filter((n) => !n.disabled && n.tabIndex >= 0)
  focusables.at(-1).focus()
  await key(purgeDialog(root), 'Tab')
  assert.equal(env.document.activeElement, focusables[0])
  assert.deepEqual(mutatingCalls(env), [])
})

test('destructive buttons use the host error state token', async () => {
  const { env, root } = await openPage({ api: createApi({ plan: async () => ok(richPlan()) }) })
  const css = env.document.head.children[0].textContent
  const rule = css.match(/\.sm-button-danger\{([^}]*)\}/)
  assert.ok(rule, 'a danger button rule')
  assert.match(rule[1], /color:var\(--dsw-alias-state-error-primary\)/)
  assert.match(rule[1], /var\(--dsw-alias-state-error-primary\)\s*$|box-shadow:[^;]*var\(--dsw-alias-state-error-primary\)/)
  assert.match(css, /@media \(hover:hover\)\{[^@]*\.sm-button-danger:hover:not\(:disabled\)\{background:var\(--dsw-alias-interactive-bg-hover-danger\)\}/)
  assert.match(css, /\.sm-layer\{[^}]*background:var\(--dsw-alias-bg-mask-1\)/)
  assert.match(css, /\.sm-dialog\{[^}]*background:var\(--dsw-alias-bg-layer-2\)[^}]*border-radius:var\(--dsw-radius-panel\)|\.sm-dialog\{[^}]*border-radius:var\(--dsw-radius-panel\)[^}]*background:var\(--dsw-alias-bg-layer-2\)/)
  await openFromCard(root)
  await toConfirm(root)
  assert.match(moveButton(root).props.className, /\bsm-button-danger\b/)
  assert.doesNotMatch(buttonIn(pruneDialog(root), 'Cancel').props.className, /danger/)
})

// ---------------------------------------------------------------------------
// 6. Mutation progress, single flight and refetch.
// ---------------------------------------------------------------------------

test('while apply runs: every control is disabled, a status region announces it, Escape is ignored and no second mutation starts; afterwards overview, archived and trash are read again', async () => {
  let release
  const api = createApi({
    plan: async () => ok(richPlan()),
    apply: () => new Promise((resolve) => { release = () => resolve(ok(applyResult())) }),
    unarchive: async () => ok({ unarchived: ['s0001'], skipped: [] }),
  })
  const { env, root } = await openPage({ api })
  await showArchived(env, root)
  const before = { archived: callsOf(env, 'archived').length, overview: callsOf(env, 'overview').length, trash: callsOf(env, 'trash').length }
  await press(root, buttonIn(archivedRow(root, 's0001'), 'Prune…'))
  await toConfirm(root)
  await confirmWith(root, 4)
  await press(root, moveButton(root))
  const dialog = pruneDialog(root)
  const status = statusOf(root, 'sm-prune-status')
  assert.equal(status.props.role, 'status')
  assert.match(status.children.join(''), /Moving 4 sessions to the trash…/)
  assert.equal(dialog.props['aria-busy'], true)
  for (const control of findAllIn(dialog, (n) => n.type === 'button' || n.type === 'input')) {
    assert.equal(control.props.disabled, true, `${control.type} ${textOf(control) || control.props.id} is disabled while apply runs`)
  }
  const escape = await key(pruneDialog(root), 'Escape')
  assert.equal(escape.propagationStopped, true)
  assert.ok(pruneDialog(root), 'Escape does not close the panel while apply runs')

  // The shell refuses a second mutation, and the Archived controls are off.
  const [shell] = root.componentProps('PrunePanel').map((props) => props.shell)
  assert.equal(shell.busy, 'apply')
  const second = await shell.mutate('restore', { batchId: 'b-20261117T203000Z-a1b2' })
  assert.equal(second.ok, false)
  assert.equal(second.error.code, 'client/busy')
  assert.equal(buttonIn(archivedRow(root, 's0001'), 'Unarchive').props.disabled, true)
  assert.deepEqual(mutatingCalls(env).map((call) => call.method), ['apply'])

  release()
  await settle()
  await env.advance(0)
  const [after] = root.componentProps('PrunePanel').map((props) => props.shell)
  assert.equal(after.busy, null)
  assert.equal(statusOf(root, 'sm-prune-status').children.join(''), '', 'the status region stays and is quiet')
  assert.ok(callsOf(env, 'overview').length > before.overview && callsOf(env, 'overview').at(-1).request.fresh === true, 'overview read again, fresh')
  assert.equal(callsOf(env, 'archived').length, before.archived + 1, 'archived read again')
  assert.ok(callsOf(env, 'trash').length > before.trash && callsOf(env, 'trash').at(-1).request.fresh === true, 'trash read again, fresh')
  assert.equal(textOf(tabs(root)[2]), 'Trash (2)')
  assert.equal(buttonIn(pruneDialog(root), 'Undo').props.disabled, undefined)
  validCalls(env)
})

test('while a Trash restore or purge runs: its controls are disabled, a status region announces it, and nothing else can start', async () => {
  let release
  const api = createApi({ restore: () => new Promise((resolve) => { release = () => resolve(ok(restoreResult())) }), purge: async () => ok(purgeResultFixture()) })
  const { env, root } = await openPage({ api })
  await showTrash(env, root)
  await press(root, buttonIn(batchRow(root, 'b-20261117T203000Z-a1b2'), 'Restore batch'))
  const status = root.find((node) => node.props?.id === 'sm-trash-status')
  assert.equal(status.props.role, 'status')
  assert.match(textOf(status), /Restoring batch b-20261117T203000Z-a1b2…/)
  for (const id of ['b-20261117T203000Z-a1b2', 'b-20261110T090000Z-c3d4']) {
    assert.equal(buttonIn(batchRow(root, id), 'Restore batch').props.disabled, true)
    assert.equal(buttonIn(batchRow(root, id), 'Delete permanently…').props.disabled, true)
  }
  assert.equal(buttonIn(root.tree, 'Refresh').props.disabled, undefined, 'Refresh is a read and stays available')
  buttonIn(batchRow(root, 'b-20261110T090000Z-c3d4'), 'Delete permanently…').props.onClick(event())
  await settle()
  assert.equal(purgeDialog(root), undefined)
  release()
  await settle()
  await env.advance(0)
  assert.equal(buttonIn(batchRow(root, 'b-20261110T090000Z-c3d4'), 'Restore batch').props.disabled, undefined)
  assert.equal(textOf(root.find((node) => node.props?.id === 'sm-trash-status')), '')

  // Purge in flight: the dialog's controls are off and Escape is ignored.
  let releasePurge
  const slow = await openPage({ api: createApi({ purge: () => new Promise((resolve) => { releasePurge = () => resolve(ok(purgeResultFixture())) }) }) })
  await showTrash(slow.env, slow.root)
  const id = 'b-20261110T090000Z-c3d4'
  await press(slow.root, buttonIn(batchRow(slow.root, id), 'Delete permanently…'))
  await type(slow.root, 'sm-purge-id', id)
  await press(slow.root, buttonIn(purgeDialog(slow.root), 'Delete permanently'))
  await press(slow.root, buttonIn(purgeDialog(slow.root), 'Yes, delete for good'))
  for (const control of findAllIn(purgeDialog(slow.root), (n) => n.type === 'button' || n.type === 'input')) assert.equal(control.props.disabled, true)
  assert.match(textOf(slow.root.find((node) => node.props?.id === 'sm-purge-status')), /Deleting batch b-20261110T090000Z-c3d4 for good…/)
  await key(purgeDialog(slow.root), 'Escape')
  assert.ok(purgeDialog(slow.root))
  releasePurge()
  await settle()
  assert.equal(purgeDialog(slow.root), undefined)
  assert.deepEqual(callsOf(slow.env, 'purge').length, 1)
})

// ---------------------------------------------------------------------------
// 7. Errors: localized text, Host detail, no unhandled rejection.
// ---------------------------------------------------------------------------

const answers = (code) => [
  ['result', async () => fail(code, 'the host said no')],
  ['reject', async () => { throw Object.assign(new Error('the host said no'), { code }) }],
  ['throw', () => { throw Object.assign(new Error('the host said no'), { code }) }],
]

test('every Remote error code on plan, apply, restore, purge and trash shows its localized text with the Host message; rejecting fakes leave no unhandled rejection', async () => {
  const { en } = loadClient({ locale: createLocale() }).locale.dictionaries(NAMESPACE)
  const expectedText = (code) => (ERROR_CODES.includes(code) ? en[`error.${code.slice('sessions-manager/'.length)}`] : en['error.unknown'])
  const has = (node, code) => {
    const text = textOf(node)
    assert.ok(text.includes(expectedText(code)), `${code}: ${text}`)
    assert.ok(text.includes('Host message: the host said no'), `${code}: detail`)
  }
  for (const code of [...ERROR_CODES, 'elsewhere/odd']) {
    for (const [how, handler] of answers(code)) {
      // plan
      let page = await openPage({ api: createApi({ plan: handler }) })
      await openFromCard(page.root)
      await press(page.root, buttonIn(pruneDialog(page.root), 'Preview'))
      has(findAllIn(pruneDialog(page.root), (n) => n.props?.role === 'alert')[0], code)
      assert.match(textOf(pruneDialog(page.root)), /Step 1 of 3: Scope/, `${code} ${how}: plan errors stay on the scope step`)
      // apply
      page = await openPage({ api: createApi({ plan: async () => ok(richPlan()), apply: handler }) })
      await openFromCard(page.root)
      await toConfirm(page.root)
      await confirmWith(page.root, 4)
      await press(page.root, moveButton(page.root))
      has(findAllIn(pruneDialog(page.root), (n) => n.props?.role === 'alert')[0], code)
      // restore (Undo) and the Trash tab's restore, purge and list
      page = await openPage({ api: createApi({ plan: async () => ok(richPlan()), apply: async () => ok(applyResult()), restore: handler }) })
      await openFromCard(page.root)
      await toConfirm(page.root)
      await confirmWith(page.root, 4)
      await press(page.root, moveButton(page.root))
      await press(page.root, buttonIn(pruneDialog(page.root), 'Undo'))
      has(findAllIn(pruneDialog(page.root), (n) => n.props?.role === 'alert')[0], code)
      assert.equal(buttonIn(pruneDialog(page.root), 'Undo').props.disabled, undefined, 'Undo can be tried again after a failure')

      page = await openPage({ api: createApi({ restore: handler, purge: handler }) })
      await showTrash(page.env, page.root)
      await press(page.root, buttonIn(batchRow(page.root, 'b-20261117T203000Z-a1b2'), 'Restore batch'))
      has(page.root.find((node) => node.props?.['data-notice'] === 'trash'), code)
      await page.env.advance(0)
      await press(page.root, buttonIn(batchRow(page.root, 'b-20261117T203000Z-a1b2'), 'Delete permanently…'))
      await type(page.root, 'sm-purge-id', 'b-20261117T203000Z-a1b2')
      await press(page.root, buttonIn(purgeDialog(page.root), 'Delete permanently'))
      await press(page.root, buttonIn(purgeDialog(page.root), 'Yes, delete for good'))
      has(findAllIn(purgeDialog(page.root), (n) => n.props?.role === 'alert')[0], code)

      page = await openPage({ api: createApi({ trash: handler }) })
      await showTrash(page.env, page.root)
      has(byRole(page.root, 'alert')[0], code)
      assert.equal(page.env.consoleErrors.length, 0)
    }
  }
  await settle(8)
  assert.deepEqual(unhandled, [], 'no unhandled rejection')
})

test('malformed answers never crash the panel or the tab and say what happened', async () => {
  let page = await openPage({ api: createApi({ plan: async () => ok({ planId: 'p', units: 'x' }) }) })
  await openFromCard(page.root)
  await press(page.root, buttonIn(pruneDialog(page.root), 'Preview'))
  assert.match(textOf(pruneDialog(page.root)), /The Host sent a plan that this page cannot read\. Nothing was moved\./)
  // Totals that contradict the units are refused: the typed count would not be the plan's.
  const lying = richPlan()
  lying.totals.readySessions = 3
  page = await openPage({ api: createApi({ plan: async () => ok(lying) }) })
  await openFromCard(page.root)
  await press(page.root, buttonIn(pruneDialog(page.root), 'Preview'))
  assert.match(textOf(pruneDialog(page.root)), /cannot read/)
  assert.equal(buttonIn(pruneDialog(page.root), 'Continue'), undefined)

  page = await openPage({ api: createApi({ plan: async () => ok(richPlan()), apply: async () => ok({ moved: 1 }) }) })
  await openFromCard(page.root)
  await toConfirm(page.root)
  await confirmWith(page.root, 4)
  await press(page.root, moveButton(page.root))
  assert.match(textOf(pruneDialog(page.root)), /Some sessions may have moved: check the Trash tab\./)
  assert.equal(moveButton(page.root), undefined, 'no second apply on an unknown outcome')
  page = await openPage({ api: createApi({ restore: async () => ok({}), purge: async () => ok({ nope: 1 }) }) })
  await showTrash(page.env, page.root)
  await press(page.root, buttonIn(batchRow(page.root, 'b-20261117T203000Z-a1b2'), 'Restore batch'))
  assert.match(textOf(page.root.find((node) => node.props?.['data-notice'] === 'trash')), /cannot read\. The list was read again\./)
  assert.equal(page.env.consoleErrors.length, 0)
  await settle()
  assert.deepEqual(unhandled, [])
})

// ---------------------------------------------------------------------------
// 8. Mutations only from a click.
// ---------------------------------------------------------------------------

test('no apply, restore or purge after mount, refresh, timed refresh, tab switches, an open panel or an open dialog', async () => {
  for (const strict of [false, true]) {
    const value = overviewFixture()
    value.config.refreshMs = 5_000
    const api = createApi({ overview: async () => ok(value), plan: async () => ok(richPlan()), apply: async () => ok(applyResult()) })
    const { env, root } = await openPage({ api, strict })
    for (const tab of [1, 2, 0, 2, 1]) { await press(root, tabs(root)[tab]); await env.advance(0) }
    await press(root, buttonIn(root.tree, 'Refresh'))
    await env.advance(5_000)
    await press(root, tabs(root)[0])
    await openFromCard(root)
    await toConfirm(root)
    await confirmWith(root, 4)
    await env.advance(15_000)
    await press(root, buttonIn(pruneDialog(root), 'Cancel'))
    await showTrash(env, root)
    await press(root, buttonIn(batchRow(root, 'b-20261117T203000Z-a1b2'), 'Delete permanently…'))
    await type(root, 'sm-purge-id', 'b-20261117T203000Z-a1b2')
    await press(root, buttonIn(purgeDialog(root), 'Delete permanently'))
    await env.advance(15_000)
    root.unmount()
    const again = env.renderPage()
    await settle()
    await env.advance(0)
    assert.deepEqual(mutatingCalls(env), [], `strict: ${strict}`)
    assert.ok(callsOf(env, 'trash').length >= 2)
    again.unmount()
    assert.equal(again.stats.setAfterUnmount, 0)
    assert.equal(root.stats.setAfterUnmount, 0)
  }
  // Static guard: no effect body in the client calls mutate(.
  const bodies = effectBodies(CLIENT_SOURCE)
  assert.ok(bodies.length >= 8, `${bodies.length} effects`)
  for (const body of bodies) assert.doesNotMatch(body, /\bmutate\(/, 'an effect calls mutate')
  for (const method of ['apply', 'restore', 'purge']) {
    assert.ok(new RegExp(`mutate\\('${method}'`).test(CLIENT_SOURCE), `${method} goes through shell.mutate`)
    assert.doesNotMatch(CLIENT_SOURCE, new RegExp(`(?:read|call)\\('${method}'`), `${method} only through mutate`)
  }
})

/** The source of every React.useEffect callback, found by bracket matching (quotes skipped). */
function effectBodies(source) {
  const out = []
  let from = 0
  for (;;) {
    const at = source.indexOf('React.useEffect(', from)
    if (at < 0) return out
    let depth = 0
    let index = at + 'React.useEffect'.length
    let quote = null
    for (; index < source.length; index++) {
      const char = source[index]
      if (quote) { if (char === '\\') index++; else if (char === quote) quote = null; continue }
      if (char === "'" || char === '"' || char === '`') { quote = char; continue }
      if (char === '(') depth++
      else if (char === ')') { depth--; if (depth === 0) break }
    }
    out.push(source.slice(at, index + 1))
    from = index + 1
  }
}

test('what a tab switch really reads once the timers fire: one archived and one trash read, never a mutation', async () => {
  // The shell test 'switching tabs fetches nothing' only holds because its fake
  // timers never fire; this test lets them fire.
  const { env, root } = await openPage()
  await press(root, tabs(root)[1])
  await press(root, tabs(root)[2])
  assert.deepEqual(env.calls.map((call) => call.method), ['overview'], 'nothing before the 0 ms timers')
  await env.advance(0)
  assert.deepEqual(env.calls.map((call) => call.method), ['overview', 'trash'], 'the Archived timer was cleared when its tab closed')
  await press(root, tabs(root)[1])
  await env.advance(0)
  assert.deepEqual(env.calls.map((call) => call.method), ['overview', 'trash', 'archived'])
  assert.deepEqual(mutatingCalls(env), [])
})

// ---------------------------------------------------------------------------
// Locale.
// ---------------------------------------------------------------------------

const TEXT_PROPS = ['aria-label', 'title', 'placeholder', 'alt', 'aria-description', 'aria-valuetext', 'label']
function visibleStrings(root) {
  const out = []
  const walk = (node) => {
    if (typeof node === 'string') { out.push(node); return }
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node === null || typeof node !== 'object') return
    for (const name of TEXT_PROPS) if (typeof node.props?.[name] === 'string') out.push(node.props[name])
    for (const child of node.children ?? []) walk(child)
  }
  walk(root.tree)
  return out
}
function assertNoLiterals(root, data, where) {
  const allowed = [...data].filter(Boolean).sort((a, b) => b.length - a.length)
  for (const text of visibleStrings(root)) {
    let rest = text.replace(/⟦[^⟧]*⟧/g, '')
    for (const value of allowed) rest = rest.split(value).join('')
    assert.match(rest, /^[\s\d.,:%·()/\-–—+]*$/u, `${where}: unlocalized literal in ${JSON.stringify(text)}`)
  }
}

test('every prune, trash, purge, state and warning key is in both tables, translated, with the same placeholders', () => {
  const env = loadClient({ locale: createLocale() })
  const { en, zh } = env.locale.dictionaries(NAMESPACE)
  const used = new Set([...CLIENT_SOURCE.matchAll(/'((?:prune|trash|purge|warning|batchState)\.[\w.-]+)'/g)].map((match) => match[1]))
  for (const code of WARNING_CODES) used.add(`warning.${code}`)
  for (const state of APPLY_STATES) used.add(`prune.result.${state}`)
  for (const state of BATCH_STATES) used.add(`batchState.${state}`)
  assert.ok(used.size > 60, `${used.size} keys`)
  const placeholders = (text) => (text.match(/\{\w+\}/g) ?? []).sort()
  for (const name of used) {
    assert.ok(Object.hasOwn(en, name), `en ${name}`)
    assert.ok(Object.hasOwn(zh, name), `zh ${name}`)
    assert.notEqual(zh[name], en[name], `zh ${name} is translated`)
    assert.deepEqual(placeholders(zh[name]), placeholders(en[name]), name)
  }
  for (const gone of ['placeholder.trash', 'placeholder.prune', 'placeholder.close']) assert.equal(Object.hasOwn(en, gone), false, `${gone} is gone`)
  assert.doesNotMatch(en['prune.move'], /delete/i)
})

test('a marker locale shows no unlocalized literal in any prune step, the result card, the Trash tab or the purge dialog', async () => {
  const plan = richPlan()
  const result = applyResult({ warnings: [{ code: 'recovery-needed', sessionId: 's0040' }] })
  const trash = trashOf([batch('b-20261117T203000Z-a1b2'), batch('b-20261110T090000Z-c3d4', { state: 'needs-recovery' }), batch('b-20261101T090000Z-e5f6', { state: 'conflict' })])
  const data = [
    '/fake/store', '/fake/work/alpha', 'alpha', '2026-09', 's0007', 's0008', 'Session s0007', 'host detail',
    ...plan.units.flatMap((entry) => [...entry.memberIds, entry.workspaceId]), 'ws-beta', result.trashDir, result.batchId,
    ...trash.batches.map((entry) => entry.batchId), ...archivedPageFixture().rows.flatMap((row) => [row.id, row.title, ...row.reasons.map((reason) => reason.sessionId)]),
    ...[NOW, NOW - DAY].map((ms) => { const at = new Date(ms); return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}` }),
  ]
  let applyAnswer = ok(result)
  const api = createApi({
    plan: async () => ok(plan),
    apply: async () => applyAnswer,
    restore: async () => ok(restoreResult({ skipped: [{ rootId: 's0010', reasons: [{ code: 'conflict', sessionId: 's0010' }] }] })),
    trash: async () => ok(trash),
    purge: async () => fail('sessions-manager/busy'),
  })
  const { env, root } = await openPage({ locale: createLocale({ mode: 'marker' }), api })
  const button = (node, name) => buttonIn(node, `⟦${name}⟧`)
  await press(root, button(root.tree, 'card.reclaim.review'))
  assertNoLiterals(root, data, 'scope')
  await pick(root, 'olderThan')
  await type(root, 'sm-prune-days', 'x')
  assertNoLiterals(root, data, 'invalid days')
  await type(root, 'sm-prune-days', '30')
  await press(root, button(pruneDialog(root), 'prune.preview'))
  assertNoLiterals(root, data, 'preview')
  await press(root, button(pruneDialog(root), 'prune.continue'))
  await tick(root, 'sm-prune-check')
  await type(root, 'sm-prune-count', '3')
  assertNoLiterals(root, data, 'confirm')
  await type(root, 'sm-prune-count', '4')
  await press(root, button(pruneDialog(root), 'prune.move'))
  assertNoLiterals(root, data, 'result')
  await press(root, button(pruneDialog(root), 'prune.undo'))
  assertNoLiterals(root, data, 'undone')
  await press(root, button(pruneDialog(root), 'prune.done'))

  applyAnswer = fail('sessions-manager/plan-expired')
  await press(root, button(root.tree, 'card.reclaim.review'))
  await press(root, button(pruneDialog(root), 'prune.preview'))
  await press(root, button(pruneDialog(root), 'prune.continue'))
  await tick(root, 'sm-prune-check')
  await type(root, 'sm-prune-count', '4')
  await press(root, button(pruneDialog(root), 'prune.move'))
  assertNoLiterals(root, data, 'plan expired')
  await press(root, button(pruneDialog(root), 'prune.cancel'))

  await showTrash(env, root)
  assertNoLiterals(root, data, 'trash')
  await press(root, button(batchRow(root, 'b-20261110T090000Z-c3d4'), 'trash.restore'))
  assertNoLiterals(root, data, 'restored')
  await env.advance(0)
  await press(root, button(batchRow(root, 'b-20261117T203000Z-a1b2'), 'trash.delete'))
  await type(root, 'sm-purge-id', 'nope')
  assertNoLiterals(root, data, 'purge typing')
  await type(root, 'sm-purge-id', 'b-20261117T203000Z-a1b2')
  await press(root, button(purgeDialog(root), 'purge.continue'))
  assertNoLiterals(root, data, 'purge final')
  await press(root, button(purgeDialog(root), 'purge.confirm'))
  assertNoLiterals(root, data, 'purge failed')

  const off = overviewFixture()
  off.config.allowPermanentDelete = false
  off.capabilities = { prune: false, reason: 'sessions-manager/trash-unusable' }
  for (const options of [
    { api: createApi({ overview: async () => ok(off), trash: async () => ok(trash) }) },
    { api: createApi({ trash: async () => ok(trashOf([])) }) },
    { api: createApi({ trash: async () => fail('sessions-manager/forbidden') }) },
    { api: createApi({ trash: async () => ok({ nope: true }) }) },
  ]) {
    const next = await openPage({ locale: createLocale({ mode: 'marker' }), ...options })
    await showTrash(next.env, next.root)
    assertNoLiterals(next.root, data, 'trash states')
  }
})

test('the zh table is used for the panel and the Trash tab', async () => {
  const locale = createLocale({ mode: 'zh' })
  const { env, root } = await openPage({ locale, api: createApi({ plan: async () => ok(richPlan()) }) })
  const { zh } = locale.dictionaries(NAMESPACE)
  await press(root, buttonIn(root.tree, zh['card.reclaim.review']))
  assert.ok(textOf(pruneDialog(root)).includes(zh['prune.title']))
  assert.ok(buttonIn(pruneDialog(root), zh['prune.cancel']))
  await press(root, buttonIn(pruneDialog(root), zh['prune.cancel']))
  await showTrash(env, root)
  assert.ok(buttonIn(batchRow(root, 'b-20261117T203000Z-a1b2'), zh['trash.restore']))
  assert.ok(textOf(tabpanel(root)).includes(zh['batchState.needs-recovery']))
  assert.ok(plain(trashListFixture()))
})

test('the client mirrors the contract batch id pattern, plan scopes, warning codes and states', () => {
  assert.ok(CLIENT_SOURCE.includes(`const BATCH_ID_PATTERN = ${String(BATCH_ID_PATTERN)}`), 'batch id pattern')
  const list = (name, values) => assert.ok(CLIENT_SOURCE.includes(`const ${name} = [${values.map((value) => `'${value}'`).join(', ')}]`), name)
  list('PLAN_SCOPES', PLAN_SCOPES)
  list('WARNING_CODES', WARNING_CODES)
  list('APPLY_STATES', APPLY_STATES)
  list('BATCH_STATES', BATCH_STATES)
})

test('apply, purge and restore answers used here pass the contract validators', () => {
  assertPurgeResult(purgeResultFixture())
  assertApplyResult(applyResultFixture())
  assertPlan(planFixture())
  assertTrashList(trashListFixture())
  assertPlan(richPlan())
})
