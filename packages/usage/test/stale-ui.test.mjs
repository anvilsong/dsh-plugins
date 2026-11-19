/**
 * Stale and failed reads on the browser surfaces (src/client.js): the provider
 * card line, the composer chips and the four panel families. The Host keeps
 * the last good data after a failed refresh; `fetchedAt` is the last GOOD
 * read and `attemptedAt` the last attempt. A Remote call that fails or is
 * rejected (the Host is not reachable) keeps the last data with a note.
 *
 * Driven through the render harness; no network.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { after, mock } from 'node:test'
import {
  bootClient as bootHarness, cardProps, click, createProviderLoginStub, createUsageNamespaceStub, find, findAll, findByText, immediate, textContent,
} from './helpers/client-harness.mjs'
import { renderScenario, SCENARIOS } from './helpers/gallery.mjs'
import * as fixtures from './helpers/fixtures.mjs'

const SOURCE = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const clock = (ms) => new Date(ms).toLocaleTimeString()
const READ = clock(fixtures.FETCHED_AT)
const FAILED = clock(fixtures.FAILED_AT)
const DETAIL = 'HTTP 429: Rate limit exceeded. Try again in 30 seconds.'
const TEST_TIMEOUT_MS = 5000

const booted = []
async function bootClient(options) {
  const h = await bootHarness(options)
  booted.push(h)
  return h
}
after(() => { for (const h of booted) h.dispose() })

/**
 * The provider families: one per panel component (OpenRouter, Kimi, quota,
 * balance) plus the two OAuth providers that reuse the Kimi panel.
 */
const FAMILIES = [
  { id: 'openrouter', route: 'openrouter', ns: 'llm-pi-ai', namespace: 'openrouterUsage', px: 'orup', title: 'OpenRouter', fixture: fixtures.openrouter, summary: 'used $12.35', chipValues: ['$12.35', '$37.50 left'], panel: 'Used (key)' },
  { id: 'kimi', route: 'kimi-coding', ns: 'llm-pi-ai', namespace: 'kimiUsage', px: 'kmup', title: 'Kimi Code', fixture: fixtures.kimi, summary: '5h 42.0% · 7d 81.0%', chipValues: ['81.0%', '$18.40 extra'], panel: '5-hour window' },
  { id: 'zhipu', route: 'zai-coding-cn', ns: 'llm-pi-ai', namespace: 'zhipuUsage', px: 'pup', title: 'GLM Coding Plan', fixture: fixtures.zhipu, summary: '5h 18.0% · 7d 64.0%', chipValues: ['64.0%'], panel: 'Tool calls' },
  { id: 'deepseek', route: 'deepseek-official', ns: 'llm-deepseek', namespace: 'deepseekUsage', px: 'pup', title: 'DeepSeek', fixture: fixtures.deepseek, summary: 'balance ¥128.50', chipValues: ['¥128.50'], panel: 'Balance (CNY)' },
  { id: 'codex', route: 'openai-codex', ns: 'llm-pi-ai', namespace: 'codexUsage', px: 'kmup', title: 'OpenAI Codex', fixture: fixtures.codex, summary: '5h 37.0% · 7d 52.0%', chipValues: ['52.0%', '$5.00 extra'], panel: 'Rate-limit reset credits' },
  { id: 'anthropic', route: 'anthropic', ns: 'llm-pi-ai', namespace: 'anthropicUsage', px: 'kmup', title: 'Claude', fixture: fixtures.anthropic, summary: '5h 23.0% · 7d 88.0%', chipValues: ['88.0%', '$12.50 extra used'], panel: 'Usage credits spent' },
]
const PANEL_FAMILIES = FAMILIES.filter((family) => ['openrouter', 'kimi', 'zhipu', 'deepseek'].includes(family.id))
/** Every chip: the six families plus MiniMax, which shares the quota chip with GLM. */
const CHIPS = [
  ...FAMILIES.map((family) => ({ ...family, chipId: `${family.id}-usage-chip` })),
  { ...FAMILIES.find((family) => family.id === 'zhipu'), id: 'minimax', route: 'minimax', namespace: 'minimaxUsage', title: 'MiniMax', chipId: 'minimax-usage-chip' },
]
const ZHIPU = FAMILIES.find((family) => family.id === 'zhipu')

