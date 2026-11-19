/**
 * The composer chip (src/client.js): one shared pill for all eight providers,
 * a dialog popover portaled to document.body and placed by measurement,
 * Escape / outside-press / focus rules, one open popover at a time, the dock
 * wrapper's store subscription, and the labelled worst-window bar in every
 * panel family.
 *
 * Driven through the render harness (fake React and react-dom, stub document
 * and window with listener counts); no network.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { after } from 'node:test'
import {
  attachRefs, bootClient as bootHarness, cardProps, click, createProviderLoginStub, createUsageNamespaceStub,
  find, findAll, findByText, textContent,
} from './helpers/client-harness.mjs'
import { renderScenario, SCENARIOS } from './helpers/gallery.mjs'
import * as fixtures from './helpers/fixtures.mjs'

const SOURCE = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const TEST_TIMEOUT_MS = 5000
const READ = new Date(fixtures.FETCHED_AT).toDateString() === new Date().toDateString()
  ? new Date(fixtures.FETCHED_AT).toLocaleTimeString()
  : new Date(fixtures.FETCHED_AT).toLocaleString()

const booted = []
async function bootClient(options) {
  const h = await bootHarness(options)
  booted.push(h)
  return h
}
after(() => { for (const h of booted) h.dispose() })

/** A NewAPI relay: no default gate, so the state names one. */
const NEWAPI_ROUTE = 'newapi-relay'
const newapiState = () => fixtures.envelope(
  { kind: 'balance', total: 50, used: 12, remaining: 38, currency: 'USD' },
  { ui: { composerChip: true, gate: [NEWAPI_ROUTE] } },
)

/** All eight chips: route, chip title, a ready state, the dot family and the dialog's label. */
const CHIPS = [
  { id: 'openrouter', route: 'openrouter', namespace: 'openrouterUsage', px: 'orup', title: 'OpenRouter', state: fixtures.openrouter, dialog: 'OpenRouter usage' },
  { id: 'kimi', route: 'kimi-coding', namespace: 'kimiUsage', px: 'kmup', title: 'Kimi Code', state: fixtures.kimi, dialog: 'Kimi Code usage' },
  { id: 'deepseek', route: 'deepseek-official', namespace: 'deepseekUsage', px: 'pup', title: 'DeepSeek', state: fixtures.deepseek, dialog: 'DeepSeek balance' },
  { id: 'zhipu', route: 'zai-coding-cn', namespace: 'zhipuUsage', px: 'pup', title: 'GLM', state: fixtures.zhipu, dialog: 'GLM Coding Plan usage' },
  { id: 'minimax', route: 'minimax', namespace: 'minimaxUsage', px: 'pup', title: 'MiniMax', state: fixtures.zhipu, dialog: 'MiniMax Coding Plan usage' },
  { id: 'newapi', route: NEWAPI_ROUTE, namespace: 'newapiUsage', px: 'pup', title: 'NewAPI', state: newapiState, dialog: 'NewAPI token quota' },
  { id: 'codex', route: 'openai-codex', namespace: 'codexUsage', px: 'kmup', title: 'OpenAI Codex', state: fixtures.codex, dialog: 'OpenAI Codex usage' },
  { id: 'anthropic', route: 'anthropic', namespace: 'anthropicUsage', px: 'kmup', title: 'Claude', state: fixtures.anthropic, dialog: 'Claude usage' },
]
const chip = (id) => CHIPS.find((entry) => entry.id === id)

const triggerOf = (tree) => find(tree, (node) => node.type === 'button' && node.props?.['aria-haspopup'] === 'dialog')
const dialogsOf = (tree) => findAll(tree, (node) => node.props?.role === 'dialog')
const dialogOf = (tree) => dialogsOf(tree)[0] ?? null
const elementOf = (node) => node?.props?.ref?.current ?? null

