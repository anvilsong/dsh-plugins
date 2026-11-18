// Archived tab tests for dsh-plugin-sessions (T12): Host-side filters and sort
// (debounced; the fake remote records every request), rows grouped by
// workspace, table roles and aria-sort, multi-select with a selection bar,
// Unarchive with one confirmation and per-id failures, the Prune… hand-off to
// the prune flow, orphan rows, and the loading, empty, error and read-only
// states. The client runs in the vm harness (test/helpers/client-harness.mjs);
// nothing here touches the real DSH home or session store.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ARCHIVED_SORTS, MAX_IDS_PER_REQUEST, METHOD_NAMES, METHODS, NAMESPACE, REFUSAL_CODES, assertArchivedPage, assertRequest,
  assertUnarchiveResult,
} from '../src/contract.js'
import { archivedPageFixture, overviewFixture } from './helpers/fixtures.mjs'
import { CLIENT_SOURCE, NOW, byRole, createApi, createLocale, event, loadClient, plain, settle, textOf } from './helpers/client-harness.mjs'

const MB = 1024 * 1024
const DAY = 86_400_000
const MUTATING = METHOD_NAMES.filter((name) => METHODS[name].mutates)

// ---------------------------------------------------------------------------
// Fixtures and helpers.
// ---------------------------------------------------------------------------

/** One archived page row (contract shape); `extra` overrides fields. */
const row = (id, extra = {}) => ({
  id, title: `Session ${id}`, workspaceId: 'ws-alpha', bytes: 4 * MB, childCount: 2, lastActivityAt: NOW - 40 * DAY, ageDays: 40,
  blocked: false, reasons: [], orphan: false, ...extra,
})
/** An archived page that passes the contract validator. */
const pageOf = (rows, extra = {}) => {
  const value = { total: rows.length, offset: 0, limit: 500, rows, ...extra }
  assertArchivedPage(value)
  return value
}
const ok = (value) => ({ ok: true, value })
const unarchived = (ids, skipped = []) => {
  const value = { unarchived: ids, skipped }
  assertUnarchiveResult(value)
  return ok(value)
}

function findAllIn(node, predicate, found = []) {
  if (Array.isArray(node)) { node.forEach((child) => findAllIn(child, predicate, found)); return found }
  if (node === null || typeof node !== 'object') return found
  if (predicate(node)) found.push(node)
  for (const child of node.children ?? []) findAllIn(child, predicate, found)
  return found
}
const tabs = (root) => byRole(root, 'tab')
const tabpanel = (root) => byRole(root, 'tabpanel')[0]
const buttonIn = (node, text) => findAllIn(node, (n) => n.type === 'button' && textOf(n) === text)[0]
const buttonsIn = (node, text) => findAllIn(node, (n) => n.type === 'button' && textOf(n) === text)
const callsOf = (env, method) => env.calls.filter((call) => call.method === method)
const requests = (env) => callsOf(env, 'archived').map((call) => call.request)
const lastRequest = (env) => requests(env).at(-1)
const mutatingCalls = (env) => env.calls.filter((call) => MUTATING.includes(call.method))
const table = (root) => byRole(root, 'table').find((node) => node.props['aria-label'] === 'Archived sessions')
const rowNode = (root, id) => root.find((node) => node.props?.role === 'row' && node.props['data-id'] === id)
const listedIds = (root) => root.findAll((node) => node.props?.role === 'row' && typeof node.props['data-id'] === 'string').map((node) => node.props['data-id'])
const cellsOf = (node) => findAllIn(node, (n) => n.props?.role === 'cell')
const checkboxOf = (root, id) => findAllIn(rowNode(root, id), (n) => n.type === 'input' && n.props.type === 'checkbox')[0]
const toggle = (root, id) => checkboxOf(root, id).props.onChange(event({ target: { checked: !checkboxOf(root, id).props.checked } }))
const selectAll = (root) => {
  const box = findAllIn(table(root), (n) => n.type === 'input' && n.props['aria-label'] === 'Select all listed sessions')[0]
  box.props.onChange(event({ target: { checked: true } }))
}
const selectionBar = (root) => root.find((node) => node.props?.role === 'group' && node.props.className === 'sm-selbar')
const confirmStrip = (root) => root.find((node) => node.props?.role === 'group' && node.props['aria-labelledby'] === 'sm-arch-confirm-q')
const notice = (root) => root.find((node) => node.props?.['data-notice'] === 'unarchive')
/** The input or select inside the toolbar label whose caption is `caption`. */
const field = (root, caption) => {
  const label = root.find((node) => node.type === 'label' && textOf(node.children[0]) === caption)
  assert.ok(label, `a field labelled ${caption}`)
  return findAllIn(label, (n) => n.type === 'input' || n.type === 'select')[0]
}
const typeInto = (root, caption, value) => field(root, caption).props.onChange(event({ target: { value } }))
const sortButton = (root, caption) => {
  const header = byRole(root, 'columnheader').find((node) => textOf(node) === caption)
  assert.ok(header, `a column header ${caption}`)
  return findAllIn(header, (n) => n.type === 'button')[0]
}
const ariaSort = (root) => Object.fromEntries(byRole(root, 'columnheader').filter((node) => 'aria-sort' in node.props).map((node) => [textOf(node), node.props['aria-sort']]))

/** Load the client, render the page, open the Archived tab and let its first request answer. */
async function openArchived(options = {}) {
  const env = loadClient({ locale: createLocale(), ...options })
  await settle()
  const root = env.renderPage()
  await settle()
  tabs(root)[1].props.onClick(event())
  await settle()
  await env.advance(0)
  return { env, root }
}

/** A fake remote whose archived() serves `pages` in turn (the last one repeats) and records each request. */
const pagesApi = (pages, handlers = {}) => {
  let n = 0
  return createApi({ archived: async () => ok(pages[Math.min(n++, pages.length - 1)]), ...handlers })
}

// ---------------------------------------------------------------------------
// 1. Rows come from archived(request); filters and sort go to the Host.
// ---------------------------------------------------------------------------

test('the client mirrors the contract sorts and id cap', () => {
  assert.match(CLIENT_SOURCE, new RegExp(`const ARCHIVED_SORTS = \\[${ARCHIVED_SORTS.map((sort) => `'${sort}'`).join(', ')}\\]`))
  assert.match(CLIENT_SOURCE, new RegExp(`const MAX_IDS_PER_REQUEST = ${MAX_IDS_PER_REQUEST}\\b`))
  for (const code of REFUSAL_CODES) assert.match(CLIENT_SOURCE, new RegExp(`'${code}'`), `refusal ${code} mirrored`)
})