const stale = (family, patch) => fixtures.failed(family.fixture(), patch)
const noData = (family) => fixtures.failed(family.fixture(), { keepData: false, error: 'http-401', detail: 'HTTP 401: Invalid API key.' })

async function mountCard(family, state, stubOptions = {}) {
  const usage = createUsageNamespaceStub(state, stubOptions)
  const h = await bootClient({ namespaces: { [family.namespace]: usage, providerLogin: createProviderLoginStub({ configured: true }) } })
  const mount = await h.mountCard(family.ns, cardProps(family.route))
  return { h, mount, usage }
}

async function mountChip(family, state, stubOptions = {}) {
  const namespaces = state === undefined ? {} : { [family.namespace]: createUsageNamespaceStub(state, stubOptions) }
  const h = await bootClient({ namespaces, activeProvider: family.route })
  const mount = await h.mountChip(family.chipId)
  return { h, mount, usage: namespaces[family.namespace] }
}

const toggleOf = (tree, family) => find(tree, (node) => node.type === 'button' && node.props?.title === `${family.title} usage`)
const statusOf = (tree) => find(tree, (node) => node.props?.role === 'status')
const dotOf = (tree, px) => find(tree, (node) => typeof node.props?.className === 'string' && node.props.className.split(' ')[0] === `${px}-dot`)
const chipButton = (tree) => find(tree, (node) => node.type === 'button')

async function expand(mount, family) {
  const toggle = toggleOf(mount.tree, family)
  assert.ok(toggle, `${family.id}: the card line is shown`)
  await click(mount, toggle)
}

/** The value node of the Metric whose label reads `label`. */
function metricValue(tree, label) {
  const labelNode = findByText(tree, label)
  assert.ok(labelNode, `metric ${label}`)
  const cell = find(tree, (node) => node.children?.includes?.(labelNode))
  return cell.children[1]
}

// ---------------------------------------------------------------------------
// 1. One helper derives the health of a state
// ---------------------------------------------------------------------------

/** The source of one top-level function of the client factory. */
function body(name) {
  const start = SOURCE.indexOf(`\n    function ${name}(`)
  assert.ok(start >= 0, `client.js defines ${name}`)
  const rest = SOURCE.slice(start + 1)
  const end = rest.slice(1).search(/\n {4}(?:function |const |\/\/ |\/\*\*)/)
  return end < 0 ? rest : rest.slice(0, end + 1)
}

const SURFACES = ['CardExtras', 'OpenRouterPanel', 'KimiPanel', 'QuotaPanel', 'BalancePanel', 'OpenRouterChip', 'KimiChip', 'QuotaChip', 'BalanceChip']

test('one helper derives the health; the card line, the four chips and the four panels all use it', () => {
  assert.equal(SOURCE.split('function healthOf(').length - 1, 1, 'healthOf is defined once')
  const health = body('healthOf')
  for (const kind of ['idle', 'ok', 'stale', 'error', 'offline']) assert.ok(health.includes(`'${kind}'`), `healthOf names ${kind}`)
  for (const name of SURFACES) {
    const source = body(name)
    assert.match(source, /\buseHealth\(store\)/, `${name} reads its state through the health helper`)
    assert.ok(!source.includes('wireError'), `${name} no longer reads the Remote envelope itself`)
    assert.ok(!/\bs\.status === 'error'/.test(source), `${name} no longer decides failure on its own`)
  }
  assert.match(body('useHealth'), /healthOf\(useStore\(store\)\)/)
})