/** A trigger rect and a panel size; the dialog node measures as the panel. */
function rects({ left = 20, top = 760, width = 140, height = 22, panel = { width: 420, height: 300 } } = {}) {
  const trigger = { left, top, width, height, right: left + width, bottom: top + height }
  return (node) => (node?.props?.role === 'dialog'
    ? { left: 0, top: 0, width: panel.width, height: panel.height, right: panel.width, bottom: panel.height }
    : trigger)
}

/** Boot the client for one chip and mount it. */
async function mountChip(entry, { state = entry.state(), stub, viewport, rect = rects() } = {}) {
  const usage = createUsageNamespaceStub(state, stub)
  const h = await bootClient({ namespaces: { [entry.namespace]: usage }, activeProvider: entry.route, viewport })
  const mount = await h.mountChip(`${entry.id}-usage-chip`, {}, { rect })
  return { h, mount, usage }
}

async function open(mount) {
  const trigger = triggerOf(mount.tree)
  assert.ok(trigger, 'the chip has a dialog trigger')
  await click(mount, trigger)
  const dialog = dialogOf(mount.tree)
  assert.ok(dialog, 'the popover opened')
  return dialog
}

/** A focusable element outside the chip (the composer editor). */
function outsideElement(h) {
  const [element] = attachRefs({ type: 'div', props: { ref: { current: null } }, children: [] }, { document: h.document })
  return element
}

const LISTENED = [['document', 'mousedown'], ['document', 'click'], ['document', 'keydown'], ['window', 'resize'], ['window', 'scroll']]
function listenerCounts(h) {
  return Object.fromEntries(LISTENED.map(([where, type]) => [`${where}:${type}`, h[where].listenerCount(type)]))
}
const NO_LISTENERS = Object.fromEntries(LISTENED.map(([where, type]) => [`${where}:${type}`, 0]))

// ---------------------------------------------------------------------------
// 1. One shell for all eight providers
// ---------------------------------------------------------------------------

test('one chip shell serves all eight providers; each supplies only its summary and panel; the copied chip components are gone', { timeout: TEST_TIMEOUT_MS }, async () => {
  for (const name of ['OpenRouterChip', 'KimiChip', 'QuotaChip', 'BalanceChip', 'DeepSeekChip', 'ZhipuChip', 'MiniMaxChip', 'NewApiChip']) {
    assert.ok(!SOURCE.includes(`function ${name}(`), `${name} is gone`)
  }
  assert.equal(SOURCE.split('function UsageChip(').length - 1, 1, 'one shell')
  assert.equal(SOURCE.split("'aria-haspopup'").length - 1, 1, 'one trigger definition')
  assert.equal(SOURCE.split('chipFace(').length - 1, 2, 'chipFace is defined once and called once, by the shell')
  const h = await bootClient({ effects: 'none' })
  assert.equal(h.providers.size, 8)
  for (const [id, provider] of h.providers) {
    assert.equal(typeof provider.summary, 'function', `${id} supplies a summary`)
    assert.equal(typeof provider.panel, 'function', `${id} supplies a panel`)
    assert.equal(typeof provider.chip, 'function', `${id} has its chip component`)
  }
  for (const entry of CHIPS) {
    const { h: booted, mount } = await mountChip(entry)
    const trigger = triggerOf(mount.tree)
    assert.ok(trigger, `${entry.id}: the shared trigger`)
    assert.equal(trigger.props.className, 'usage-chip', `${entry.id}: one pill class`)
    assert.ok(textContent(trigger).startsWith(entry.title), `${entry.id}: ${textContent(trigger)}`)
    booted.dispose()
  }
})

// ---------------------------------------------------------------------------
// 2. The trigger
// ---------------------------------------------------------------------------

