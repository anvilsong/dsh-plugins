// Client shell tests for dsh-plugin-sessions: the loader entry, the placement
// adapter (main page + sidebar row), the single Remote mount, the locale
// tables, the stylesheet, the tabs and the Overview tab. The client runs in a
// vm context with a fake React (test/helpers/client-harness.mjs); nothing here
// touches the real DSH home or session store.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  ERROR_CODES, METHOD_NAMES, METHODS, NAMESPACE, PACKAGE, REFUSAL_CODES, assertOverview, assertRequest,
} from '../src/contract.js'
import { overviewFixture } from './helpers/fixtures.mjs'
import {
  CLIENT_SOURCE, NOW, byClass, byRole, createApi, createLocale, event, loadClient, plain, settle, textOf,
} from './helpers/client-harness.mjs'

const MB = 1024 * 1024
const DAY = 86_400_000
const MUTATING = METHOD_NAMES.filter((name) => METHODS[name].mutates)

/** Load, run apply, let the async Remote mount settle. */
async function ready(options = {}) {
  const env = loadClient({ locale: createLocale(), ...options })
  await settle()
  return env
}

/** Render the page and let its first fetch settle. */
async function page(env, props) {
  const root = env.renderPage(props)
  await settle()
  return root
}

const tabs = (root) => byRole(root, 'tab')
const selectedTab = (root) => tabs(root).find((node) => node.props['aria-selected'] === true)
const buttonByText = (root, text) => root.findAll((node) => node.type === 'button' && textOf(node) === text)[0]
const card = (root, id) => root.find((node) => node.props?.['data-card'] === id)
const callsOf = (env, method) => env.calls.filter((call) => call.method === method)
const mutatingCalls = (env) => env.calls.filter((call) => MUTATING.includes(call.method))