test('the chip words come from one shared helper; the visible wording is gathered in one place', () => {
  for (const name of ['OpenRouterChip', 'KimiChip', 'QuotaChip', 'BalanceChip']) {
    const source = body(name)
    assert.match(source, /\bchipFace\(/, `${name} calls the shared chip helper`)
    assert.ok(!source.includes("'!'"), `${name} has no '!' of its own`)
    assert.ok(!source.includes("'unavailable'"), `${name} has no 'unavailable' of its own`)
  }
  assert.equal(SOURCE.split("'!'").length - 1, 1, "one '!' in the whole client")
  for (const phrase of ['stale · read {time}', 'read {time}', 'Refresh failed at {time}: {detail}', 'Refresh failed: {detail}', 'Host not reachable: {message}']) {
    assert.equal(SOURCE.split(`'${phrase}'`).length - 1, 1, `${phrase} is written once`)
  }
  for (const [phrase, count] of [['Refresh failed', 2], ['Host not reachable', 1], ['stale · ', 1]]) {
    assert.equal(SOURCE.split(phrase).length - 1, count, `"${phrase}" appears only in the string table`)
  }
})

// ---------------------------------------------------------------------------
// 2. A collapsed card with stale data
// ---------------------------------------------------------------------------

for (const family of FAMILIES) {
  test(`${family.id}: a collapsed card with stale data keeps the summary, says "stale · read <fetchedAt>" and shows the failure as a status`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const { h, mount } = await mountCard(family, stale(family))
    try {
      const text = textContent(mount.tree)
      assert.ok(text.includes(family.summary), `the old summary stays: ${text}`)
      assert.ok(findByText(mount.tree, `stale · read ${READ}`), `the stale words are visible: ${text}`)
      const status = statusOf(mount.tree)
      assert.ok(status, 'the failure is a status')
      assert.equal(textContent(status), DETAIL)
      const dot = dotOf(mount.tree, family.px)
      assert.notEqual(dot.props.className, `${family.px}-dot ${family.px}-bad`, 'no wordless red dot')
      assert.ok(!text.includes('Usage unavailable'))
    } finally {
      h.dispose()
    }
  })
}

test('a collapsed card with no data says "Usage unavailable" and shows the failure as a status', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { h, mount } = await mountCard(ZHIPU, noData(ZHIPU))
  try {
    assert.ok(findByText(mount.tree, 'Usage unavailable'))
    assert.equal(textContent(statusOf(mount.tree)), 'HTTP 401: Invalid API key.')
    assert.ok(!textContent(mount.tree).includes('stale'))
  } finally {
    h.dispose()
  }
})

test('a ready card shows no stale words and no status line', { timeout: TEST_TIMEOUT_MS }, async () => {
  for (const family of FAMILIES) {
    const { h, mount } = await mountCard(family, family.fixture())
    try {
      const text = textContent(mount.tree)
      assert.ok(text.includes(family.summary))
      assert.ok(!text.includes('stale'), `${family.id}: ${text}`)
      assert.equal(statusOf(mount.tree), null)
    } finally {
      h.dispose()
    }
  }
})

// ---------------------------------------------------------------------------
// 3. The expanded panel: two different times
// ---------------------------------------------------------------------------

for (const family of PANEL_FAMILIES) {
  test(`${family.id} panel: "Refresh failed at <attemptedAt>: <detail>" and "read <fetchedAt>" are two different times`, { timeout: TEST_TIMEOUT_MS }, async () => {
    assert.notEqual(READ, FAILED)
    const { h, mount } = await mountCard(family, stale(family))
    try {
      await expand(mount, family)
      assert.ok(findByText(mount.tree, `Refresh failed at ${FAILED}: ${DETAIL}`), textContent(mount.tree))
      const text = textContent(mount.tree)
      assert.ok(text.includes(`read ${READ}`), 'the last good read time')
      assert.ok(!text.includes(`read ${FAILED}`), 'the failure time is never called a read')
      assert.ok(text.includes(family.panel), 'the last good figures stay')
    } finally {
      h.dispose()
    }
  })

  test(`${family.id} panel: a state from an older Host (no attemptedAt) shows the failure without a time`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const { h, mount } = await mountCard(family, fixtures.olderHost(stale(family)))
    try {
      await expand(mount, family)
      assert.ok(findByText(mount.tree, `Refresh failed: ${DETAIL}`), textContent(mount.tree))
      const text = textContent(mount.tree)
      assert.ok(!text.includes('Refresh failed at'))
      assert.ok(text.includes(`read ${READ}`))
    } finally {
      h.dispose()
    }
  })
}