for (const entry of CHIPS) {
  test(`${entry.id}: the trigger is a dialog button with aria-expanded false/true and aria-controls only while open`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const { h, mount } = await mountChip(entry)
    try {
      let trigger = triggerOf(mount.tree)
      assert.ok(trigger, 'a trigger with aria-haspopup dialog')
      assert.equal(trigger.props.type, 'button')
      assert.equal(trigger.props['aria-expanded'], 'false')
      assert.equal(trigger.props['aria-controls'], undefined, 'no aria-controls while closed')
      const dialog = await open(mount)
      trigger = triggerOf(mount.tree)
      assert.equal(trigger.props['aria-expanded'], 'true')
      assert.equal(trigger.props['aria-controls'], dialog.props.id)
      assert.ok(typeof dialog.props.id === 'string' && dialog.props.id.length > 0)
      await click(mount, trigger)
      trigger = triggerOf(mount.tree)
      assert.equal(dialogOf(mount.tree), null, 'a second click closes it')
      assert.equal(trigger.props['aria-expanded'], 'false')
      assert.equal(trigger.props['aria-controls'], undefined)
    } finally {
      h.dispose()
    }
  })
}

/** The visible words of a trigger: every child's text, without the empty and the "!" mark. */
function visibleWords(trigger) {
  return trigger.children.filter((child) => typeof child === 'object').map((child) => textContent(child)).filter((text) => text && text !== '!').join(' ')
}

const NAMES = [
  ['kimi', 'ready, amber', () => fixtures.kimi(), 'Kimi Code 81.0% $18.40 extra, level warning'],
  ['zhipu', 'ready, green', () => fixtures.zhipu(), 'GLM 64.0%, level normal'],
  ['zhipu', 'ready, red', () => fixtures.zhipu({ fiveHour: 0.97 }), 'GLM 97.0%, level critical'],
  ['deepseek', 'balance', () => fixtures.deepseek(), 'DeepSeek ¥128.50, level normal'],
  ['anthropic', 'quota and extra used', () => fixtures.anthropic(), 'Claude 88.0% $12.50 extra used, level warning'],
  ['openrouter', 'uncapped key: no level', () => fixtures.openrouter({ limit: null, remaining: null, withAccount: false }), 'OpenRouter $12.35'],
  ['zhipu', 'stale', () => fixtures.failed(fixtures.zhipu()), `GLM 64.0% stale, level warning, read ${READ}, HTTP 429: Rate limit exceeded. Try again in 30 seconds.`],
  ['zhipu', 'no data', () => fixtures.failed(fixtures.zhipu(), { keepData: false, error: 'http-401', detail: 'HTTP 401: Invalid API key.' }), 'GLM unavailable, level critical, HTTP 401: Invalid API key.'],
]

for (const [id, name, state, expected] of NAMES) {
  test(`${id} chip (${name}): the accessible name states provider, value and level in words, plus "stale" when stale`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const { h, mount } = await mountChip(chip(id), { state: state() })
    try {
      const trigger = triggerOf(mount.tree)
      assert.ok(trigger)
      const label = trigger.props['aria-label']
      assert.equal(label, expected)
      assert.ok(label.startsWith(visibleWords(trigger)), `"${label}" starts with the visible words "${visibleWords(trigger)}"`)
      const dot = find(trigger, (node) => String(node.props?.className ?? '').split(' ')[0] === `${chip(id).px}-dot`)
      assert.equal(dot.props['aria-hidden'], 'true', 'the dot is hidden from assistive tech')
      const mark = trigger.children[trigger.children.length - 1]
      assert.equal(mark.props['aria-hidden'], 'true', 'the mark is hidden from assistive tech')
    } finally {
      h.dispose()
    }
  })
}

// ---------------------------------------------------------------------------
// 3. The popover
// ---------------------------------------------------------------------------

test('the popover is a dialog portaled to document.body, with an aria-label and the controlled id; focus moves into it', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { h, mount } = await mountChip(chip('anthropic'))
  try {
    const dialog = await open(mount)
    const portal = find(mount.tree, (node) => node.type === 'portal')
    assert.ok(portal, 'a portal')
    assert.equal(portal.props.container, h.document.body, 'into the document body')
    assert.equal(dialogOf(portal.children), dialog, 'the dialog is the portal content')
    assert.equal(dialog.props['aria-label'], 'Claude usage')
    assert.equal(dialog.props.id, triggerOf(mount.tree).props['aria-controls'])
    assert.equal(dialog.props.tabIndex, -1)
    assert.equal(dialog.props.className, 'usage-pop')
    assert.ok(findByText(dialog, 'Refresh'), 'the panel is inside')
    assert.equal(h.document.activeElement, elementOf(dialog), 'focus moved into the dialog')
    assert.equal(elementOf(triggerOf(mount.tree)).contains(elementOf(dialog)), false, 'like the DOM, the portaled dialog is not inside the chip')
  } finally {
    h.dispose()
  }
})