test('loader entry: one factory under the package id, React only, inject as docs/placement.md states', () => {
  const env = loadClient({ locale: createLocale() })
  assert.equal(env.id, PACKAGE)
  assert.equal(env.applyError, null)
  assert.deepEqual(env.requires, ['react'])
  assert.throws(() => env.require('@deepseek-ai/dsh-client-ui-primitives'), /may require only 'react'/)
  assert.deepEqual(Object.keys(env.result).sort(), ['apply', 'inject'])
  assert.deepEqual(plain(env.result.inject), ['slots', 'remote'])
  // The only require call in the source is require('react').
  assert.deepEqual(CLIENT_SOURCE.match(/require\(\s*['"][^'"]*['"]\s*\)/g), ["require('react')"])
  assert.match(CLIENT_SOURCE, /^window\.__ModuleLoader__\.load\(\{/m)

  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(pkg.dsh.client, {
    platform: 'web',
    inject: ['@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-api-gateway'],
  })
})

test('apply returns nothing (never a promise) and registers the page before the sidebar row, each inside slots.inject', () => {
  const env = loadClient({ locale: createLocale() })
  assert.equal(env.applyReturn, undefined)
  assert.deepEqual(env.injects.map((entry) => entry.name), ['main', 'sidebar.panellist'])
  assert.equal(env.registrations.length, 2)
  for (const entry of env.injects) assert.equal(typeof entry.returned, 'function', `${entry.name}: the inject callback returns the registration disposer`)

  const main = env.registration('main')
  assert.deepEqual(plain(main.definition), { name: 'main', key: 'sessions-manager', locale: NAMESPACE })
  const row = env.registration('sidebar.panellist')
  const { label, ...rest } = row.definition
  assert.deepEqual(plain(rest), { name: 'sidebar.panellist', id: 'sessions-manager', order: 20, locale: NAMESPACE })
  assert.equal(typeof label, 'function', 'the label is a thunk the sidebar re-resolves on a locale switch')
  assert.equal(label(), 'Sessions')
  env.locale.mode = 'zh'
  assert.equal(label(), '会话管理')

  // The row component is the icon: a glyph only, sized by the sidebar.
  const icon = row.component({ size: 18, active: true })
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.width, 18)
  assert.equal(icon.props.height, 18)
  assert.equal(icon.props['aria-hidden'], 'true')
  assert.equal(icon.props.stroke, 'currentColor')
})

test('without a locale service the registrations carry no locale key and English is the fallback', async () => {
  const env = await ready({ locale: undefined })
  assert.equal(env.applyError, null)
  assert.equal('locale' in env.registration('main').definition, false)
  assert.equal('locale' in env.registration('sidebar.panellist').definition, false)
  assert.equal(env.registration('sidebar.panellist').definition.label(), 'Sessions')
  const root = await page(env)
  assert.equal(root.find((node) => node.type === 'h1').children.join(''), 'Sessions')
  assert.ok(buttonByText(root, 'Refresh'))
  assert.equal(card(root, 'total') !== undefined, true)
})

test('unload disposes the stylesheet, the dictionaries, both registrations and the Remote mount', async () => {
  const env = await ready()
  assert.deepEqual(env.effects.map((entry) => entry.label), ['sessions: stylesheet', 'sessions: dictionaries', 'sessions: mount remote'])
  assert.equal(env.document.head.children.length, 1)
  const style = env.document.head.children[0]
  assert.equal(style.tagName, 'STYLE')
  assert.equal(style.id, 'dsh-plugin-sessions-styles')
  assert.equal(env.document.domWrites, 1, 'the only DOM write outside the component is one <style> element')
  assert.equal(env.locale.registered.length, 1)
  assert.equal(env.locale.registered[0].ns, NAMESPACE)
  assert.equal(env.mounts.length, 1)

  const root = await page(env)
  assert.equal(env.document.listenerCount('visibilitychange'), 1)
  await env.unload()
  assert.equal(root.unmounted, true)
  assert.equal(env.document.head.children.length, 0)
  assert.equal(env.locale.disposed, 1)
  assert.deepEqual(env.registrations.map((entry) => entry.disposed), [true, true])
  assert.equal(env.mountDisposals, 1)
  assert.equal(env.document.listenerCount('visibilitychange'), 0)
  assert.equal(env.timers.count, 0)
})

test('a second stylesheet is never added and a foreign element with the id is left alone', async () => {
  const env = loadClient({ locale: createLocale(), apply: false })
  const foreign = env.document.createElement('style')
  foreign.id = 'dsh-plugin-sessions-styles'
  env.document.head.appendChild(foreign)
  env.apply()
  await settle()
  assert.equal(env.document.head.children.length, 1)
  await env.unload()
  assert.equal(env.document.head.children.length, 1, 'the cleanup removes only the element this plugin added')
})

test('exactly one $mount for the package, with one descriptor per contract method', async () => {
  const env = await ready()
  assert.equal(env.mounts.length, 1)
  const contribution = env.mounts[0]
  assert.equal(contribution.package, PACKAGE)
  assert.deepEqual(plain(contribution.descriptors.map((descriptor) => descriptor.method)), [...METHOD_NAMES])
  for (const descriptor of contribution.descriptors) {
    const spec = METHODS[descriptor.method]
    assert.ok(spec, descriptor.method)
    const { codec, ...parameter } = descriptor.parameters[0]
    assert.deepEqual(plain({ ...descriptor, parameters: undefined }), {
      id: `${PACKAGE}#${NAMESPACE}/${descriptor.method}`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: descriptor.method,
      invocation: { kind: 'direct' },
      result: { mode: 'src-json' },
    })
    assert.equal('mode' in descriptor, false, `${descriptor.method} is unary`)
    assert.deepEqual(plain(descriptor.parameters.map((entry) => entry.name)), [...spec.params])
    assert.deepEqual(plain(parameter), { name: 'request', wire: 'request', source: 'json' })
    assert.equal(codec.mode, 'strict')
    assert.equal(typeof codec.typeSymbol, 'string')
    const value = { scope: 'all' }
    assert.equal(codec.create().parse(value), value, 'the codec passes JSON through; the Host validates')
  }
  assert.deepEqual(env.gets.filter((key) => key.startsWith('remote.')), [`remote.${NAMESPACE}`])
})

for (const [name, options, detail] of [
  ['a rejecting $mount', { mount: async () => { throw new Error('gateway down') } }, 'gateway down'],
  ['a $mount that throws synchronously', { mount: () => { throw new Error('mount exploded') } }, 'mount exploded'],
  ['a missing ctx.remote', { noRemote: true }, null],
]) {
  test(`apply never throws or rejects: ${name} renders an inline error`, async () => {
    const env = await ready(options)
    assert.equal(env.applyError, null)
    assert.equal(env.applyReturn, undefined)
    assert.deepEqual(env.effectErrors, [])
    assert.equal(env.registrations.length, 2, 'the page still registers')
    const root = await page(env)
    const alert = byRole(root, 'alert')[0]
    assert.ok(alert, 'an inline error')
    assert.match(root.text(alert), /Could not connect the Sessions service/)
    if (detail) assert.match(root.text(alert), new RegExp(detail))
    assert.deepEqual(env.calls, [])
    assert.equal(buttonByText(root, 'Refresh').props.disabled, true)
    await env.unload()
  })
}

test('a mount that resolves without the namespace shows the unavailable state', async () => {
  const env = await ready({ namespace: false })
  assert.equal(env.applyError, null)
  const root = await page(env)
  assert.match(root.text(byRole(root, 'alert')[0]), /The Sessions service is not available/)
  assert.deepEqual(env.calls, [])
})

test('a throwing locale service, ctx.get or slots.inject never escapes apply', async () => {
  for (const options of [
    { locale: createLocale({ registerThrows: true }) },
    { locale: createLocale({ bindThrows: true }) },
    { getThrows: ['locale', `remote.${NAMESPACE}`] },
    { injectThrows: true },
  ]) {
    const env = await ready(options)
    assert.equal(env.applyError, null, JSON.stringify(Object.keys(options)))
    assert.deepEqual(env.effectErrors, [])
  }
  const env = await ready({ getThrows: [`remote.${NAMESPACE}`] })
  const root = await page(env)
  assert.match(root.text(byRole(root, 'alert')[0]), /not available/)
})

test('locale tables: en and zh have the same keys and placeholders and cover every refusal and error code', () => {
  const env = loadClient({ locale: createLocale() })
  const { en, zh } = env.locale.dictionaries(NAMESPACE)
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  const placeholders = (text) => (text.match(/\{\w+\}/g) ?? []).sort()
  for (const key of Object.keys(en)) {
    assert.ok(typeof en[key] === 'string' && en[key].length > 0, `en ${key}`)
    assert.ok(typeof zh[key] === 'string' && zh[key].length > 0, `zh ${key}`)
    assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), `placeholders of ${key}`)
    assert.doesNotMatch(en[key] + zh[key], /[\u200B\uFEFF]/, `${key} holds a zero-width space or BOM`)
  }
  for (const code of REFUSAL_CODES) assert.ok(Object.hasOwn(en, `refusal.${code}`), `refusal.${code}`)
  for (const code of ERROR_CODES) assert.ok(Object.hasOwn(en, `error.${code.slice('sessions-manager/'.length)}`), `error for ${code}`)
  assert.equal(en.panel, 'Sessions')
  assert.equal(en['page.title'], 'Sessions')
})