test('a panel with no data shows the failure with its time and code', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { h, mount } = await mountCard(ZHIPU, noData(ZHIPU))
  try {
    await expand(mount, ZHIPU)
    assert.ok(findByText(mount.tree, `Refresh failed at ${FAILED}: HTTP 401: Invalid API key.`))
    assert.ok(findByText(mount.tree, 'http-401'))
  } finally {
    h.dispose()
  }
})

// ---------------------------------------------------------------------------
// 4. Chips: 'stale' beside the value, 'unavailable' with no data
// ---------------------------------------------------------------------------

for (const family of CHIPS) {
  test(`${family.id} chip: the word "stale" beside the value, "unavailable" with no data, never a bare "!"`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const shown = []
    {
      const { h, mount } = await mountChip(family, stale(family))
      try {
        const button = chipButton(mount.tree)
        const text = textContent(button)
        for (const value of family.chipValues) assert.ok(text.includes(value), `${value} stays: ${text}`)
        assert.ok(findByText(button, 'stale'), `the word stale: ${text}`)
        const label = button.props['aria-label']
        assert.ok(typeof label === 'string' && label.includes('stale') && label.includes(`read ${READ}`) && label.includes(DETAIL), `aria: ${label}`)
        shown.push(text)
      } finally {
        h.dispose()
      }
    }
    {
      const { h, mount } = await mountChip(family, noData(family))
      try {
        const button = chipButton(mount.tree)
        const text = textContent(button)
        assert.ok(findByText(button, 'unavailable'), `the word unavailable: ${text}`)
        for (const value of family.chipValues) assert.ok(!text.includes(value))
        const label = button.props['aria-label']
        assert.ok(typeof label === 'string' && label.includes('unavailable') && label.includes('HTTP 401: Invalid API key.'), `aria: ${label}`)
        shown.push(text)
      } finally {
        h.dispose()
      }
    }
    for (const state of [family.fixture(), fixtures.loading(stale(family)), fixtures.loading(family.fixture(), { keepData: false })]) {
      const { h, mount } = await mountChip(family, state)
      try {
        shown.push(textContent(chipButton(mount.tree)))
      } finally {
        h.dispose()
      }
    }
    for (const text of shown) {
      if (text.includes('!')) assert.ok(/unavailable|stale/.test(text), `a "!" never stands alone: ${text}`)
    }
    assert.ok(!shown[2].includes('stale') && !shown[2].includes('!'), `a ready chip carries no mark: ${shown[2]}`)
  })
}

// ---------------------------------------------------------------------------
// 5. The Remote call itself fails: offline
// ---------------------------------------------------------------------------

/** Let the mocked poll timer fire once and the async tick finish. */
async function pollOnce(mount) {
  mock.timers.tick(5_000)
  for (let index = 0; index < 5; index += 1) await immediate()
  await mount.settle()
}