for (const entry of CHIPS) {
  test(`${entry.id}: the dialog is labelled "${entry.dialog}" and holds that provider's panel`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const { h, mount } = await mountChip(entry)
    try {
      const dialog = await open(mount)
      assert.equal(dialog.props['aria-label'], entry.dialog)
      assert.ok(findByText(dialog, 'Refresh'))
    } finally {
      h.dispose()
    }
  })
}

// ---------------------------------------------------------------------------
// 4. Escape, outside presses, focus, one popover at a time, listeners
// ---------------------------------------------------------------------------

test('Escape closes the popover and moves focus to the trigger; every listener is removed', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { h, mount } = await mountChip(chip('zhipu'))
  try {
    assert.deepEqual(listenerCounts(h), NO_LISTENERS, 'a closed chip listens to nothing')
    const dialog = await open(mount)
    assert.equal(h.document.activeElement, elementOf(dialog))
    assert.ok(h.document.listenerCount('keydown') > 0 && h.document.listenerCount('mousedown') > 0, 'an open popover listens')
    h.document.dispatch('keydown', { key: 'a' })
    await mount.settle()
    assert.ok(dialogOf(mount.tree), 'another key keeps it open')
    h.document.dispatch('keydown', { key: 'Escape' })
    await mount.settle()
    assert.equal(dialogOf(mount.tree), null, 'Escape closed it')
    const trigger = triggerOf(mount.tree)
    assert.equal(h.document.activeElement, elementOf(trigger), 'focus is back on the trigger')
    assert.equal(trigger.props['aria-expanded'], 'false')
    assert.deepEqual(listenerCounts(h), NO_LISTENERS, 'closing removed the listeners')
  } finally {
    h.dispose()
  }
})

test('Escape while the focus is outside the popover (the composer editor) closes it and leaves the focus there', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { h, mount } = await mountChip(chip('zhipu'))
  try {
    await open(mount)
    const editor = outsideElement(h)
    editor.focus()
    h.document.dispatch('keydown', { key: 'Escape' })
    await mount.settle()
    assert.equal(dialogOf(mount.tree), null)
    assert.equal(h.document.activeElement, editor, 'the editor keeps the focus')
  } finally {
    h.dispose()
  }
})

test('a mousedown outside closes the popover without moving the focus; one on the dialog or the trigger keeps it open', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { h, mount } = await mountChip(chip('kimi'))
  try {
    const dialog = await open(mount)
    h.document.dispatch('mousedown', { target: elementOf(dialog) })
    await mount.settle()
    assert.ok(dialogOf(mount.tree), 'a press inside the dialog keeps it open')
    h.document.dispatch('mousedown', { target: elementOf(triggerOf(mount.tree)) })
    await mount.settle()
    assert.ok(dialogOf(mount.tree), 'a press on the trigger is left to its click')
    const editor = outsideElement(h)
    editor.focus()
    const trigger = elementOf(triggerOf(mount.tree))
    const event = h.document.dispatch('mousedown', { target: editor })
    await mount.settle()
    assert.equal(dialogOf(mount.tree), null, 'a press outside closed it')
    assert.equal(event.defaultPrevented, false, 'the press itself is not cancelled')
    assert.equal(h.document.activeElement, editor, 'focus is not moved')
    assert.equal(trigger.focused, false, 'the trigger did not take the focus')
    assert.deepEqual(listenerCounts(h), NO_LISTENERS)
  } finally {
    h.dispose()
  }
})