test('opening the tab sends one archived(request) through the request timer; a strict-mode replay sends no second call', async () => {
  for (const strict of [false, true]) {
    const env = loadClient({ locale: createLocale(), strict })
    await settle()
    const root = env.renderPage()
    await settle()
    tabs(root)[1].props.onClick(event())
    await settle()
    assert.deepEqual(requests(env), [], 'the first request waits for the 0 ms timer')
    assert.match(root.text(tabpanel(root)), /Reading archived sessions…/)
    assert.equal(env.timers.count, 1, `one pending request timer (strict: ${strict})`)
    await env.advance(0)
    assert.deepEqual(requests(env), [{ sort: 'bytes' }], `strict: ${strict}`)
    assert.deepEqual(listedIds(root), ['s0001', 's0004'])
    assert.equal(root.text(tabpanel(root)).includes('Reading archived sessions'), false)
    for (const call of env.calls) assertRequest(call.method, call.request)
    assert.deepEqual(mutatingCalls(env), [])
  }
})

test('filters and sort go to the Host, debounced; the client renders the Host page as sent and never filters or sorts it', async () => {
  // The Host page deliberately ignores the filters and is in no client order.
  const served = pageOf([row('s0009', { title: 'Zeta', bytes: MB }), row('s0002', { title: 'Alpha', bytes: 9 * MB })])
  const { env, root } = await openArchived({ api: pagesApi([served]) })
  assert.deepEqual(listedIds(root), ['s0009', 's0002'], 'the Host order is kept: no client sort by size')

  typeInto(root, 'Search', 'q'); await settle()
  typeInto(root, 'Search', 'qu'); await settle()
  typeInto(root, 'Search', '  quux '); await settle()
  await env.advance(299)
  assert.equal(requests(env).length, 1, 'no call while typing')
  await env.advance(1)
  assert.deepEqual(lastRequest(env), { sort: 'bytes', text: 'quux' }, 'one call after the pause, with the trimmed text')
  assert.deepEqual(listedIds(root), ['s0009', 's0002'], 'rows that do not contain the text stay listed: the Host filters, not the client')

  typeInto(root, 'Older than (days)', '30'); await settle()
  await env.advance(100)
  typeInto(root, 'Larger than (MB)', '1.5'); await settle()
  await env.advance(299)
  assert.equal(requests(env).length, 2, 'the window restarts on every edit')
  await env.advance(1)
  assert.deepEqual(lastRequest(env), { sort: 'bytes', text: 'quux', olderThanDays: 30, largerThanBytes: 1.5 * MB })
  assert.equal(requests(env).length, 3, 'two edits inside the window are one call')

  // An invalid number is marked and not sent.
  typeInto(root, 'Older than (days)', '-3'); await settle()
  assert.equal(field(root, 'Older than (days)').props['aria-invalid'], true)
  assert.match(root.text(tabpanel(root)), /Enter a number of 0 or more/)
  await env.advance(300)
  assert.deepEqual(lastRequest(env), { sort: 'bytes', text: 'quux', largerThanBytes: 1.5 * MB })
  typeInto(root, 'Older than (days)', '2.5'); await settle()
  assert.equal(field(root, 'Older than (days)').props['aria-invalid'], true, 'days are whole numbers')
  typeInto(root, 'Older than (days)', ''); await settle()
  assert.equal(field(root, 'Older than (days)').props['aria-invalid'], undefined)

  // A workspace pick and a sort click are sent without the typing delay.
  const before = requests(env).length
  field(root, 'Workspace').props.onChange(event({ target: { value: 'ws:ws-alpha' } })); await settle()
  await env.advance(0)
  assert.equal(requests(env).length, before + 1)
  assert.deepEqual(lastRequest(env), { sort: 'bytes', text: 'quux', largerThanBytes: 1.5 * MB, workspaceId: 'ws-alpha' })
  sortButton(root, 'Session').props.onClick(event()); await settle()
  await env.advance(0)
  assert.equal(lastRequest(env).sort, 'title')
  field(root, 'Workspace').props.onChange(event({ target: { value: 'none' } })); await settle()
  await env.advance(0)
  assert.equal(lastRequest(env).workspaceId, null, 'Unassigned is workspaceId null')
  field(root, 'Workspace').props.onChange(event({ target: { value: 'all' } })); await settle()
  await env.advance(0)
  assert.equal('workspaceId' in lastRequest(env), false, 'All workspaces sends no workspaceId')

  // The text the Host accepts is at most 200 characters; blank text is not sent.
  typeInto(root, 'Search', 'x'.repeat(250)); await settle()
  await env.advance(300)
  assert.equal(lastRequest(env).text.length, 200)
  typeInto(root, 'Search', '   '); await settle()
  await env.advance(300)
  assert.equal('text' in lastRequest(env), false)

  assert.deepEqual(listedIds(root), ['s0009', 's0002'], 'the client still shows exactly the Host rows')
  for (const call of env.calls) assertRequest(call.method, call.request)
  assert.deepEqual(mutatingCalls(env), [])
})

test('the toolbar offers the overview workspaces, Unassigned and an unknown filtered id', async () => {
  const { root, env } = await openArchived()
  const options = () => findAllIn(field(root, 'Workspace'), (n) => n.type === 'option').map((n) => [n.props.value, textOf(n)])
  assert.deepEqual(options(), [['all', 'All workspaces'], ['ws:ws-alpha', 'alpha'], ['none', 'Unassigned']])
  assert.equal(field(root, 'Workspace').props.value, 'all')
  assert.equal(field(root, 'Search').props.placeholder, 'Id, title or workspace')
  assert.equal(field(root, 'Search').props.maxLength, 200)
  const [shell] = root.componentProps('ArchivedTab').map((props) => props.shell)
  shell.openArchived({ workspaceId: 'ws-gone' })
  await settle()
  assert.deepEqual(options().at(-2), ['ws:ws-gone', 'ws-gone'])
  assert.equal(field(root, 'Workspace').props.value, 'ws:ws-gone')
  await env.advance(0)
  assert.equal(lastRequest(env).workspaceId, 'ws-gone')
})