for (const [how, option] of [['rejected', 'snapshotRejection'], ['answered { ok: false }', 'snapshotFailure']]) {
  test(`a ${how} snapshot poll shows "Host not reachable" with the last data; the next good poll clears it`, { timeout: TEST_TIMEOUT_MS }, async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    let h
    try {
      const usage = createUsageNamespaceStub(fixtures.zhipu())
      h = await bootClient({ namespaces: { zhipuUsage: usage }, activeProvider: ZHIPU.route })
      assert.equal(usage.calls.snapshot, 1, 'the first poll read the good state')
      const card = await h.mountCard(ZHIPU.ns, cardProps(ZHIPU.route))
      const chip = await h.mountChip('zhipu-usage-chip')
      usage[option] = fixtures.HOST_DOWN
      await pollOnce(card)
      await chip.settle()
      assert.equal(usage.calls.snapshot, 2)
      assert.equal(textContent(statusOf(card.tree)), `Host not reachable: ${fixtures.HOST_DOWN}`)
      assert.ok(textContent(card.tree).includes(ZHIPU.summary), 'the last data stays')
      assert.ok(findByText(card.tree, `stale · read ${READ}`))
      assert.ok(textContent(chipButton(chip.tree)).includes('64.0%'))
      assert.ok(findByText(chipButton(chip.tree), 'stale'))
      assert.equal(h.stores.get('zhipu').state.data, usage.state.data, 'the store keeps the Host state, not the failure')

      usage[option] = undefined
      await pollOnce(card)
      await chip.settle()
      assert.equal(usage.calls.snapshot, 3)
      assert.equal(statusOf(card.tree), null, 'the note is gone after a good reply')
      assert.ok(!textContent(card.tree).includes('Host not reachable'))
      assert.ok(!textContent(chip.tree).includes('stale'))
    } finally {
      h?.dispose()
      mock.timers.reset()
    }
  })
}

for (const [how, option] of [['rejected', 'refreshRejection'], ['answered { ok: false }', 'refreshFailure']]) {
  test(`a ${how} Refresh shows "Host not reachable" in the panel with the last data; the next good reply clears it`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const family = PANEL_FAMILIES.find((candidate) => candidate.id === 'deepseek')
    const { h, mount, usage } = await mountCard(family, family.fixture(), { [option]: fixtures.HOST_DOWN })
    try {
      await expand(mount, family)
      await click(mount, findByText(mount.tree, 'Refresh'))
      assert.equal(usage.calls.refresh, 1)
      assert.ok(findByText(mount.tree, `Host not reachable: ${fixtures.HOST_DOWN}`), textContent(mount.tree))
      assert.ok(textContent(mount.tree).includes(family.panel), 'the last data stays')
      assert.ok(textContent(mount.tree).includes(`stale · read ${READ}`))
      const refresh = findByText(mount.tree, 'Refresh')
      assert.ok(refresh && !refresh.props.disabled, 'the button is usable again')

      usage[option] = undefined
      await click(mount, refresh)
      assert.equal(usage.calls.refresh, 2)
      assert.ok(!textContent(mount.tree).includes('Host not reachable'))
      assert.ok(!textContent(mount.tree).includes('stale'))
    } finally {
      h.dispose()
    }
  })
}

test('a Host that goes away mid-refresh leaves no stuck "Refreshing…": every panel can retry while offline', { timeout: TEST_TIMEOUT_MS }, async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    for (const family of PANEL_FAMILIES) {
      const usage = createUsageNamespaceStub(fixtures.loading(family.fixture()))
      const h = await bootClient({ namespaces: { [family.namespace]: usage, providerLogin: createProviderLoginStub({ configured: true }) } })
      try {
        const mount = await h.mountCard(family.ns, cardProps(family.route))
        await expand(mount, family)
        assert.ok(findByText(mount.tree, 'Refreshing…')?.props.disabled, `${family.id}: the Host reports a refresh running`)
        usage.snapshotRejection = fixtures.HOST_DOWN
        await pollOnce(mount)
        assert.ok(findByText(mount.tree, `Host not reachable: ${fixtures.HOST_DOWN}`), `${family.id}: offline`)
        const refresh = findByText(mount.tree, 'Refresh')
        assert.ok(refresh && !refresh.props.disabled, `${family.id}: Refresh is usable while the Host is not reachable`)
      } finally {
        h.dispose()
      }
    }
  } finally {
    mock.timers.reset()
  }
})

test('a Remote failure before any data: the card says "Usage unavailable" with the note, the chip says "unavailable"', { timeout: TEST_TIMEOUT_MS }, async () => {
  const usage = createUsageNamespaceStub(fixtures.zhipu(), { snapshotRejection: fixtures.HOST_DOWN })
  const h = await bootClient({ namespaces: { zhipuUsage: usage }, activeProvider: ZHIPU.route })
  try {
    const card = await h.mountCard(ZHIPU.ns, cardProps(ZHIPU.route))
    assert.ok(findByText(card.tree, 'Usage unavailable'))
    assert.equal(textContent(statusOf(card.tree)), `Host not reachable: ${fixtures.HOST_DOWN}`)
    const chip = await h.mountChip('zhipu-usage-chip')
    assert.ok(findByText(chipButton(chip.tree), 'unavailable'))
    assert.ok(chipButton(chip.tree).props['aria-label'].includes(`Host not reachable: ${fixtures.HOST_DOWN}`))
  } finally {
    h.dispose()
  }
})