test('an outside click (a keyboard-activated control fires click without mousedown) closes it too', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { h, mount } = await mountChip(chip('kimi'))
  try {
    await open(mount)
    h.document.dispatch('click', { target: outsideElement(h) })
    await mount.settle()
    assert.equal(dialogOf(mount.tree), null)
  } finally {
    h.dispose()
  }
})

test('focus leaving for an element outside the chip closes the popover; moving inside it or leaving the window does not', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { h, mount } = await mountChip(chip('kimi'))
  try {
    let dialog = await open(mount)
    dialog.props.onBlur({ relatedTarget: elementOf(triggerOf(mount.tree)) })
    await mount.settle()
    assert.ok(dialogOf(mount.tree), 'focus on the trigger keeps it open')
    dialog = dialogOf(mount.tree)
    dialog.props.onBlur({ relatedTarget: null })
    await mount.settle()
    assert.ok(dialogOf(mount.tree), 'switching windows keeps it open')
    dialogOf(mount.tree).props.onBlur({ relatedTarget: outsideElement(h) })
    await mount.settle()
    assert.equal(dialogOf(mount.tree), null, 'tabbing out closes it')
  } finally {
    h.dispose()
  }
})

/** Two chips in one composer dock, both shown for the Claude route. */
async function twoChips() {
  const gated = (state) => ({ ...state, ui: { composerChip: true, gate: ['anthropic'] } })
  const h = await bootClient({
    namespaces: { codexUsage: createUsageNamespaceStub(gated(fixtures.codex())), anthropicUsage: createUsageNamespaceStub(gated(fixtures.anthropic())) },
    activeProvider: 'anthropic',
  })
  const Codex = h.chips.get('codex-usage-chip')
  const Claude = h.chips.get('anthropic-usage-chip')
  function Dock(props) {
    return h.React.createElement('div', null, h.React.createElement(Codex, props), h.React.createElement(Claude, props))
  }
  const mount = await h.mount(Dock, { sessionId: 's-1' }, { rect: rects() })
  const triggers = () => findAll(mount.tree, (node) => node.type === 'button' && node.props?.['aria-haspopup'] === 'dialog')
  return { h, mount, triggers }
}

test('closing by pressing another chip works, and only one chip popover is open at a time', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { h, mount, triggers } = await twoChips()
  try {
    assert.equal(triggers().length, 2)
    await click(mount, triggers()[0])
    assert.equal(dialogsOf(mount.tree).length, 1)
    assert.ok(textContent(dialogOf(mount.tree)).includes('OpenAI Codex'))

    // A mouse press on the other chip closes the first, then its click opens the second.
    h.document.dispatch('mousedown', { target: elementOf(triggers()[1]) })
    await mount.settle()
    assert.equal(dialogsOf(mount.tree).length, 0, 'the press on the other chip closed the first popover')
    await click(mount, triggers()[1])
    assert.equal(dialogsOf(mount.tree).length, 1)
    assert.ok(textContent(dialogOf(mount.tree)).includes('Claude'))

    // Opening one chip closes the other even with no press at all.
    await click(mount, triggers()[0])
    const open = dialogsOf(mount.tree)
    assert.equal(open.length, 1, 'never two popovers')
    assert.ok(textContent(open[0]).includes('OpenAI Codex'))
    assert.deepEqual(triggers().map((node) => node.props['aria-expanded']), ['true', 'false'])
  } finally {
    h.dispose()
  }
})

test('unmounting an open chip, or a store snapshot that hides it, removes every listener it added', { timeout: TEST_TIMEOUT_MS }, async () => {
  {
    const { h, mount } = await mountChip(chip('zhipu'))
    await open(mount)
    assert.notDeepEqual(listenerCounts(h), NO_LISTENERS)
    mount.unmount()
    assert.deepEqual(listenerCounts(h), NO_LISTENERS, 'unmount removed them')
    h.dispose()
  }
  {
    const { h, mount } = await mountChip(chip('zhipu'))
    await open(mount)
    h.setState('zhipu', { ...fixtures.zhipu(), ui: { composerChip: false, gate: null } })
    await mount.settle()
    assert.equal(triggerOf(mount.tree), null, 'the chip is hidden')
    assert.equal(dialogOf(mount.tree), null)
    assert.deepEqual(listenerCounts(h), NO_LISTENERS, 'hiding removed them')
    h.dispose()
  }
})