test('a workspace row of the Overview opens the tab filtered by it; the chip and Clear filters remove filters', async () => {
  const env = loadClient({ locale: createLocale() })
  await settle()
  const root = env.renderPage()
  await settle()
  root.findAll((node) => node.type === 'button' && node.props.className === 'sm-row-open')[0].props.onClick(event())
  await settle()
  await env.advance(0)
  assert.deepEqual(requests(env), [{ sort: 'bytes', workspaceId: 'ws-alpha' }], 'the first request already carries the workspace')
  assert.equal(field(root, 'Workspace').props.value, 'ws:ws-alpha')
  const chip = buttonIn(tabpanel(root), 'Workspace: alpha')
  assert.ok(chip, 'a chip names the workspace filter')
  assert.equal(chip.props['aria-label'], 'Remove the filter Workspace: alpha')
  chip.props.onClick(event()); await settle()
  await env.advance(0)
  assert.deepEqual(lastRequest(env), { sort: 'bytes' })
  assert.equal(buttonIn(tabpanel(root), 'Workspace: alpha'), undefined)
  assert.equal(buttonIn(tabpanel(root), 'Clear filters'), undefined, 'no Clear filters without a filter')

  typeInto(root, 'Search', 'abc'); await settle()
  field(root, 'Workspace').props.onChange(event({ target: { value: 'none' } })); await settle()
  await env.advance(0)
  assert.deepEqual(lastRequest(env), { sort: 'bytes', text: 'abc', workspaceId: null })
  assert.ok(buttonIn(tabpanel(root), 'Workspace: Unassigned'))
  buttonIn(tabpanel(root), 'Clear filters').props.onClick(event()); await settle()
  await env.advance(0)
  assert.deepEqual(lastRequest(env), { sort: 'bytes' })
  assert.equal(field(root, 'Search').props.value, '')
  for (const call of env.calls) assertRequest(call.method, call.request)
})

test('a late answer to an older request never replaces a newer page', async () => {
  const releases = []
  const api = createApi({
    archived: (request) => new Promise((resolve) => {
      releases.push(() => resolve(ok(pageOf([row('olderThanDays' in request ? 'new' : 'old')]))))
    }),
  })
  const { env, root } = await openArchived({ api })
  typeInto(root, 'Older than (days)', '1'); await settle()
  await env.advance(300)
  assert.deepEqual(requests(env), [{ sort: 'bytes' }, { sort: 'bytes', olderThanDays: 1 }])
  releases[1]()
  await settle()
  assert.deepEqual(listedIds(root), ['new'])
  releases[0]()
  await settle()
  assert.deepEqual(listedIds(root), ['new'], 'the older answer is ignored')
})

test('a "showing N of M" line appears only when the limit truncates the list', async () => {
  const rows = Array.from({ length: 50 }, (_, index) => row(`s${String(index).padStart(4, '0')}`))
  const { root } = await openArchived({ api: pagesApi([pageOf(rows, { total: 120, limit: 50 })]) })
  assert.match(root.text(tabpanel(root)), /Showing 50 of 120 archived sessions\. Narrow the filters to see the rest\./)
  assert.equal(listedIds(root).length, 50)

  const full = await openArchived({ api: pagesApi([pageOf(rows.slice(0, 2))]) })
  assert.match(full.root.text(tabpanel(full.root)), /2 archived sessions/)
  assert.equal(full.root.text(tabpanel(full.root)).includes('Showing'), false)
  const one = await openArchived({ api: pagesApi([pageOf(rows.slice(0, 1))]) })
  assert.match(one.root.text(tabpanel(one.root)), /1 archived session(?!s)/)
  assert.match(one.root.text(tabpanel(one.root)), /Sizes are on-disk bytes and include all children/)
})

// ---------------------------------------------------------------------------
// 2. Grouped rows and their contents.
// ---------------------------------------------------------------------------

const localDay = (ms) => {
  const at = new Date(ms)
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
}

const GROUPED = [
  row('a1b2c3d4-0001', { title: 'Refactor parser', bytes: 14 * MB, childCount: 3, lastActivityAt: NOW - 40 * DAY, ageDays: 40 }),
  row('e5f6a7b8-0002', {
    title: null, workspaceId: null, bytes: 9 * MB, childCount: 0, lastActivityAt: NOW - 60 * DAY, ageDays: 60, blocked: true,
    reasons: [
      { code: 'live', sessionId: 'e5f6a7b8-0002' }, { code: 'kept-descendant', sessionId: 'c0ffee03-0003' },
      { code: 'live', sessionId: 'c0ffee04-0004' },
    ],
  }),
  row('0badcafe-0005', { title: 'Release notes', bytes: 2 * MB, childCount: 1, lastActivityAt: NOW - DAY, ageDays: 1 }),
  row('fade0000-0006', { title: 'Beta work', workspaceId: 'ws-beta', bytes: MB, childCount: 0, lastActivityAt: NOW - 2 * 3_600_000, ageDays: 0 }),
]

test('a short id drops the session- prefix of real ids, so a row without a title and its reasons stay readable', async () => {
  // Real ids are `session-<uuid>`: the first 8 characters of that are just "session-".
  const id = 'session-a292405c-daa9-4d40-a409-d02b5d8f983e'
  const { root } = await openArchived({
    api: pagesApi([pageOf([row(id, { title: null, blocked: true, reasons: [{ code: 'live', sessionId: id }, { code: 'locked', sessionId: id }] })])]),
  })
  const cells = cellsOf(rowNode(root, id)).map(textOf)
  assert.equal(cells[1], 'a292405calpha', 'the short id is the first 8 characters after the prefix')
  assert.equal(findAllIn(rowNode(root, id), (n) => n.props?.title === id).length, 1, 'the full id still rides the title')
  const blocked = findAllIn(rowNode(root, id), (n) => n.props?.className === 'sm-tag' && textOf(n) === 'blocked')[0]
  const description = root.find((n) => n.props?.id === blocked.props['aria-describedby'])
  for (const item of findAllIn(description, (n) => n.type === 'li').map(textOf)) {
    assert.match(item, /\(a292405c\)$/, item)
  }
})