// Visible text: text nodes plus the attributes a user or a screen reader gets.
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

const dataStrings = (overview) => [
  overview.storeDir,
  ...overview.workspaces.flatMap((ws) => [ws.name, ws.path, ws.folder, ws.id]),
  ...overview.largest.flatMap((row) => [row.title, row.id, row.id.slice(0, 8)]),
]

test('a marker locale shows no unlocalized literal in any state, tab or label', async () => {
  const fixture = overviewFixture()
  const readOnly = overviewFixture()
  readOnly.capabilities = { prune: false, reason: 'sessions-manager/unsupported-platform' }
  const empty = { ...overviewFixture(), workspaces: [], largest: [] }
  for (const key of Object.keys(empty.totals)) empty.totals[key] = 0
  for (const value of [fixture, readOnly, empty]) assertOverview(value)

  for (const [value, props] of [[fixture, {}], [readOnly, {}], [empty, {}], [fixture, { marker: true }]]) {
    const locale = createLocale({ mode: 'marker' })
    const env = await ready({ locale, api: createApi({ overview: async () => ({ ok: true, value }) }) })
    // `props.t` is the renderer's live seat; it must win over the closure t.
    const root = await page(env, props.marker ? { t: (key) => `⟦${key}⟧` } : {})
    assertNoLiterals(root, dataStrings(value))
    for (const tab of tabs(root)) {
      tab.props.onClick(event())
      await settle()
      assertNoLiterals(root, dataStrings(value))
    }
    selectedTab(root)
    assert.match(env.registration('sidebar.panellist').definition.label(), /^⟦panel⟧$/)
  }

  // Errors, the mount failure and the prune hand-off.
  for (const options of [
    { api: createApi({ overview: async () => ({ ok: false, error: { code: 'sessions-manager/forbidden', message: 'agent caller' } }) }) },
    { mount: async () => { throw new Error('gateway down') } },
    { namespace: false },
  ]) {
    const env = await ready({ locale: createLocale({ mode: 'marker' }), ...options })
    const root = await page(env)
    assertNoLiterals(root, ['agent caller', 'gateway down'])
  }
  const env = await ready({ locale: createLocale({ mode: 'marker' }) })
  const root = await page(env)
  buttonByText(root, '⟦card.reclaim.review⟧').props.onClick(event())
  await settle()
  assert.ok(root.find((node) => node.props?.['data-placeholder'] === 'prune'))
  assertNoLiterals(root, dataStrings(fixture))
})

// CSS named colours (CSS Color 4) plus the two colour keywords.
const NAMED_COLOURS = new Set(`aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown
burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray
darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue
darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite
forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki
lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey
lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen
magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen
mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered
orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red
rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow
springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen transparent currentcolor`.split(/\s+/))