// ---------------------------------------------------------------------------
// 5. Placement by measurement
// ---------------------------------------------------------------------------

async function placed(rect, viewport = { width: 1280, height: 800 }) {
  const { h, mount } = await mountChip(chip('anthropic'), { rect, viewport })
  const dialog = await open(mount)
  const style = dialogOf(mount.tree).props.style
  return { h, mount, dialog, style }
}

test('after opening, a measured shift keeps the popover inside the viewport: left edge, right edge, above the trigger, below it near the top', { timeout: TEST_TIMEOUT_MS }, async () => {
  {
    const { h, style } = await placed(rects({ left: 20, top: 760 }))
    assert.equal(style.visibility, undefined, 'shown once measured')
    assert.equal(style.left, 20, 'aligned with the trigger near x = 20, at least 8px inside')
    assert.ok(style.left >= 8)
    assert.equal(style.bottom, 800 - 760 + 8, 'its bottom edge 8px above the trigger')
    assert.equal(style.top, undefined)
    assert.equal(style.maxHeight, 760 - 8 - 12, 'never above the 12px window inset')
    h.dispose()
  }
  {
    const { h, style } = await placed(rects({ left: 2, top: 760 }))
    assert.equal(style.left, 12, 'a trigger at the very edge: shifted 12px inside')
    h.dispose()
  }
  {
    const { h, style } = await placed(rects({ left: 1200, top: 760 }))
    assert.equal(style.left, 1280 - 12 - 420, 'shifted left so the right edge stays 12px inside')
    h.dispose()
  }
  {
    const { h, style } = await placed(rects({ left: 300, top: 30 }))
    assert.equal(style.top, 30 + 22 + 8, 'no room above: 8px below the trigger')
    assert.equal(style.bottom, undefined)
    assert.equal(style.maxHeight, 800 - 12 - (30 + 22) - 8, 'never below the 12px window inset')
    h.dispose()
  }
  {
    const { h, style } = await placed(rects({ left: 20, top: 760 }), { width: 360, height: 800 })
    assert.equal(style.left, 12, 'a viewport narrower than the panel: pinned 12px inside')
    h.dispose()
  }
})

test('the popover is placed again when the window is resized, and stops listening once closed', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { h, mount } = await placed(rects({ left: 500, top: 760 }))
  try {
    assert.equal(dialogOf(mount.tree).props.style.left, 500)
    h.window.innerWidth = 700
    h.window.dispatch('resize')
    await mount.settle()
    assert.equal(dialogOf(mount.tree).props.style.left, 700 - 12 - 420)
    await click(mount, triggerOf(mount.tree))
    assert.equal(h.window.listenerCount('resize'), 0)
    assert.equal(h.window.listenerCount('scroll'), 0)
  } finally {
    h.dispose()
  }
})

// ---------------------------------------------------------------------------
// 6. CSS
// ---------------------------------------------------------------------------