test('rows are grouped by workspace in Host order and show title or short id, workspace, size, children, activity, age and badges', async () => {
  const { root } = await openArchived({ api: pagesApi([pageOf(GROUPED)]) })
  const list = table(root)
  const groups = findAllIn(list, (n) => n.props?.role === 'rowgroup' && n.props['aria-labelledby'])
  assert.deepEqual(groups.map((group) => {
    const heading = findAllIn(group, (n) => n.props?.id === group.props['aria-labelledby'])[0]
    return [textOf(heading), findAllIn(group, (n) => typeof n.props?.['data-id'] === 'string').map((n) => n.props['data-id'])]
  }), [
    ['alpha2 sessions · 16 MB', ['a1b2c3d4-0001', '0badcafe-0005']],
    ['Unassigned1 session · 9 MB', ['e5f6a7b8-0002']],
    ['ws-beta1 session · 1 MB', ['fade0000-0006']],
  ], 'groups in order of first appearance; an unknown workspace shows its id')

  const texts = (id) => cellsOf(rowNode(root, id)).map(textOf)
  assert.deepEqual(texts('a1b2c3d4-0001'), ['', 'Refactor parseralpha', '14 MB', '3', localDay(NOW - 40 * DAY), '40 days', '', 'UnarchivePrune…'])
  assert.deepEqual(texts('e5f6a7b8-0002').slice(1, 6), ['e5f6a7b8Unassigned', '9 MB', '0', localDay(NOW - 60 * DAY), '60 days'])
  assert.equal(texts('0badcafe-0005')[5], '1 day')
  assert.equal(texts('fade0000-0006')[5], 'under a day')
  const title = findAllIn(rowNode(root, 'e5f6a7b8-0002'), (n) => n.props?.title === 'e5f6a7b8-0002')
  assert.equal(title.length, 1, 'the full id rides the title of the short id')

  // The blocked badge: its description lists the localized reasons, once per code, with the member ids.
  const blocked = findAllIn(rowNode(root, 'e5f6a7b8-0002'), (n) => n.props?.className === 'sm-tag' && textOf(n) === 'blocked')[0]
  assert.ok(blocked, 'a blocked badge')
  assert.equal(blocked.props['data-tone'], 'warning')
  const description = root.find((n) => n.props?.id === blocked.props['aria-describedby'])
  assert.ok(description, 'the badge points at its description')
  assert.deepEqual(findAllIn(description, (n) => n.type === 'li').map(textOf), [
    'A session in this tree is loaded in the running host, even if no tab shows it. Close the page that holds it or restart the host, then try again. (e5f6a7b8, c0ffee04)',
    'A descendant is a kept top-level session (a fork). (c0ffee03)',
  ])
  assert.equal(blocked.props.title, findAllIn(description, (n) => n.type === 'li').map(textOf).join(' '))
  assert.equal(findAllIn(rowNode(root, 'a1b2c3d4-0001'), (n) => n.props?.className === 'sm-tag').length, 0, 'a ready row has no badge')
  const prune = buttonIn(rowNode(root, 'e5f6a7b8-0002'), 'Prune…')
  assert.equal(prune.props['aria-describedby'], blocked.props['aria-describedby'], 'Prune… on a blocked row announces the reasons')
})

test('the badge and reasons follow the page locale (zh)', async () => {
  const locale = createLocale({ mode: 'zh' })
  const { root } = await openArchived({ locale, api: pagesApi([pageOf(GROUPED)]) })
  const { zh } = locale.dictionaries(NAMESPACE)
  const blocked = findAllIn(rowNode(root, 'e5f6a7b8-0002'), (n) => n.props?.className === 'sm-tag')[0]
  assert.equal(textOf(blocked), zh['archived.blocked'])
  const description = root.find((n) => n.props?.id === blocked.props['aria-describedby'])
  assert.ok(textOf(description).includes(zh['refusal.live']))
  assert.ok(textOf(description).includes(zh['refusal.kept-descendant']))
  assert.ok(root.text(tabpanel(root)).includes(zh['archived.col.size']))
})

test('an orphan row shows a localized orphan badge with its explanation, offers Prune… but no Unarchive', async () => {
  const rows = [row('0rph4n00-0001', { orphan: true, title: 'Lost child', childCount: 1 }), row('s0001')]
  const { root, env } = await openArchived({ api: pagesApi([pageOf(rows)], { unarchive: async (request) => unarchived(request.ids) }) })
  assert.equal(selectionBar(root), undefined)
  assert.equal(byRole(root, 'group').find((node) => node.props['aria-label'] === 'Selection'), undefined)
  const orphan = rowNode(root, '0rph4n00-0001')
  const badge = findAllIn(orphan, (n) => n.props?.className === 'sm-tag' && textOf(n) === 'orphan')[0]
  assert.ok(badge, 'an orphan badge')
  const hint = root.find((n) => n.props?.id === badge.props['aria-describedby'])
  assert.match(textOf(hint), /archived parent has no stored log/)
  assert.equal(badge.props.title, textOf(hint))
  assert.equal(buttonIn(orphan, 'Unarchive'), undefined, 'an orphan is not archived itself: no Unarchive')
  assert.ok(buttonIn(orphan, 'Prune…'), 'it can be pruned as its own unit')
  assert.ok(buttonIn(rowNode(root, 's0001'), 'Unarchive'))

  // Selected orphans go to Prune but are left out of Unarchive.
  toggle(root, '0rph4n00-0001'); await settle()
  assert.equal(buttonIn(selectionBar(root), 'Unarchive selected').props.disabled, true, 'only orphans selected: nothing to unarchive')
  assert.match(textOf(selectionBar(root)), /Orphans in the selection \(1\) are not unarchived/)
  toggle(root, 's0001'); await settle()
  buttonIn(selectionBar(root), 'Unarchive selected').props.onClick(event())
  assert.equal(confirmStrip(root), undefined, 'one unarchivable session needs no confirmation')
  assert.deepEqual(callsOf(env, 'unarchive').map((call) => call.request), [{ ids: ['s0001'] }])
  await settle()
  buttonIn(selectionBar(root), 'Prune selected…').props.onClick(event())
  await settle()
  assert.deepEqual(plain(root.componentProps('PrunePanel')[0].request), { scope: 'selection', rootIds: ['0rph4n00-0001'] },
    'the unarchived s0001 left the selection; the orphan stays selected for Prune')
})

// ---------------------------------------------------------------------------
// 3. Table roles, aria-sort, keyboard.
// ---------------------------------------------------------------------------