test('no empty catch remains in the poll loop or useRefresher', () => {
  assert.ok(!SOURCE.includes('catch(() => {})'))
  // `.catch(() => {})`, or a `catch {}` / `catch (e) {}` block holding only comments.
  const empty = /catch\s*\(\s*\(\s*\w*\s*\)\s*=>\s*\{\s*\}\s*\)|catch\s*(?:\(\s*\w*\s*\)\s*)?\{(?:\s*\/\/[^\n]*)*\s*\}/
  const refresher = body('useRefresher')
  assert.ok(refresher.includes('.catch('), 'useRefresher handles a rejected refresh')
  assert.ok(!empty.test(refresher), refresher)
  const start = SOURCE.indexOf('/** ONE poll loop per provider')
  const end = SOURCE.indexOf('`usage: poll ${p.namespace}`')
  assert.ok(start > 0 && end > start)
  const poll = SOURCE.slice(start, end)
  assert.ok(poll.includes('catch'), 'the poll loop handles a rejected snapshot')
  assert.ok(!empty.test(poll), poll)
})

// ---------------------------------------------------------------------------
// 6. The stale mark survives the next 'loading' state
// ---------------------------------------------------------------------------

test('the stale mark survives the next loading state on the card, the chip and the panel', { timeout: TEST_TIMEOUT_MS }, async () => {
  const state = fixtures.loading(stale(ZHIPU))
  const { h, mount } = await mountCard(ZHIPU, state)
  try {
    assert.ok(findByText(mount.tree, `stale · read ${READ}`))
    assert.equal(textContent(statusOf(mount.tree)), DETAIL)
    await expand(mount, ZHIPU)
    assert.ok(findByText(mount.tree, `Refresh failed at ${FAILED}: ${DETAIL}`))
    assert.ok(findByText(mount.tree, 'Refreshing…'))
  } finally {
    h.dispose()
  }
  const chip = await mountChip(CHIPS.find((family) => family.id === 'zhipu'), state)
  try {
    assert.ok(findByText(chipButton(chip.mount.tree), 'stale'))
  } finally {
    chip.h.dispose()
  }
})

test('the last attempt is newer than the last good read: stale even when the failure text is gone', { timeout: TEST_TIMEOUT_MS }, async () => {
  const state = { ...fixtures.loading(stale(ZHIPU)), error: null, detail: null }
  assert.ok(state.attemptedAt > state.fetchedAt)
  const { h, mount } = await mountCard(ZHIPU, state)
  try {
    assert.ok(findByText(mount.tree, `stale · read ${READ}`), textContent(mount.tree))
    await expand(mount, ZHIPU)
    assert.ok(textContent(mount.tree).includes(`Refresh failed at ${FAILED}`))
  } finally {
    h.dispose()
  }
  const chip = await mountChip(CHIPS.find((family) => family.id === 'zhipu'), state)
  try {
    assert.ok(findByText(chipButton(chip.mount.tree), 'stale'))
  } finally {
    chip.h.dispose()
  }
})

test('a refresh after a good read (loading, attemptedAt equal to fetchedAt) is not stale', { timeout: TEST_TIMEOUT_MS }, async () => {
  for (const state of [ZHIPU.fixture(), fixtures.loading(ZHIPU.fixture())]) {
    const { h, mount } = await mountCard(ZHIPU, state)
    try {
      assert.ok(textContent(mount.tree).includes(ZHIPU.summary))
      assert.ok(!textContent(mount.tree).includes('stale'))
      assert.equal(statusOf(mount.tree), null)
    } finally {
      h.dispose()
    }
  }
})