test('one popover rule: fixed, width clamped to the viewport, a dvh max-height that scrolls, the prominent elevation; no rgba() literal', async () => {
  const h = await bootClient({ effects: ['usage: stylesheet'] })
  const css = h.stylesheet
  const pops = [...css.matchAll(/\.([a-z]+)-pop\b/g)].map((match) => match[1])
  assert.deepEqual([...new Set(pops)], ['usage'], `only the shared popover class: ${pops}`)
  assert.equal(css.split('.usage-pop{').length - 1, 1, 'one rule')
  const rule = /\.usage-pop\{([^}]*)\}/.exec(css)[1]
  assert.match(rule, /(^|;)position:fixed(;|$)/)
  assert.match(rule, /(^|;)width:min\(\d+px,calc\(100vw - 24px\)\)(;|$)/, rule)
  assert.match(rule, /(^|;)max-height:[^;]*dvh[^;]*(;|$)/, rule)
  assert.match(rule, /(^|;)overflow-y:auto(;|$)/)
  assert.match(rule, /(^|;)box-shadow:var\(--dsw-elevation-prominent\)(;|$)/)
  const chips = [...css.matchAll(/\.([a-z]+)-chip\b/g)].map((match) => match[1])
  assert.deepEqual([...new Set(chips)], ['usage'], 'one pill class')
  assert.ok(!SOURCE.includes('rgba('), 'no rgba() literal in the client')
})

// ---------------------------------------------------------------------------
// 7. The dock wrapper follows the store
// ---------------------------------------------------------------------------

test('the dock wrapper follows the provider store: a snapshot with ui.composerChip false or another ui.gate hides the chip, with no model switch', { timeout: TEST_TIMEOUT_MS }, async () => {
  const entry = chip('zhipu')
  const { h, mount } = await mountChip(entry)
  try {
    const directory = h.modelDirectory.directoryFor('s').store
    const before = directory.getSnapshot().current.provider
    assert.ok(triggerOf(mount.tree), 'shown for its route')
    h.setState('zhipu', { ...fixtures.zhipu(), ui: { composerChip: false, gate: null } })
    await mount.settle()
    assert.equal(triggerOf(mount.tree), null, 'composerChip false hides it')
    h.setState('zhipu', { ...fixtures.zhipu(), ui: { composerChip: true, gate: ['some-other-route'] } })
    await mount.settle()
    assert.equal(triggerOf(mount.tree), null, 'a gate without the active route hides it')
    h.setState('zhipu', { ...fixtures.zhipu(), ui: { composerChip: true, gate: [entry.route] } })
    await mount.settle()
    assert.ok(triggerOf(mount.tree), 'a gate with the route shows it again')
    assert.equal(directory.getSnapshot().current.provider, before, 'the active model never changed')
  } finally {
    h.dispose()
  }
})

// ---------------------------------------------------------------------------
// 8. The labelled worst-window bar
// ---------------------------------------------------------------------------

const progressbars = (tree) => findAll(tree, (node) => node.props?.role === 'progressbar')

/** The caption node directly before a bar among its siblings. */
function captionBefore(tree, bar) {
  const parent = find(tree, (node) => (node.children ?? []).flat(Infinity).includes(bar))
  const siblings = parent.children.flat(Infinity).filter((child) => typeof child === 'object' && child)
  return siblings[siblings.indexOf(bar) - 1] ?? null
}

const BARS = [
  ['anthropic', 'Claude at 74% (the live case)', () => fixtures.anthropic({ sevenDay: 0.74 }), [['7-day window 74.0% used', 74, '7-day window', 'kmup-ok', '74%']]],
  ['kimi', 'Kimi at 81%', () => fixtures.kimi(), [['7-day window 81.0% used', 81, '7-day window', 'kmup-warn', '81%']]],
  ['codex', 'Codex windows', () => fixtures.codex(), [['7-day window 52.0% used', 52, '7-day window', 'kmup-ok', '52%']]],
  ['zhipu', 'GLM windows', () => fixtures.zhipu(), [['7-day window 64.0% used', 64, '7-day window', 'pup-ok', '64%']]],
  ['openrouter', 'OpenRouter key and account', () => fixtures.openrouter(), [
    ['Key budget 75.3% left', 75.3, 'Key budget', 'orup-ok', `${(37.6544 / 50) * 100}%`],
    ['Account balance 37.5% left', 37.5, 'Account balance', 'orup-ok', '37.5%'],
  ]],
]