test('the list uses table roles; sortable headers expose aria-sort and are native buttons; the sort goes to the Host', async () => {
  const { root, env } = await openArchived({ api: pagesApi([pageOf(GROUPED)]) })
  const list = table(root)
  assert.ok(list, 'role=table with an accessible name')
  const headers = findAllIn(list, (n) => n.props?.role === 'columnheader')
  assert.equal(headers.length, 8)
  const width = headers.length
  for (const id of ['a1b2c3d4-0001', 'e5f6a7b8-0002', '0badcafe-0005', 'fade0000-0006']) assert.equal(cellsOf(rowNode(root, id)).length, width, `${id}: one cell per column`)
  for (const group of findAllIn(list, (n) => n.props?.role === 'rowgroup' && n.props['aria-labelledby'])) {
    const heading = findAllIn(group, (n) => n.props?.id === group.props['aria-labelledby'])[0]
    assert.equal(heading.props.role, 'cell')
    assert.equal(heading.props['aria-colspan'], width, 'the group heading spans the row')
  }
  assert.deepEqual(ariaSort(root), { Session: 'none', 'Size': 'descending', 'Last activity': 'none' }, 'only sortable headers carry aria-sort')

  for (const caption of ['Session', 'Size', 'Last activity']) {
    const button = sortButton(root, caption)
    assert.equal(button.type, 'button', 'a native button: Enter and Space activate it from the keyboard')
    assert.equal(button.props.type, 'button')
    assert.notEqual(button.props.tabIndex, -1, 'in the tab order')
    assert.equal(button.props.disabled, undefined)
    assert.equal(button.props.onKeyDown, undefined, 'no key handler swallows Enter or Space')
    assert.equal(typeof button.props.title, 'string')
  }
  sortButton(root, 'Last activity').props.onClick(event()); await settle()
  assert.deepEqual(ariaSort(root), { Session: 'none', 'Size': 'none', 'Last activity': 'descending' }, 'newest first')
  await env.advance(0)
  assert.equal(lastRequest(env).sort, 'lastActivityAt')
  sortButton(root, 'Session').props.onClick(event()); await settle()
  await env.advance(0)
  assert.deepEqual(ariaSort(root), { Session: 'ascending', 'Size': 'none', 'Last activity': 'none' }, 'A to Z')
  assert.equal(lastRequest(env).sort, 'title')
  const count = requests(env).length
  sortButton(root, 'Session').props.onClick(event()); await settle()
  await env.advance(0)
  assert.equal(requests(env).length, count, 'the active sort again sends nothing (the Host owns the direction)')
  assert.deepEqual(requests(env).map((request) => request.sort), ['bytes', 'lastActivityAt', 'title'])
  for (const sort of ARCHIVED_SORTS) assert.ok(requests(env).some((request) => request.sort === sort))
})

// ---------------------------------------------------------------------------
// 4-6. Row actions, selection, confirmation, failures, refetch.
// ---------------------------------------------------------------------------

test('row Unarchive calls unarchive({ ids: [id] }) without a confirmation, reports the result and refetches', async () => {
  const api = createApi({ unarchive: async (request) => unarchived(request.ids) })
  const { root, env } = await openArchived({ api })
  const button = buttonIn(rowNode(root, 's0001'), 'Unarchive')
  assert.equal(button.props['aria-label'], 'Unarchive Session s0001')
  button.props.onClick(event())
  button.props.onClick(event())
  assert.deepEqual(callsOf(env, 'unarchive').map((call) => call.request), [{ ids: ['s0001'] }], 'one call, no confirmation, a double click is one call')
  assert.equal(confirmStrip(root), undefined)
  await settle()
  assert.match(root.text(notice(root)), /Unarchived 1 session\. It is back in the session list\./)
  assert.equal(notice(root).props.role, 'status')
  assert.ok(root.focused.includes('sm-arch-notice'), 'focus moves to the result, since the row leaves the list')
  await env.advance(0)
  assert.deepEqual(env.calls.slice(-3).map((call) => call.method).sort(), ['archived', 'overview', 'unarchive'].sort())
  assert.deepEqual(callsOf(env, 'overview').at(-1).request, { fresh: true })
  assert.equal(requests(env).length, 2, 'the list is read again once')
  buttonIn(notice(root), 'Dismiss').props.onClick(event()); await settle()
  assert.equal(notice(root), undefined)
  assert.deepEqual(mutatingCalls(env).map((call) => call.method), ['unarchive'])
  for (const call of env.calls) assertRequest(call.method, call.request)
})

test('multi-select: a selection bar; Unarchive selected asks once for more than one session and shows failures per id', async () => {
  let release = null
  const api = createApi({
    unarchive: (request) => new Promise((resolve) => {
      release = () => resolve(request.ids.length > 1 ? unarchived([request.ids[0]], [{ id: request.ids[1], code: 'live' }]) : unarchived(request.ids))
    }),
  })
  const { root, env } = await openArchived({ api })
  assert.equal(selectionBar(root), undefined, 'no bar without a selection')
  toggle(root, 's0004'); await settle()
  toggle(root, 's0001'); await settle()
  assert.equal(selectionBar(root).props['aria-label'], 'Selection')
  assert.equal(checkboxOf(root, 's0001').props.checked, true)
  assert.equal(rowNode(root, 's0001').props['data-selected'], 'true')
  assert.match(textOf(selectionBar(root)), /2 selected · 13 MB/)
  assert.ok(buttonIn(selectionBar(root), 'Prune selected…'))

  // One confirmation; Cancel sends nothing and returns focus.
  buttonIn(selectionBar(root), 'Unarchive selected').props.onClick(event()); await settle()
  assert.deepEqual(callsOf(env, 'unarchive'), [], 'nothing is sent before the confirmation')
  assert.match(textOf(confirmStrip(root)), /Unarchive 2 sessions\?/)
  assert.deepEqual(root.focused.slice(-1), ['sm-arch-confirm-cancel'], 'focus moves to Cancel')
  buttonIn(confirmStrip(root), 'Cancel').props.onClick(event()); await settle()
  assert.equal(confirmStrip(root), undefined)
  assert.deepEqual(root.focused.slice(-1), ['sm-arch-unarchive-selected'], 'focus returns to the control that asked')
  // Escape cancels too, and stops there.
  buttonIn(selectionBar(root), 'Unarchive selected').props.onClick(event()); await settle()
  const escape = event({ key: 'Escape' })
  confirmStrip(root).props.onKeyDown(escape); await settle()
  assert.equal(confirmStrip(root), undefined)
  assert.equal(escape.defaultPrevented, true)
  assert.equal(escape.propagationStopped, true)
  assert.deepEqual(callsOf(env, 'unarchive'), [])

  buttonIn(selectionBar(root), 'Unarchive selected').props.onClick(event()); await settle()
  const confirm = buttonIn(confirmStrip(root), 'Unarchive 2')
  confirm.props.onClick(event())
  confirm.props.onClick(event())
  assert.deepEqual(callsOf(env, 'unarchive').map((call) => call.request), [{ ids: ['s0001', 's0004'] }], 'one call with both ids, in list order')
  await settle()
  assert.match(root.text(byRole(root, 'status').find((node) => /Unarchiving/.test(textOf(node)))), /Unarchiving 2 sessions…/)
  assert.equal(confirmStrip(root), undefined)
  assert.equal(buttonIn(selectionBar(root), 'Unarchive selected').props.disabled, true, 'no second mutation while one runs')
  assert.equal(buttonIn(rowNode(root, 's0001'), 'Unarchive').props.disabled, true)
  release()
  await settle()
  const result = notice(root)
  assert.equal(result.props.role, 'alert')
  assert.match(textOf(result), /Unarchived 1 session/)
  assert.match(textOf(result), /Not unarchived \(1\):/)
  assert.deepEqual(findAllIn(result, (n) => n.type === 'li').map(textOf), ['s0004: A session in this tree is loaded in the running host, even if no tab shows it. Close the page that holds it or restart the host, then try again.'])
  assert.equal(findAllIn(result, (n) => n.type === 'li')[0].props.title, 's0004')
  assert.deepEqual(plain(root.componentProps('ArchivedTab')[0].shell.archivedView.selection), ['s0004'], 'the failed id stays selected for a retry')
  await env.advance(0)
  assert.equal(requests(env).length, 2, 'refetched once')

  // Exactly one selected: no confirmation.
  buttonIn(selectionBar(root), 'Unarchive selected').props.onClick(event())
  assert.equal(confirmStrip(root), undefined)
  assert.deepEqual(callsOf(env, 'unarchive').at(-1).request, { ids: ['s0004'] })
  release()
  await settle()
  assert.match(textOf(notice(root)), /Unarchived 1 session/)
  assert.deepEqual(mutatingCalls(env).map((call) => call.method), ['unarchive', 'unarchive'])
  for (const call of env.calls) assertRequest(call.method, call.request)
})