test('the stylesheet uses host theme variables only and collapses to one column in a narrow container', async () => {
  const env = await ready()
  const css = env.document.head.children[0].textContent
  assert.ok(css.length > 1000)
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'hex colour')
  assert.doesNotMatch(css, /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i, 'colour function')
  // Every custom property read is a host token, this sheet's own --sm-*, or the frame clearance.
  for (const [, name] of css.matchAll(/var\(\s*(--[\w-]+)/g)) {
    assert.match(name, /^--(dsw-|sm-|dsh-frame-top-clearance$)/, `var(${name})`)
  }
  // Named colours in declaration values (variable references removed first).
  const body = css.replace(/@[^{]+\{/g, '{')
  for (const [, property, raw] of body.matchAll(/([\w-]+)\s*:\s*([^;{}]+)/g)) {
    let value = raw
    for (let previous = ''; previous !== value;) { previous = value; value = value.replace(/var\(\s*--[\w-]+(?:\s*,[^()]*)?\)/g, '') }
    for (const word of value.toLowerCase().match(/[a-z]+/g) ?? []) {
      assert.equal(NAMED_COLOURS.has(word), false, `named colour "${word}" in ${property}: ${raw}`)
    }
  }
  // Own custom properties are set from host tokens or lengths only.
  for (const [, name, value] of css.matchAll(/(--sm-[\w-]+)\s*:\s*([^;}]+)/g)) {
    assert.match(value.trim(), /^(var\(--dsw-[\w-]+\)|clamp\([\d\svw,px]+\)|\d+px)$/, `${name}: ${value}`)
  }
  // The page is a size container; below 720 px the wrapping grids become one column.
  assert.match(css, /\.sm-page\{[^}]*container:\s*sm-page\s*\/\s*inline-size/)
  assert.match(css, /\.sm-cards\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(/)
  const narrow = css.match(/@container sm-page \(max-width:\s*719px\)\s*\{([\s\S]*?\})\s*\}/)
  assert.ok(narrow, 'a narrow-container rule')
  assert.match(narrow[1], /\.sm-cards\{grid-template-columns:minmax\(0,\s*1fr\)\}/)
  assert.match(narrow[1], /\.sm-table \.sm-row\{grid-template-columns:minmax\(0,\s*1fr\)\}/)
  // Hover affordances only where hover exists: no :hover outside @media (hover:hover).
  const outsideHoverMedia = css.replace(/@media \(hover:hover\)\{(?:[^{}]*\{[^{}]*\})*\s*\}/g, '')
  assert.ok(css.includes('@media (hover:hover){'))
  assert.doesNotMatch(outsideHoverMedia, /:hover/)
})

test('Overview renders from one overview() call: header, five cards, workspace table with bars, top-10 with badges', async () => {
  const env = await ready()
  const root = await page(env)
  assert.deepEqual(env.calls, [{ method: 'overview', request: {} }])
  for (const call of env.calls) assertRequest(call.method, call.request)

  // Header: title, store path, prune capability, update time, Refresh.
  const header = root.find((node) => node.type === 'header')
  assert.equal(header.props['data-window-drag'], '')
  assert.match(root.text(header), /Sessions/)
  assert.match(root.text(header), /\/fake\/store/)
  assert.match(root.text(header), /Prune available/)
  const time = new Date(NOW)
  const clock = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
  assert.match(root.text(header), new RegExp(`Updated ${clock}`))
  assert.ok(buttonByText(root, 'Refresh'))

  // Five cards, in order.
  const cards = root.findAll((node) => typeof node.props?.['data-card'] === 'string')
  assert.deepEqual(cards.map((node) => node.props['data-card']), ['total', 'disk', 'archived', 'reclaimable', 'largest'])
  assert.match(root.text(card(root, 'total')), /426/)
  assert.match(root.text(card(root, 'total')), /Live3/)
  assert.match(root.text(card(root, 'total')), /Subagent children312/)
  assert.match(root.text(card(root, 'total')), /Unreadable1/)
  assert.match(root.text(card(root, 'disk')), /579 MB/)
  assert.match(root.text(card(root, 'archived')), /239 MB/)
  assert.match(root.text(card(root, 'archived')), /Archived roots80/)
  assert.match(root.text(card(root, 'archived')), /Children included126/)
  assert.match(root.text(card(root, 'reclaimable')), /437 MB/)
  assert.match(root.text(card(root, 'reclaimable')), /Ready units206/)
  assert.match(root.text(card(root, 'reclaimable')), /Blocked units0/)
  assert.equal(buttonByText(root, 'Review prune…').props.disabled, undefined)
  assert.match(root.text(card(root, 'largest')), /115 MB/)
  assert.match(root.text(card(root, 'largest')), /Session s0007/)
  assert.match(root.text(card(root, 'largest')), /alpha/)

  // The on-disk search index load hint and its warn tier.
  const disk = card(root, 'disk')
  const load = findTag(root, disk, 'High')
  assert.equal(load.props['data-tone'], 'warning')
  assert.match(root.text(disk), /Search index load/)
  assert.match(root.text(disk), /At 256 MB on disk or more/)
  assert.match(root.text(root.tree), /on-disk \(compressed\) bytes/)

  // Workspace table: one row per workspace, a proportional bar, Unassigned grouped by store folder.
  const wsTable = byRole(root, 'table').find((node) => node.props['aria-labelledby'] === 'sm-ws-title')
  const wsRows = byRole({ findAll: (p) => findAllIn(wsTable, p) }, 'row').slice(1)
  assert.equal(wsRows.length, 2)
  assert.match(textOf(wsRows[0]), /alpha.*\/fake\/work\/alpha.*82.*20.*2\.1 GB.*yesterday/)
  assert.match(textOf(wsRows[1]), /Unassigned.*Store folder 2026-09.*7.*0.*3 MB/)
  const bars = findAllIn(wsTable, (node) => node.props?.className === 'sm-bar-fill')
  assert.deepEqual(bars.map((node) => node.props.style.width), ['100%', `${Math.round((3 / 2200) * 10000) / 100}%`])
  assert.equal(findAllIn(wsTable, (node) => node.props?.className === 'sm-bar')[0].props['aria-hidden'], 'true')

  // Largest sessions: title or short id, workspace, size, events, activity, badges.
  const topTable = byRole(root, 'table').find((node) => node.props['aria-labelledby'] === 'sm-top-title')
  const topRows = findAllIn(topTable, (node) => node.props?.role === 'row').slice(1)
  assert.equal(topRows.length, 2)
  // Digit grouping follows the page locale (Intl), so the separator is not pinned here.
  assert.match(textOf(topRows[0]), /Session s0007.*alpha.*115 MB.*3\D?900.*2 days ago.*archived/)
  assert.deepEqual(badges(topRows[0]), ['archived'])
  assert.match(textOf(topRows[1]), /s0008.*Unassigned.*90 MB.*1\D?200.*9 days ago/)
  assert.deepEqual(badges(topRows[1]), ['live', 'child'])
  assert.equal(findAllIn(topRows[1], (node) => node.props?.title === 's0008').length, 1, 'the full id rides the title')
  assert.equal(root.text(root.tree).includes('Read-only'), false)
  assert.equal(mutatingCalls(env).length, 0)
})

function findAllIn(node, predicate, found = []) {
  if (Array.isArray(node)) { node.forEach((child) => findAllIn(child, predicate, found)); return found }
  if (node === null || typeof node !== 'object') return found
  if (predicate(node)) found.push(node)
  for (const child of node.children ?? []) findAllIn(child, predicate, found)
  return found
}
const findTag = (_root, scope, text) => findAllIn(scope, (node) => node.props?.className === 'sm-tag' && textOf(node) === text)[0]
const badges = (row) => findAllIn(row, (node) => node.props?.className === 'sm-tag').map(textOf)

test('a null storeDir shows a localized "unknown"; a null event count shows a dash with an explanation', async () => {
  const value = overviewFixture()
  value.storeDir = null
  value.largest[0].events = null
  assertOverview(value)
  for (const mode of ['en', 'zh', 'marker']) {
    const env = await ready({ locale: createLocale({ mode }), api: createApi({ overview: async () => ({ ok: true, value }) }) })
    const root = await page(env)
    const header = root.find((node) => node.type === 'header')
    const top = findAllIn(byRole(root, 'table').find((node) => node.props['aria-labelledby'] === 'sm-top-title'), (node) => node.props?.role === 'row').slice(1)
    const events = findAllIn(top[0], (node) => node.props?.className?.includes('sm-col-events'))[0]
    assert.equal(textOf(events), '—')
    assert.equal(root.findAll((node) => node.type === 'code').length, 0, 'no path is shown')
    if (mode === 'marker') {
      assertNoLiterals(root, dataStrings(value))
      continue
    }
    const table = env.locale.dictionaries(NAMESPACE)[mode]
    assert.ok(root.text(header).includes(`${table['page.store']}${table['page.storeUnknown']}`), mode)
    assert.equal(events.props.title, table['top.eventsUnknown'])
    assert.equal(events.props['aria-label'], table['top.eventsUnknown'])
    assert.match(textOf(top[1]), /1\D?200/, 'a known count still shows')
  }
})

test('a raw (unwrapped) overview value renders the same as a RemoteResult', async () => {
  const env = await ready({ api: createApi({ overview: async () => overviewFixture() }) })
  const root = await page(env)
  assert.match(root.text(card(root, 'total')), /426/)
  assert.equal(byRole(root, 'alert').length, 0)
})

test('loading, connecting, empty, read-only and error states', async () => {
  // Connecting: the page renders before the mount resolves.
  let releaseMount
  const env0 = loadClient({ locale: createLocale(), mount: () => new Promise((resolve) => { releaseMount = resolve }) })
  const root0 = env0.renderPage()
  assert.match(root0.text(byRole(root0, 'status')[0]), /Connecting to the Host/)
  assert.deepEqual(env0.calls, [])
  releaseMount(() => {})
  await settle()
  assert.deepEqual(env0.calls.map((call) => call.method), ['overview'], 'the first fetch runs once the namespace appears')

  // Loading: the overview call has not answered yet.
  let answer
  const env1 = await ready({ api: createApi({ overview: () => new Promise((resolve) => { answer = resolve }) }) })
  const root1 = await page(env1)
  assert.match(root1.text(byRole(root1, 'status')[0]), /Reading the session store/)
  assert.equal(buttonByText(root1, 'Refreshing…').props['aria-busy'], true)
  answer({ ok: true, value: overviewFixture() })
  await settle()
  assert.match(root1.text(card(root1, 'total')), /426/)
  assert.ok(buttonByText(root1, 'Refresh'))

  // Empty store.
  const empty = { ...overviewFixture(), workspaces: [], largest: [] }
  for (const key of Object.keys(empty.totals)) empty.totals[key] = 0
  const env2 = await ready({ api: createApi({ overview: async () => ({ ok: true, value: empty }) }) })
  const root2 = await page(env2)
  assert.match(root2.text(root2.tree), /The session store holds no sessions/)
  assert.match(root2.text(card(root2, 'largest')), /No sessions/)
  assert.equal(byRole(root2, 'table').length, 0)
  assert.equal(buttonByText(root2, 'Review prune…').props.disabled, true, 'nothing to prune')

  // Read-only: capabilities.prune = false, the reason is localized.
  for (const reason of ['sessions-manager/unsupported-backend', 'sessions-manager/unsupported-platform', 'sessions-manager/trash-unusable']) {
    const value = overviewFixture()
    value.capabilities = { prune: false, reason }
    const env3 = await ready({ api: createApi({ overview: async () => ({ ok: true, value }) }) })
    const root3 = await page(env3)
    const { en } = env3.locale.dictionaries(NAMESPACE)
    assert.match(root3.text(root3.find((node) => node.type === 'header')), /Read-only/)
    const note = byRole(root3, 'note')[0]
    assert.ok(root3.text(note).includes(en[`error.${reason.slice('sessions-manager/'.length)}`]), reason)
    assert.equal(buttonByText(root3, 'Review prune…').props.disabled, true)
  }

  // Error: a RemoteResult failure, with the Host message as detail and a retry.
  let fail = true
  const env4 = await ready({
    api: createApi({
      overview: async () => fail
        ? { ok: false, error: { code: 'sessions-manager/forbidden', message: 'agent caller' } }
        : { ok: true, value: overviewFixture() },
    }),
  })
  const root4 = await page(env4)
  const alert = byRole(root4, 'alert')[0]
  assert.match(root4.text(alert), /Could not read the session store/)
  assert.match(root4.text(alert), /Only the owner can do this/)
  assert.match(root4.text(alert), /Host message: agent caller/)
  fail = false
  buttonByText(root4, 'Try again').props.onClick(event())
  await settle()
  assert.equal(byRole(root4, 'alert').length, 0)
  assert.match(root4.text(card(root4, 'total')), /426/)

  // A rejecting call and a malformed value never crash the page.
  const env5 = await ready({ api: createApi({ overview: async () => { throw new Error('socket closed') } }) })
  const root5 = await page(env5)
  assert.match(root5.text(byRole(root5, 'alert')[0]), /The Host call failed.*socket closed/)
  const env6 = await ready({ api: createApi({ overview: async () => ({ ok: true, value: { totals: 'nope' } }) }) })
  const root6 = await page(env6)
  assert.match(root6.text(byRole(root6, 'alert')[0]), /cannot read/)

  // A failed refresh keeps the last figures and says they are stale.
  let second = false
  const env7 = await ready({
    api: createApi({ overview: async () => second ? { ok: false, error: { code: 'sessions-manager/busy', message: 'locked' } } : { ok: true, value: overviewFixture() } }),
  })
  const root7 = await page(env7)
  second = true
  buttonByText(root7, 'Refresh').props.onClick(event())
  await settle()
  assert.match(root7.text(byRole(root7, 'alert')[0]), /last refresh failed.*Another change is in progress/)
  assert.match(root7.text(card(root7, 'total')), /426/)
})

test('every contract error code renders its own localized text, an unknown code the generic one', async () => {
  const { en } = loadClient({ locale: createLocale() }).locale.dictionaries(NAMESPACE)
  for (const code of [...ERROR_CODES, 'somewhere/else']) {
    const env = await ready({ api: createApi({ overview: async () => ({ ok: false, error: { code, message: 'm' } }) }) })
    const root = await page(env)
    const expected = ERROR_CODES.includes(code) ? en[`error.${code.slice('sessions-manager/'.length)}`] : en['error.unknown']
    assert.ok(root.text(byRole(root, 'alert')[0]).includes(expected), code)
  }
})

test('refresh policy: on open, on Refresh with fresh: true, after a mutation; reopening fetches again', async () => {
  const env = await ready({ api: createApi({ unarchive: async () => ({ ok: true, value: { unarchived: ['s0001'], skipped: [] } }) }) })
  const root = await page(env)
  assert.deepEqual(env.calls, [{ method: 'overview', request: {} }])

  buttonByText(root, 'Refresh').props.onClick(event())
  buttonByText(root, 'Refresh').props.onClick(event())
  await settle()
  assert.deepEqual(env.calls.slice(1), [{ method: 'overview', request: { fresh: true } }], 'a double click is one call')

  // A mutation (as the Archived and Trash tabs will issue it) refreshes the overview.
  const [shell] = root.componentProps('OverviewTab').map((props) => props.shell)
  const outcome = await shell.mutate('unarchive', { ids: ['s0001'] })
  await settle()
  assert.equal(outcome.ok, true)
  assert.deepEqual(env.calls.slice(2), [{ method: 'unarchive', request: { ids: ['s0001'] } }, { method: 'overview', request: { fresh: true } }])
  for (const call of env.calls) assertRequest(call.method, call.request)
  // read() refuses a mutating method: mutations go through mutate() only.
  const misuse = await shell.read('apply', { planId: 'p', confirmCount: 1 })
  assert.equal(misuse.ok, false)
  assert.equal(callsOf(env, 'apply').length, 0)

  // No timer while refreshMs is 0.
  assert.equal(env.timers.count, 0)
  root.unmount()
  const again = await page(env)
  assert.equal(callsOf(env, 'overview').length, 4, 'opening the page again fetches again')
  assert.match(again.text(card(again, 'total')), /426/)
})

test('a timer exists only while refreshMs > 0 and the page is visible, and is cleared on unmount', async () => {
  const value = overviewFixture()
  value.config.refreshMs = 30_000
  const env = await ready({ api: createApi({ overview: async () => ({ ok: true, value }) }) })
  const root = await page(env)
  assert.equal(env.timers.count, 1)
  env.timers.advance(30_000)
  await settle()
  assert.deepEqual(env.calls.map((call) => call.request), [{}, {}], 'a timed refresh uses the Host cache')

  env.document.setVisibility('hidden')
  await settle()
  assert.equal(env.timers.count, 0, 'no timer while the document is hidden')
  env.timers.advance(120_000)
  await settle()
  assert.equal(env.calls.length, 2)
  env.document.setVisibility('visible')
  await settle()
  assert.equal(env.timers.count, 1)

  // The page is not the selected panel: no timer.
  env.activePanelId = 'plugins'
  root.render()
  await settle()
  assert.equal(env.timers.count, 0)
  env.activePanelId = 'sessions-manager'
  root.render()
  await settle()
  assert.equal(env.timers.count, 1)

  root.unmount()
  assert.equal(env.timers.count, 0)
  assert.equal(env.document.listenerCount('visibilitychange'), 0)
})

test('effects survive the strict-mode double invoke: one fetch, one timer, one listener, clean unmount', async () => {
  const value = overviewFixture()
  value.config.refreshMs = 10_000
  const env = await ready({ strict: true, api: createApi({ overview: async () => ({ ok: true, value }) }) })
  const root = await page(env)
  assert.deepEqual(env.calls, [{ method: 'overview', request: {} }], 'the replayed open effect joins the call in flight')
  assert.equal(env.timers.count, 1)
  assert.equal(env.document.listenerCount('visibilitychange'), 1)
  assert.match(root.text(card(root, 'total')), /426/)
  env.timers.advance(10_000)
  await settle()
  assert.equal(callsOf(env, 'overview').length, 2)
  for (const tab of tabs(root)) { tab.props.onClick(event()); await settle() }
  root.unmount()
  assert.equal(env.timers.count, 0)
  assert.equal(env.document.listenerCount('visibilitychange'), 0)
  assert.equal(root.stats.setAfterUnmount, 0)
  assert.equal(mutatingCalls(env).length, 0)
  await env.unload()
  assert.equal(env.mountDisposals, 1)
})

test('tabs: tablist, tab and tabpanel roles, aria-selected, arrow keys, Home and End', async () => {
  const env = await ready()
  const root = await page(env)
  const list = byRole(root, 'tablist')[0]
  assert.equal(list.props['aria-label'], 'Sessions views')
  assert.deepEqual(tabs(root).map(textOf), ['Overview', 'Archived (80)', 'Trash'])
  assert.deepEqual(tabs(root).map((node) => node.props['aria-selected']), [true, false, false])
  assert.deepEqual(tabs(root).map((node) => node.props.tabIndex), [0, -1, -1])
  const panel = () => byRole(root, 'tabpanel')[0]
  assert.equal(panel().props['aria-labelledby'], selectedTab(root).props.id)
  assert.equal(selectedTab(root).props['aria-controls'], panel().props.id)

  const press = async (key) => {
    const current = selectedTab(root)
    const index = tabs(root).indexOf(current)
    const e = event({ key })
    current.props.onKeyDown(e)
    await settle()
    return { e, index }
  }
  const { e } = await press('ArrowRight')
  assert.equal(e.defaultPrevented, true)
  assert.equal(textOf(selectedTab(root)), 'Archived (80)')
  assert.deepEqual(root.focused.slice(-1), [selectedTab(root).props.id], 'focus follows the selection')
  assert.ok(findAllIn(panel(), (node) => node.props?.['data-placeholder'] === 'archived').length === 1)
  await press('ArrowRight')
  assert.equal(textOf(selectedTab(root)), 'Trash')
  assert.ok(findAllIn(panel(), (node) => node.props?.['data-placeholder'] === 'trash').length === 1)
  await press('ArrowRight')
  assert.equal(textOf(selectedTab(root)), 'Overview', 'ArrowRight wraps')
  await press('ArrowLeft')
  assert.equal(textOf(selectedTab(root)), 'Trash', 'ArrowLeft wraps')
  await press('Home')
  assert.equal(textOf(selectedTab(root)), 'Overview')
  await press('End')
  assert.equal(textOf(selectedTab(root)), 'Trash')
  const other = await press('a')
  assert.equal(other.e.defaultPrevented, false)
  tabs(root)[0].props.onClick(event())
  await settle()
  assert.equal(textOf(selectedTab(root)), 'Overview')
  assert.equal(byRole(root, 'tabpanel').length, 1)

  // The placeholder bodies receive the shell the later tabs build on.
  tabs(root)[1].props.onClick(event())
  await settle()
  const [archived] = root.componentProps('ArchivedTab')
  assert.equal(typeof archived.shell.read, 'function')
  assert.equal(typeof archived.shell.mutate, 'function')
  assert.equal(typeof archived.shell.openPrune, 'function')
  assert.equal(mutatingCalls(env).length, 0)
  assert.deepEqual(env.calls.map((call) => call.method), ['overview'], 'switching tabs fetches nothing')
})

test('a workspace row opens the Archived tab filtered by it; Review prune hands off to the prune panel', async () => {
  const env = await ready()
  const root = await page(env)
  const open = root.findAll((node) => node.type === 'button' && node.props.className === 'sm-row-open')
  assert.equal(open.length, 2)
  assert.equal(open[0].props['aria-label'], 'Show archived sessions of alpha')
  open[0].props.onClick(event())
  await settle()
  assert.equal(textOf(selectedTab(root)), 'Archived (80)')
  assert.deepEqual(plain(root.componentProps('ArchivedTab')[0].filter), { workspaceId: 'ws-alpha' })
  assert.match(root.text(byRole(root, 'tabpanel')[0]), /Workspace: alpha/)

  tabs(root)[0].props.onClick(event())
  await settle()
  root.findAll((node) => node.type === 'button' && node.props.className === 'sm-row-open')[1].props.onClick(event())
  await settle()
  assert.deepEqual(plain(root.componentProps('ArchivedTab')[0].filter), { workspaceId: null })
  assert.match(root.text(byRole(root, 'tabpanel')[0]), /Workspace: Unassigned/)

  // Review prune… opens the prune hand-off with the default scope; closing it restores the page.
  tabs(root)[0].props.onClick(event())
  await settle()
  buttonByText(root, 'Review prune…').props.onClick(event())
  await settle()
  assert.deepEqual(plain(root.componentProps('PrunePanel')[0].request), { scope: 'all' })
  const panel = root.find((node) => node.props?.['data-placeholder'] === 'prune')
  assert.match(textOf(panel), /Nothing was moved/)
  buttonByText(root, 'Close').props.onClick(event())
  await settle()
  assert.equal(root.find((node) => node.props?.['data-placeholder'] === 'prune'), undefined)
  assert.deepEqual(env.calls.map((call) => call.method), ['overview'])

  // The page keeps its tab across a remount (plugin-level UI state).
  tabs(root)[2].props.onClick(event())
  await settle()
  root.unmount()
  const again = await page(env)
  assert.equal(textOf(selectedTab(again)), 'Trash')
})

test('sizes and relative times: binary units, today, yesterday, N days ago', async () => {
  const value = overviewFixture()
  value.workspaces = [
    { id: 'ws-a', name: 'a', path: '/fake/a', folder: null, sessions: 1, archived: 0, bytes: 512, lastActivityAt: NOW - 60_000 },
    { id: 'ws-b', name: 'b', path: '/fake/b', folder: null, sessions: 1, archived: 0, bytes: 1536, lastActivityAt: NOW - DAY },
    { id: 'ws-c', name: 'c', path: '/fake/c', folder: null, sessions: 1, archived: 0, bytes: 5 * 1024 * MB, lastActivityAt: NOW - 3 * DAY },
  ]
  const env = await ready({ api: createApi({ overview: async () => ({ ok: true, value }) }) })
  const root = await page(env)
  const rows = byRole(root, 'table')[0]
  const text = textOf(rows)
  assert.match(text, /a\/fake\/a.*512 B.*today/)
  assert.match(text, /b\/fake\/b.*1\.5 KB.*yesterday/)
  assert.match(text, /c\/fake\/c.*5 GB.*3 days ago/)
  assert.equal(byClass(root, 'sm-row-head').length, 2)
})

test('O2: the Archived card shows a small line for archived ids without a stored log, only when there are any (en, zh, marker)', async () => {
  for (const [missing, shown] of [[0, false], [1, true], [7, true]]) {
    const value = overviewFixture()
    value.totals.archivedMissing = missing
    assertOverview(value)
    for (const mode of ['en', 'zh', 'marker']) {
      const env = await ready({ locale: createLocale({ mode }), api: createApi({ overview: async () => ({ ok: true, value }) }) })
      const root = await page(env)
      const archived = card(root, 'archived')
      const line = findAllIn(archived, (node) => node.props?.['data-fact'] === 'archived-missing')
      assert.equal(line.length, shown ? 1 : 0, `${mode} ${missing}`)
      if (!shown) continue
      assert.equal(line[0].props.className, 'sm-hint', 'a small secondary line')
      if (mode === 'marker') {
        assertNoLiterals(root, dataStrings(value))
        continue
      }
      const table = env.locale.dictionaries(NAMESPACE)[mode]
      const key = missing === 1 ? 'card.archived.missingOne' : 'card.archived.missing'
      assert.equal(textOf(line[0]), table[key].replace('{n}', String(missing)), `${mode} ${missing}`)
    }
  }
  const en = loadClient({ locale: createLocale() })
  await settle()
  const table = en.locale.dictionaries(NAMESPACE).en
  assert.match(table['card.archived.missing'], /registry/i)
  assert.match(table['card.archived.missing'], /harmless/i)
})