// ---------------------------------------------------------------------------
// 7. Dot at least warn; the numbers keep their own level
// ---------------------------------------------------------------------------

test('the dot of stale data is at least warn; the level class of the numbers does not change', { timeout: TEST_TIMEOUT_MS }, async () => {
  const chipFamily = CHIPS.find((family) => family.id === 'zhipu')
  for (const [fixture, ready, staleLevel] of [[fixtures.zhipu(), 'ok', 'warn'], [fixtures.zhipu({ fiveHour: 0.97 }), 'bad', 'bad']]) {
    const levels = {}
    for (const [name, state] of [['ready', fixture], ['stale', fixtures.failed(fixture)]]) {
      const { h, mount } = await mountCard(ZHIPU, state)
      try {
        levels[name] = { card: dotOf(mount.tree, 'pup').props.className }
        await expand(mount, ZHIPU)
        levels[name].fiveHour = metricValue(mount.tree, '5-hour window').props.className
        levels[name].sevenDay = metricValue(mount.tree, '7-day window').props.className
      } finally {
        h.dispose()
      }
      const chip = await mountChip(chipFamily, state)
      try {
        levels[name].chip = dotOf(chip.mount.tree, 'pup').props.className
      } finally {
        chip.h.dispose()
      }
    }
    assert.equal(levels.ready.card, `pup-dot pup-${ready}`)
    assert.equal(levels.ready.chip, `pup-dot pup-${ready}`)
    assert.equal(levels.stale.card, `pup-dot pup-${staleLevel}`)
    assert.equal(levels.stale.chip, `pup-dot pup-${staleLevel}`)
    assert.equal(levels.stale.fiveHour, levels.ready.fiveHour, 'the 5-hour number keeps its class')
    assert.equal(levels.stale.sevenDay, levels.ready.sevenDay, 'the 7-day number keeps its class')
  }
})

test('every family raises a stale dot to at least warn on the card and the chip', { timeout: TEST_TIMEOUT_MS }, async () => {
  for (const family of CHIPS) {
    const card = family.id === 'minimax' ? null : await mountCard(family, stale(family))
    const chip = await mountChip(family, stale(family))
    try {
      for (const tree of [card?.mount.tree, chip.mount.tree].filter(Boolean)) {
        const cls = dotOf(tree, family.px).props.className
        assert.ok([`${family.px}-dot ${family.px}-warn`, `${family.px}-dot ${family.px}-bad`].includes(cls), `${family.id}: ${cls}`)
      }
    } finally {
      card?.h.dispose()
      chip.h.dispose()
    }
  }
})

// ---------------------------------------------------------------------------
// 8. Gallery scenarios
// ---------------------------------------------------------------------------

test('the gallery shows a stale card, a stale chip, a stale panel and an offline card', { timeout: TEST_TIMEOUT_MS }, async () => {
  const byId = new Map(SCENARIOS.map((scenario) => [scenario.id, scenario]))
  const html = {}
  for (const id of ['stale-card', 'stale-chip', 'stale-panel', 'offline']) {
    assert.ok(byId.has(id), `scenario ${id}`)
    html[id] = (await renderScenario(byId.get(id))).html
  }
  assert.ok(html['stale-card'].includes(`stale · read ${READ}`))
  assert.match(html['stale-card'], /role="status"[^>]*>HTTP 429: Rate limit exceeded/)
  assert.ok(html['stale-chip'].includes('>stale<'))
  assert.ok(html['stale-panel'].includes(`Refresh failed at ${FAILED}: `))
  assert.ok(html['stale-panel'].includes(`read ${READ}`))
  assert.ok(html.offline.includes(`Host not reachable: ${fixtures.HOST_DOWN}`))
  assert.ok(html.offline.includes(`stale · read ${READ}`), 'the offline card keeps its last data')
  for (const [id, text] of Object.entries(html)) {
    for (const bad of ['undefined', 'NaN', '[object Object]']) assert.ok(!text.includes(bad), `${id} contains ${bad}`)
  }
})