test('the selection is kept by id across refreshes and drops ids no longer listed; select all; it survives a tab switch', async () => {
  const first = pageOf([row('s0001'), row('s0002'), row('s0003')])
  const second = pageOf([row('s0003'), row('s0001'), row('s0009')])
  const { root, env } = await openArchived({ api: pagesApi([first, first, second]) })
  toggle(root, 's0001'); await settle()
  toggle(root, 's0002'); await settle()
  const view = () => plain(root.componentProps('ArchivedTab')[0].shell.archivedView.selection)
  assert.deepEqual(view(), ['s0001', 's0002'])

  // A tab switch keeps the plugin-level selection; reopening reads the list again.
  tabs(root)[0].props.onClick(event()); await settle()
  tabs(root)[1].props.onClick(event()); await settle()
  assert.deepEqual(view(), ['s0001', 's0002'])
  await env.advance(0)
  assert.equal(requests(env).length, 2)
  assert.deepEqual(view(), ['s0001', 's0002'], 'every selected id is still listed')

  // The header Refresh reads the list again; s0002 is gone and leaves the selection.
  root.findAll((node) => node.type === 'button' && textOf(node) === 'Refresh')[0].props.onClick(event()); await settle()
  await env.advance(0)
  assert.equal(requests(env).length, 3)
  assert.deepEqual(listedIds(root), ['s0003', 's0001', 's0009'])
  assert.deepEqual(view(), ['s0001'])
  assert.equal(checkboxOf(root, 's0001').props.checked, true)
  assert.equal(checkboxOf(root, 's0009').props.checked, false)

  selectAll(root); await settle()
  assert.deepEqual(view(), ['s0003', 's0001', 's0009'], 'select all takes every listed row in list order')
  selectAll(root); await settle()
  assert.deepEqual(view(), [], 'a second click clears')
  toggle(root, 's0009'); await settle()
  buttonIn(selectionBar(root), 'Clear selection').props.onClick(event()); await settle()
  assert.deepEqual(view(), [])
  assert.deepEqual(mutatingCalls(env), [])
})

test(`the selection is capped at ${MAX_IDS_PER_REQUEST} ids, the per-request limit of the contract`, async () => {
  const rows = Array.from({ length: MAX_IDS_PER_REQUEST + 5 }, (_, index) => row(`r${String(index).padStart(5, '0')}`))
  const { root } = await openArchived({ api: pagesApi([pageOf(rows)]) })
  selectAll(root); await settle()
  const selection = plain(root.componentProps('ArchivedTab')[0].shell.archivedView.selection)
  assert.equal(selection.length, MAX_IDS_PER_REQUEST)
  assert.equal(checkboxOf(root, rows.at(-1).id).props.disabled, true, 'no more rows can be ticked')
  assert.match(textOf(selectionBar(root)), /At most 1\D?000 sessions can be selected at once/)
  buttonIn(selectionBar(root), 'Prune selected…').props.onClick(event()); await settle()
  const request = plain(root.componentProps('PrunePanel')[0].request)
  assertRequest('plan', request)
  assert.equal(request.rootIds.length, MAX_IDS_PER_REQUEST)
})

test('Prune… hands exactly the chosen root ids to the prune flow; the tab itself never calls plan, apply, restore or purge', async () => {
  const { root, env } = await openArchived({ api: pagesApi([pageOf(GROUPED)]) })
  const before = env.calls.length
  const prune = buttonIn(rowNode(root, 'a1b2c3d4-0001'), 'Prune…')
  assert.equal(prune.props['aria-label'], 'Prune Refactor parser…')
  prune.props.onClick(event())
  assert.equal(env.calls.length, before, 'the click itself sends nothing')
  await settle()
  const opened = plain(root.componentProps('PrunePanel')[0].request)
  assert.deepEqual(opened, { scope: 'selection', rootIds: ['a1b2c3d4-0001'] })
  assertRequest('plan', opened)
  root.componentProps('PrunePanel')[0].onClose()
  await settle()

  toggle(root, 'fade0000-0006'); await settle()
  toggle(root, 'e5f6a7b8-0002'); await settle()
  toggle(root, 'a1b2c3d4-0001'); await settle()
  const count = env.calls.length
  buttonIn(selectionBar(root), 'Prune selected…').props.onClick(event())
  assert.equal(env.calls.length, count)
  await settle()
  const selected = plain(root.componentProps('PrunePanel')[0].request)
  assert.deepEqual(selected, { scope: 'selection', rootIds: ['a1b2c3d4-0001', 'e5f6a7b8-0002', 'fade0000-0006'] }, 'exactly the selection, in list order')
  assertRequest('plan', selected)
  assert.deepEqual(plain(root.componentProps('ArchivedTab')[0].shell.archivedView.selection).sort(), selected.rootIds.slice().sort(),
    'the prune flow can read the live selection from the shell')
  assert.deepEqual(env.calls.slice(0, count).filter((call) => ['plan', 'apply', 'restore', 'purge'].includes(call.method)), [],
    'nothing before the hand-off called plan, apply, restore or purge')
  assert.deepEqual(mutatingCalls(env), [], 'zero mutating calls')
})