for (const [id, name, state, bars] of BARS) {
  test(`${name}: every bar has a visible caption with its window and percentage, role progressbar, aria-valuenow/min/max and an aria-label`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const { h, mount } = await mountChip(chip(id), { state: state() })
    try {
      const dialog = await open(mount)
      const found = progressbars(dialog)
      assert.equal(found.length, bars.length, `${bars.length} labelled bar(s)`)
      bars.forEach(([caption, now, label, fill, width], index) => {
        const bar = found[index]
        assert.ok(findByText(dialog, caption), `the caption "${caption}" is visible: ${textContent(dialog)}`)
        assert.equal(textContent(captionBefore(dialog, bar)), caption, 'the caption sits right above its bar')
        assert.equal(bar.props['aria-valuenow'], now)
        assert.equal(bar.props['aria-valuemin'], 0)
        assert.equal(bar.props['aria-valuemax'], 100)
        assert.equal(bar.props['aria-valuetext'], caption.slice(label.length + 1))
        assert.ok(String(bar.props['aria-label']).includes(label), `aria-label names the bar: ${bar.props['aria-label']}`)
        assert.ok(String(bar.props.className).endsWith('-bar'), 'the bar keeps its family class')
        assert.equal(bar.children[0].props.className, fill, 'the colour is unchanged')
        assert.equal(bar.children[0].props.style.width, width)
      })
    } finally {
      h.dispose()
    }
  })
}

test('the Settings card panel shows the same labelled bar', { timeout: TEST_TIMEOUT_MS }, async () => {
  const usage = createUsageNamespaceStub(fixtures.zhipu())
  const h = await bootClient({ namespaces: { zhipuUsage: usage, providerLogin: createProviderLoginStub({ configured: true }) } })
  try {
    const mount = await h.mountCard('llm-pi-ai', cardProps('zai-coding-cn'))
    await click(mount, find(mount.tree, (node) => node.type === 'button' && node.props?.title === 'GLM Coding Plan usage'))
    assert.ok(findByText(mount.tree, '7-day window 64.0% used'))
    assert.equal(progressbars(mount.tree)[0].props['aria-valuenow'], 64)
  } finally {
    h.dispose()
  }
})

// ---------------------------------------------------------------------------
// 9. Gallery
// ---------------------------------------------------------------------------

test('the gallery shows each chip family closed and open, the placement clamps and the labelled bar', { timeout: 20_000 }, async () => {
  const byId = new Map(SCENARIOS.map((scenario) => [scenario.id, scenario]))
  const closed = ['chip-openrouter', 'chip-kimi', 'chip-glm', 'chip-deepseek', 'chip-codex', 'chip-anthropic']
  const opened = ['chip-popover-openrouter', 'chip-popover-kimi', 'chip-popover-glm', 'chip-popover-deepseek', 'chip-popover-codex', 'chip-popover-anthropic', 'chip-popover-left-edge', 'chip-popover-below']
  for (const id of closed) {
    assert.ok(byId.has(id), id)
    const { html } = await renderScenario(byId.get(id))
    assert.ok(html.includes('aria-haspopup="dialog"') && html.includes('aria-expanded="false"'), id)
    assert.ok(!html.includes('role="dialog"'), id)
  }
  for (const id of opened) {
    assert.ok(byId.has(id), id)
    const { html, anchor } = await renderScenario(byId.get(id))
    assert.ok(html.includes('aria-expanded="true"') && html.includes('role="dialog"'), id)
    assert.match(html, /role="dialog"[^>]*style="[^"]*left:\d+px/, `${id}: the measured placement is written out`)
    assert.ok(anchor && Number.isFinite(anchor.left) && Number.isFinite(anchor.top), `${id} places its chip`)
    if (id !== 'chip-popover-deepseek') assert.ok(html.includes('role="progressbar"'), `${id}: a labelled bar`)
  }
  assert.ok(byId.has('labelled-bar-claude'))
  const bar = await renderScenario(byId.get('labelled-bar-claude'))
  assert.ok(bar.html.includes('7-day window 74.0% used'))
  assert.match(bar.html, /role="progressbar"[^>]*aria-valuenow="74"/)
})