test('read-only (capabilities.prune false): a notice, Prune… disabled, Unarchive still available', async () => {
  const value = overviewFixture()
  value.capabilities = { prune: false, reason: 'sessions-manager/unsupported-platform' }
  const { root, env } = await openArchived({ api: createApi({ overview: async () => ok(value) }) })
  const note = byRole(root, 'note').find((node) => /Read-only/.test(textOf(node)))
  assert.match(textOf(note), /Read-only: pruning is off\. Unarchive still works\. Pruning needs the session lock check/)
  assert.equal(buttonIn(rowNode(root, 's0001'), 'Prune…').props.disabled, true)
  assert.equal(buttonIn(rowNode(root, 's0001'), 'Unarchive').props.disabled, undefined)
  toggle(root, 's0001'); await settle()
  assert.equal(buttonIn(selectionBar(root), 'Prune selected…').props.disabled, true)
  buttonIn(rowNode(root, 's0001'), 'Prune…').props.onClick(event()); await settle()
  assert.equal(root.componentProps('PrunePanel').length, 0, 'a disabled hand-off never opens the flow')
  assert.deepEqual(mutatingCalls(env), [])
})

test('Unarchive failures: a Host error is shown with its localized text and detail; a malformed answer is reported; both refetch', async () => {
  let mode = 'busy'
  const api = createApi({
    unarchive: async () => {
      if (mode === 'busy') return { ok: false, error: { code: 'sessions-manager/busy', message: 'trash lock held' } }
      if (mode === 'throw') throw new Error('socket closed')
      return ok({ nope: true })
    },
  })
  const { root, env } = await openArchived({ api })
  buttonIn(rowNode(root, 's0001'), 'Unarchive').props.onClick(event()); await settle()
  let result = notice(root)
  assert.equal(result.props.role, 'alert')
  assert.match(textOf(result), /Unarchive failed\.Another change is in progress\. Try again in a moment\.Host message: trash lock held/)
  await env.advance(0)
  assert.equal(requests(env).length, 2, 'a Host refusal refetches')

  mode = 'malformed'
  buttonIn(rowNode(root, 's0001'), 'Unarchive').props.onClick(event()); await settle()
  result = notice(root)
  assert.match(textOf(result), /cannot read\. The list was read again/)
  await env.advance(0)
  assert.equal(requests(env).length, 3)

  mode = 'throw'
  buttonIn(rowNode(root, 's0001'), 'Unarchive').props.onClick(event()); await settle()
  assert.match(textOf(notice(root)), /The Host call failed\.Host message: socket closed/)
  assert.equal(buttonIn(rowNode(root, 's0001'), 'Unarchive').props.disabled, undefined, 'controls come back after a failure')
  assert.equal(env.consoleErrors.length, 0)
})

// ---------------------------------------------------------------------------
// 6. States.
// ---------------------------------------------------------------------------

test('loading, empty, no-match, error with retry, stale error, malformed and connecting states', async () => {
  // Loading: the request is in flight.
  let answer
  const slow = await openArchived({ api: createApi({ archived: () => new Promise((resolve) => { answer = resolve }) }) })
  assert.match(slow.root.text(byRole(slow.root, 'status').find((node) => /Reading/.test(textOf(node)))), /Reading archived sessions…/)
  answer(ok(archivedPageFixture()))
  await settle()
  assert.deepEqual(listedIds(slow.root), ['s0001', 's0004'])

  // A refetch keeps the rows and marks the list busy.
  let later = null
  const busy = await openArchived({
    api: createApi({ archived: () => (later === null ? Promise.resolve(ok(archivedPageFixture())) : new Promise((resolve) => { later = resolve })) }),
  })
  later = () => {}
  root_refresh(busy.root); await settle()
  await busy.env.advance(0)
  assert.equal(table(busy.root).props['aria-busy'], true)
  assert.match(busy.root.text(tabpanel(busy.root)), /Updating…/)
  later(ok(archivedPageFixture()))
  await settle()
  assert.equal(table(busy.root).props['aria-busy'], undefined)

  // Empty store and no match.
  const empty = await openArchived({ api: pagesApi([pageOf([])]) })
  assert.match(empty.root.text(tabpanel(empty.root)), /No archived sessions\. Sessions you archive in the sidebar appear here\./)
  assert.equal(table(empty.root), undefined)
  typeInto(empty.root, 'Search', 'zzz'); await settle()
  await empty.env.advance(300)
  assert.match(empty.root.text(tabpanel(empty.root)), /No archived session matches the filters\./)
  assert.ok(buttonIn(tabpanel(empty.root), 'Clear filters'))

  // Error without a page: an alert with the localized code, the detail and a retry.
  let fail = true
  const broken = await openArchived({
    api: createApi({ archived: async () => (fail ? { ok: false, error: { code: 'sessions-manager/forbidden', message: 'agent caller' } } : ok(archivedPageFixture())) }),
  })
  const alert = byRole(broken.root, 'alert')[0]
  assert.match(textOf(alert), /Could not read the archived sessions\.Only the owner can do this, from the Sessions page\.Host message: agent caller/)
  fail = false
  buttonIn(alert, 'Try again').props.onClick(event()); await settle()
  await broken.env.advance(0)
  assert.equal(byRole(broken.root, 'alert').length, 0)
  assert.deepEqual(listedIds(broken.root), ['s0001', 's0004'])

  // A failed refresh keeps the rows and says they are stale.
  fail = true
  root_refresh(broken.root); await settle()
  await broken.env.advance(0)
  assert.match(textOf(byRole(broken.root, 'alert')[0]), /The last refresh failed\. The list below is from the previous read\./)
  assert.deepEqual(listedIds(broken.root), ['s0001', 's0004'])

  // A malformed page and a rejecting call never crash the tab.
  const malformed = await openArchived({ api: createApi({ archived: async () => ok({ rows: 'nope' }) }) })
  assert.match(textOf(byRole(malformed.root, 'alert')[0]), /The Host sent a list that this page cannot read/)
  const rejecting = await openArchived({ api: createApi({ archived: async () => { throw new Error('socket closed') } }) })
  assert.match(textOf(byRole(rejecting.root, 'alert')[0]), /The Host call failed\.Host message: socket closed/)

  // Connecting: no request before the namespace appears.
  let release
  const env = loadClient({ locale: createLocale(), mount: () => new Promise((resolve) => { release = resolve }) })
  const root = env.renderPage()
  tabs(root)[1].props.onClick(event()); await settle()
  await env.advance(0)
  assert.match(root.text(tabpanel(root)), /Connecting to the Host/)
  assert.deepEqual(env.calls, [])
  release(() => {})
  await settle()
  await env.advance(0)
  assert.deepEqual(requests(env), [{ sort: 'bytes' }])
})

function root_refresh(root) {
  root.findAll((node) => node.type === 'button' && textOf(node) === 'Refresh')[0].props.onClick(event())
}

test('unmount clears the request timer and ignores a late answer; a timed overview refresh also rereads the list', async () => {
  const { root, env } = await openArchived()
  typeInto(root, 'Search', 'abc'); await settle()
  assert.equal(env.timers.count, 1)
  root.unmount()
  assert.equal(env.timers.count, 0)

  let answer
  const slow = await openArchived({ api: createApi({ archived: () => new Promise((resolve) => { answer = resolve }) }) })
  slow.root.unmount()
  answer(ok(archivedPageFixture()))
  await settle()
  assert.equal(slow.root.stats.setAfterUnmount, 0)

  const value = overviewFixture()
  value.config.refreshMs = 30_000
  const timed = await openArchived({ api: createApi({ overview: async () => ok(value) }) })
  toggle(timed.root, 's0001'); await settle()
  await timed.env.advance(30_000)
  await timed.env.advance(0)
  assert.equal(requests(timed.env).length, 2, 'the timed refresh rereads the list')
  assert.deepEqual(plain(timed.root.componentProps('ArchivedTab')[0].shell.archivedView.selection), ['s0001'], 'and keeps the selection')
  assert.deepEqual(mutatingCalls(timed.env), [])
})

// ---------------------------------------------------------------------------
// Locale: every Archived string is in both tables; a marker locale shows no literal.
// ---------------------------------------------------------------------------

const TEXT_PROPS = ['aria-label', 'title', 'placeholder', 'alt', 'aria-description', 'aria-valuetext', 'label']
function visibleStrings(root) {
  const out = []
  const walk = (node) => {
    if (typeof node === 'string') { out.push(node); return }
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node === null || typeof node !== 'object') return
    for (const key of TEXT_PROPS) if (typeof node.props?.[key] === 'string') out.push(node.props[key])
    for (const child of node.children ?? []) walk(child)
  }
  walk(root.tree)
  return out
}
function assertNoLiterals(root, data) {
  const allowed = [...data].filter(Boolean).sort((a, b) => b.length - a.length)
  for (const text of visibleStrings(root)) {
    let rest = text.replace(/⟦[^⟧]*⟧/g, '')
    for (const value of allowed) rest = rest.split(value).join('')
    assert.match(rest, /^[\s\d.,:%·()/\-–—+]*$/u, `unlocalized literal in ${JSON.stringify(text)}`)
  }
}

test('every Archived tab key used by the client exists in both locale tables with the same placeholders', () => {
  const env = loadClient({ locale: createLocale() })
  const { en, zh } = env.locale.dictionaries(NAMESPACE)
  const used = new Set([...CLIENT_SOURCE.matchAll(/'((?:archived|unarchive)\.[\w.-]+)'/g)].map((match) => match[1]))
  for (const column of ['session', 'size', 'children', 'activity', 'age', 'status', 'actions']) used.add(`archived.col.${column}`)
  for (const sort of ARCHIVED_SORTS) used.add(`archived.sort.${sort}`)
  assert.ok(used.size > 50, `${used.size} keys`)
  const placeholders = (text) => (text.match(/\{\w+\}/g) ?? []).sort()
  for (const key of used) {
    assert.ok(Object.hasOwn(en, key), `en ${key}`)
    assert.ok(Object.hasOwn(zh, key), `zh ${key}`)
    assert.notEqual(zh[key], en[key], `zh ${key} is translated`)
    assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), key)
  }
  for (const code of REFUSAL_CODES) assert.ok(Object.hasOwn(zh, `refusal.${code}`), `zh refusal.${code}`)
  assert.equal(Object.hasOwn(en, 'placeholder.archived'), false, 'the placeholder text is gone')
})

test('a marker locale shows no unlocalized literal in the Archived tab: rows, badges, selection, confirmation, notices, errors', async () => {
  const rows = [...GROUPED, row('0rph4n00-0007', { orphan: true, title: null, workspaceId: 'ws-alpha' })]
  const data = [
    ...rows.flatMap((entry) => [entry.id, entry.id.slice(0, 8), entry.title, entry.workspaceId]),
    'alpha', '/fake/store', '/fake/work/alpha', '2026-09', 's0007', 's0008', 'Session s0007', 'trash lock held',
    ...archivedPageFixture().rows.flatMap((entry) => [entry.id, entry.title, ...entry.reasons.map((reason) => reason.sessionId)]),
    ...[...rows, ...archivedPageFixture().rows].map((entry) => localDay(entry.lastActivityAt)),
  ]
  const api = createApi({
    archived: async () => ok(pageOf(rows, { total: 99 })),
    unarchive: async (request) => (request.ids.length > 1
      ? unarchived([request.ids[0]], [{ id: request.ids[1], code: 'live' }])
      : { ok: false, error: { code: 'sessions-manager/busy', message: 'trash lock held' } }),
  })
  const { root, env } = await openArchived({ locale: createLocale({ mode: 'marker' }), api })
  assertNoLiterals(root, data)
  typeInto(root, '⟦archived.filter.olderThan⟧', '-1'); await settle()
  field(root, '⟦archived.filter.workspace⟧').props.onChange(event({ target: { value: 'ws:ws-alpha' } })); await settle()
  await env.advance(300)
  assertNoLiterals(root, data)
  toggle(root, 'a1b2c3d4-0001'); await settle()
  toggle(root, '0badcafe-0005'); await settle()
  toggle(root, '0rph4n00-0007'); await settle()
  buttonIn(selectionBar(root), '⟦archived.unarchiveSelected⟧').props.onClick(event()); await settle()
  assertNoLiterals(root, data)
  buttonIn(confirmStrip(root), '⟦archived.confirm.ok⟧').props.onClick(event())
  assertNoLiterals(root, data)
  await settle()
  assertNoLiterals(root, data)
  buttonIn(rowNode(root, 'e5f6a7b8-0002'), '⟦archived.unarchive⟧').props.onClick(event()); await settle()
  assertNoLiterals(root, data)
  assert.ok(buttonsIn(root.tree, '⟦archived.prune⟧').length > 0)

  for (const options of [
    { api: createApi({ archived: async () => ({ ok: false, error: { code: 'sessions-manager/invalid-request', message: 'trash lock held' } }) }) },
    { api: createApi({ archived: async () => ok(pageOf([])) }) },
    { api: createApi({ archived: async () => ok({ rows: 1 }) }) },
    { api: createApi({ overview: async () => ok({ ...overviewFixture(), capabilities: { prune: false, reason: 'sessions-manager/trash-unusable' } }) }) },
  ]) {
    const next = await openArchived({ locale: createLocale({ mode: 'marker' }), ...options })
    assertNoLiterals(next.root, data)
  }
})
