/**
 * One-file HTML gallery of the usage plugin's own markup.
 *
 *   node packages/usage/test/helpers/gallery.mjs            # temp folder
 *   node packages/usage/test/helpers/gallery.mjs --out DIR  # a folder you pick
 *
 * Prints only the path of the written file. The page holds the plugin's own
 * CSS string (captured from src/client.js through the harness), one section
 * per scenario, and every scenario twice: once under an approximate light
 * token sheet and once under an approximate dark one. The token values are
 * NOT exported from the host theme; they prove structure, not colour.
 *
 * The page has no script and no external reference. Open it in a browser
 * (macOS: `open "$(node packages/usage/test/helpers/gallery.mjs)"`) and delete
 * the folder when done.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bootClient, cardProps, change, click, createProviderLoginStub, createUsageNamespaceStub, findByText, findByType,
} from './client-harness.mjs'
import { escapeHtml, toHtml } from './html.mjs'
import * as fixtures from './fixtures.mjs'

export const GALLERY_FILE_NAME = 'usage-gallery.html'
export const TEMP_PREFIX = 'usage-gallery-'

// ---------------------------------------------------------------------------
// Approximate token sheets
// ---------------------------------------------------------------------------

export const LIGHT_TOKENS = {
  '--dsw-alias-label-primary': '#1d1d1f',
  '--dsw-alias-label-secondary': '#6e6e73',
  '--dsw-alias-bg-layer-1': '#ffffff',
  '--dsw-alias-border-l1': 'rgba(0,0,0,.08)',
  '--dsw-alias-border-l2': 'rgba(0,0,0,.16)',
  '--dsw-alias-border-l3': 'rgba(0,0,0,.24)',
  '--dsw-alias-state-success-primary': '#1a9d52',
  '--dsw-alias-state-warn-primary': '#b7791f',
  '--dsw-alias-state-error-primary': '#d1342f',
  '--dsw-alias-settings-card-fill': '#fbfbfc',
  '--dsw-alias-settings-card-stroke': 'rgba(0,0,0,.1)',
  '--dsw-alias-interactive-bg-hover-solid': '#ececf0',
  '--dsw-radius-sm': '6px',
  '--dsw-radius-xl': '14px',
  '--dsw-radius-lg': '16px',
  '--dsw-alias-label-tertiary': '#86868b',
  '--dsw-alias-interactive-bg-hover': 'rgba(38,49,72,.06)',
  '--dsw-specific-menu': 'rgba(248,249,250,.94)',
  '--dsw-menu-backdrop-filter': 'blur(40px) saturate(150%)',
  '--dsw-elevation-prominent': '0 0 0 .5px rgba(0,0,0,.12),0 3px 8px 0 rgba(0,0,0,.04),0 0 20px 0 rgba(0,0,0,.05)',
  '--g-page-bg': '#f2f2f5',
}

export const DARK_TOKENS = {
  '--dsw-alias-label-primary': '#f5f5f7',
  '--dsw-alias-label-secondary': '#a1a1a6',
  '--dsw-alias-bg-layer-1': '#1c1c1e',
  '--dsw-alias-border-l1': 'rgba(255,255,255,.1)',
  '--dsw-alias-border-l2': 'rgba(255,255,255,.2)',
  '--dsw-alias-border-l3': 'rgba(255,255,255,.3)',
  '--dsw-alias-state-success-primary': '#32d583',
  '--dsw-alias-state-warn-primary': '#f5b942',
  '--dsw-alias-state-error-primary': '#ff6b6b',
  '--dsw-alias-settings-card-fill': '#232326',
  '--dsw-alias-settings-card-stroke': 'rgba(255,255,255,.1)',
  '--dsw-alias-interactive-bg-hover-solid': '#2c2c30',
  '--dsw-radius-sm': '6px',
  '--dsw-radius-xl': '14px',
  '--dsw-radius-lg': '16px',
  '--dsw-alias-label-tertiary': '#8e8e93',
  '--dsw-alias-interactive-bg-hover': 'rgba(255,255,255,.08)',
  '--dsw-specific-menu': 'rgba(48,49,54,.94)',
  '--dsw-menu-backdrop-filter': 'blur(40px) saturate(150%)',
  '--dsw-elevation-prominent': '0 0 0 .5px rgba(255,255,255,.16),0 3px 8px 0 rgba(0,0,0,.04),0 0 20px 0 rgba(0,0,0,.05)',
  '--g-page-bg': '#111113',
}

function tokenSheet(selector, label, tokens) {
  const lines = Object.entries(tokens).map(([name, value]) => `${name}:${value};`).join('')
  return `/* ${label}: approximate values, not exported from the host theme */\n${selector}{${lines}}`
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const PROVIDERS = {
  openrouter: { title: 'OpenRouter', short: 'OpenRouter', route: 'openrouter', settingsNs: 'llm-pi-ai', namespace: 'openrouterUsage', fixture: fixtures.openrouter },
  kimi: { title: 'Kimi Code', short: 'Kimi', route: 'kimi-coding', settingsNs: 'llm-pi-ai', namespace: 'kimiUsage', fixture: fixtures.kimi },
  zhipu: { title: 'GLM Coding Plan', short: 'GLM', route: 'zai-coding-cn', settingsNs: 'llm-pi-ai', namespace: 'zhipuUsage', fixture: fixtures.zhipu },
  deepseek: { title: 'DeepSeek', short: 'DeepSeek', route: 'deepseek-official', settingsNs: 'llm-deepseek', namespace: 'deepseekUsage', fixture: fixtures.deepseek },
  codex: { title: 'OpenAI Codex', short: 'Codex', route: 'openai-codex', settingsNs: 'llm-pi-ai', namespace: 'codexUsage', fixture: fixtures.codex, oauth: true, signIn: 'Sign in with ChatGPT' },
  anthropic: { title: 'Claude', short: 'Claude', route: 'anthropic', settingsNs: 'llm-pi-ai', namespace: 'anthropicUsage', fixture: fixtures.anthropic, oauth: true, signIn: 'Sign in with Claude' },
}

const must = (value, message) => {
  if (!value) throw new Error(message)
  return value
}

/** Press the panel's Refresh button (the panel must be open). */
async function pressRefresh(id, mount) {
  const button = must(findByText(mount.tree, 'Refresh'), `${id}: no "Refresh" button`)
  await click(mount, button)
}

/**
 * A provider card (usage line), optionally expanded to its full panel.
 * `stub` passes options to the usage namespace stub (a failing snapshot or
 * refresh); `refresh` presses Refresh once (the card is opened for it and
 * closed again unless `expand`).
 */
function cardScenario({ id, provider, title, note, state, stub, refresh = false, expand = false, expectEmpty = false, group = 'Provider cards' }) {
  const spec = PROVIDERS[provider]
  return {
    id,
    group,
    title,
    note,
    expectEmpty,
    async run() {
      const namespaces = { providerLogin: createProviderLoginStub({ configured: true }) }
      if (state || stub) namespaces[spec.namespace] = createUsageNamespaceStub(state, stub)
      const h = await bootClient({ namespaces })
      try {
        const props = cardProps(spec.route, { oauth: spec.oauth === true, keyConfigured: spec.oauth !== true })
        const mount = await h.mountCard(spec.settingsNs, props)
        const toggle = () => must(findByType(mount.tree, 'button'), `${id}: the card has no expand button`)
        if (expand || refresh) await click(mount, toggle())
        if (refresh) {
          await pressRefresh(id, mount)
          if (!expand) await click(mount, toggle())
        }
        return { html: toHtml(mount.tree), css: h.stylesheet }
      } finally {
        h.dispose()
      }
    },
  }
}

/**
 * The stage an open chip is drawn on. The popover is `position: fixed` and
 * placed by the client's own measurement; on this page the stage has a
 * transform, which makes it the box a fixed descendant is placed in, and the
 * harness viewport has the stage's size. So the popover lands where the
 * client put it relative to a chip drawn at `anchor` (default: low in the
 * stage, like the composer dock).
 */
export const POP_STAGE = { width: 600, height: 560 }
const POP_ANCHOR = { left: 150, top: 516 }
/** The approximate chip and panel sizes the harness reports for the measurement. */
const CHIP_SIZE = { width: 170, height: 22 }
const PANEL_SIZE = { width: 420, height: 380 }

function stageRects(anchor) {
  const trigger = { left: anchor.left, top: anchor.top, width: CHIP_SIZE.width, height: CHIP_SIZE.height, right: anchor.left + CHIP_SIZE.width, bottom: anchor.top + CHIP_SIZE.height }
  const panel = { left: 0, top: 0, width: PANEL_SIZE.width, height: PANEL_SIZE.height, right: PANEL_SIZE.width, bottom: PANEL_SIZE.height }
  return (node) => (node?.props?.role === 'dialog' ? panel : trigger)
}

/**
 * A composer dock chip, optionally with its popover open. `stub` and
 * `refresh` work as for cards: the popover opens for the Refresh and closes
 * again unless `open`. `anchor` moves the chip on the stage (the placement
 * clamps).
 */
function chipScenario({ id, provider, title, note, state, stub, refresh = false, open = false, waiting = false, anchor = POP_ANCHOR, group = 'Composer chips' }) {
  const spec = PROVIDERS[provider]
  return {
    id,
    group,
    title,
    note,
    popover: open,
    anchor: open ? anchor : null,
    async run() {
      const namespaces = state || stub ? { [spec.namespace]: createUsageNamespaceStub(state, stub) } : {}
      const h = await bootClient({ namespaces, activeProvider: spec.route, viewport: POP_STAGE })
      try {
        if (waiting) h.stores.get(provider).waiting = true
        const mount = await h.mountChip(`${provider}-usage-chip`, {}, { rect: stageRects(anchor) })
        const chip = () => must(findByType(mount.tree, 'button'), `${id}: the chip has no button`)
        if (open || refresh) await click(mount, chip())
        if (refresh) {
          await pressRefresh(id, mount)
          if (!open) await click(mount, chip())
        }
        return { html: toHtml(mount.tree), css: h.stylesheet }
      } finally {
        h.dispose()
      }
    },
  }
}

/** The OAuth sign-in action, driven through a stub providerLogin stream. */
function signInScenario({ id, provider, title, note, login = {}, clickSignIn = false, answer, cancel = false, keyConfigured = false }) {
  const spec = PROVIDERS[provider]
  return {
    id,
    group: 'Sign-in',
    title,
    note,
    async run() {
      const stub = createProviderLoginStub(login)
      const h = await bootClient({ namespaces: { providerLogin: stub } })
      try {
        const mount = await h.mountCard(spec.settingsNs, cardProps(spec.route, { oauth: true, keyConfigured }))
        if (clickSignIn) {
          const button = must(findByText(mount.tree, spec.signIn), `${id}: no "${spec.signIn}" button`)
          void click(mount, button)
          await mount.settle()
        }
        if (answer !== undefined) {
          const control = must(findByType(mount.tree, 'select') ?? findByType(mount.tree, 'input'), `${id}: no prompt control`)
          await change(mount, control, answer)
        }
        if (cancel) {
          const button = must(findByText(mount.tree, 'Cancel'), `${id}: no "Cancel" button`)
          await click(mount, button)
        }
        return { html: toHtml(mount.tree), css: h.stylesheet }
      } finally {
        h.dispose()
      }
    },
  }
}

/**
 * The card right after a sign-in settled: the usage namespace still holds the
 * error the missing credential left, and its refresh has not answered yet.
 */
function refreshingAfterSignInScenario({ id, provider, title, note }) {
  const spec = PROVIDERS[provider]
  return {
    id,
    group: 'Sign-in',
    title,
    note,
    async run() {
      let release
      const gate = new Promise((resolve) => { release = resolve })
      const stale = fixtures.failed(ready(provider), { error: 'missing-credential', detail: 'No sign-in found for llm-pi-ai/anthropic. Sign in from Settings → Models or run /provider-login anthropic.', keepData: false })
      const usage = createUsageNamespaceStub(stale, { refreshState: ready(provider), refreshGate: gate })
      const login = createProviderLoginStub({ events: [{ type: 'settled', status: 'authorized' }] })
      const h = await bootClient({ namespaces: { providerLogin: login, [spec.namespace]: usage } })
      try {
        const mount = await h.mountCard(spec.settingsNs, cardProps(spec.route, { oauth: true, keyConfigured: false }))
        const button = must(findByText(mount.tree, spec.signIn), `${id}: no "${spec.signIn}" button`)
        await click(mount, button)
        return { html: toHtml(mount.tree), css: h.stylesheet }
      } finally {
        release()
        h.dispose()
      }
    },
  }
}

const withClaudeExtra = (extra) => {
  const state = fixtures.anthropic()
  return { ...state, data: { ...state.data, extra } }
}

const notice = { type: 'notice', notice: { message: 'Finish signing in in the browser window that opened.', url: 'https://auth.example.com/device', code: 'ABCD-1234' } }
const selectPrompt = {
  type: 'prompt',
  id: 'prompt-1',
  prompt: {
    kind: 'select',
    message: 'Choose an account',
    options: [{ id: 'personal', label: 'Personal account' }, { id: 'team', label: 'Team workspace' }, { id: 'edu', label: 'Education plan' }],
  },
}
const textPrompt = { type: 'prompt', id: 'prompt-2', prompt: { kind: 'text', message: 'Enter the organisation name', placeholder: 'organisation name' } }
const secretPrompt = { type: 'prompt', id: 'prompt-3', prompt: { kind: 'secret', message: 'Paste the one-time code', placeholder: 'one-time code' } }

const longLinkNotice = fixtures.signInNotice({ message: 'Open this link to sign in, then enter the code if asked.', url: fixtures.LONG_AUTH_URL })
const messagePrompt = fixtures.textPromptEvent({ message: 'Paste the code the browser shows after you approve the sign-in', placeholder: 'authorization code' })

const ready = (provider) => PROVIDERS[provider].fixture()
const errorWithData = (provider, patch) => fixtures.failed(ready(provider), patch)
const errorWithoutData = (provider, patch) => fixtures.failed(ready(provider), { keepData: false, error: 'http-401', detail: 'HTTP 401: Invalid API key. Check the key stored for this provider.', ...patch })

export const SCENARIOS = [
  // ---- cards: collapsed and expanded for each provider ----
  ...Object.keys(PROVIDERS).flatMap((provider) => [
    cardScenario({ id: `${provider}-card-collapsed`, provider, title: `${PROVIDERS[provider].short}: card, collapsed`, note: 'Ready state; the one-line usage summary on the Models card.', state: ready(provider) }),
    cardScenario({ id: `${provider}-card-expanded`, provider, title: `${PROVIDERS[provider].short}: card, expanded`, note: 'Ready state with the full panel opened.', state: ready(provider), expand: true }),
  ]),
  // ---- error and loading states ----
  cardScenario({
    id: 'openrouter-error-with-data',
    provider: 'openrouter',
    title: 'OpenRouter: error with data (expanded)',
    note: 'A failed refresh keeps the last good figures; the panel says when the refresh failed and why, above them. The detail text holds characters that must be escaped.',
    state: errorWithData('openrouter', { error: 'http-400', detail: 'HTTP 400: unknown field <model> in "limit" & more' }),
    expand: true,
    group: 'Error and loading',
  }),
  cardScenario({
    id: 'glm-error-with-data-collapsed',
    provider: 'zhipu',
    title: 'GLM: error with data (collapsed)',
    note: 'Error status with data: the summary stays, marked "stale · read <time>", the dot turns amber and the failure shows under the line.',
    state: errorWithData('zhipu'),
    group: 'Error and loading',
  }),
  cardScenario({
    id: 'glm-error-without-data',
    provider: 'zhipu',
    title: 'GLM: error without data (collapsed)',
    note: 'No data yet: the card shows the error text and "Usage unavailable".',
    state: errorWithoutData('zhipu'),
    group: 'Error and loading',
  }),
  cardScenario({
    id: 'kimi-error-without-data-expanded',
    provider: 'kimi',
    title: 'Kimi: error without data (expanded)',
    note: 'The expanded panel with only the error message and its code.',
    state: errorWithoutData('kimi', { error: 'network', detail: 'The request to the usage endpoint timed out.' }),
    expand: true,
    group: 'Error and loading',
  }),
  cardScenario({
    id: 'deepseek-wire-error',
    provider: 'deepseek',
    title: 'DeepSeek: Remote call failed, no data yet',
    note: 'The snapshot Remote call itself answered { ok: false } before any good read: "Usage unavailable" and the Host-not-reachable note.',
    stub: { snapshotFailure: fixtures.wireFailure().error.message },
    group: 'Error and loading',
  }),
  cardScenario({
    id: 'codex-loading-with-data',
    provider: 'codex',
    title: 'Codex: refreshing with data (expanded)',
    note: 'A refresh in flight: the button reads "Refreshing…" and stays disabled.',
    state: fixtures.loading(ready('codex')),
    expand: true,
    group: 'Error and loading',
  }),
  cardScenario({
    id: 'glm-loading-no-data',
    provider: 'zhipu',
    title: 'GLM: loading with no data',
    note: 'Nothing to show yet: the card renders nothing at all.',
    state: fixtures.loading(ready('zhipu'), { keepData: false }),
    expectEmpty: true,
    group: 'Error and loading',
  }),
  // ---- stale and offline: the last good data with an honest mark ----
  cardScenario({
    id: 'stale-card',
    provider: 'zhipu',
    title: 'GLM: stale card (collapsed)',
    note: 'The last refresh failed 7 minutes after the last good read: the old summary, "stale · read <good read time>", an amber dot, and the failure under the line as a status.',
    state: errorWithData('zhipu'),
    group: 'Stale and offline',
  }),
  cardScenario({
    id: 'stale-card-loading',
    provider: 'zhipu',
    title: 'GLM: stale card while the next refresh runs',
    note: 'Status "loading" after the failure: the Host keeps the error, so the stale mark and the failure stay instead of flickering away.',
    state: fixtures.loading(errorWithData('zhipu')),
    group: 'Stale and offline',
  }),
  cardScenario({
    id: 'stale-panel',
    provider: 'anthropic',
    title: 'Claude: stale panel (expanded)',
    note: '"Refresh failed at <attempt time>: <detail>" above the figures and "stale · read <good read time>" in the footer: two different times.',
    state: errorWithData('anthropic'),
    expand: true,
    group: 'Stale and offline',
  }),
  cardScenario({
    id: 'stale-panel-older-host',
    provider: 'deepseek',
    title: 'DeepSeek: stale panel from an older Host',
    note: 'An older Host sends no attemptedAt: the failure shows without a time ("Refresh failed: <detail>").',
    state: fixtures.olderHost(errorWithData('deepseek', { error: 'timeout', detail: 'No reply within 15000 ms.' })),
    expand: true,
    group: 'Stale and offline',
  }),
  chipScenario({
    id: 'stale-chip',
    provider: 'zhipu',
    title: 'GLM chip: stale',
    note: 'The value stays with the word "stale" beside it; the dot is raised from green to amber.',
    state: errorWithData('zhipu'),
    group: 'Stale and offline',
  }),
  chipScenario({
    id: 'stale-chip-popover',
    provider: 'kimi',
    title: 'Kimi chip: stale, popover open',
    note: 'The stale chip and its panel: the failure with its time, the figures, and the stale read time.',
    state: errorWithData('kimi'),
    open: true,
    group: 'Stale and offline',
  }),
  cardScenario({
    id: 'offline',
    provider: 'deepseek',
    title: 'DeepSeek: Host not reachable (expanded)',
    note: 'The Refresh Remote call was rejected: "Host not reachable: <message>" while the last data stays, marked stale. The next good reply clears it.',
    state: ready('deepseek'),
    stub: { refreshRejection: fixtures.HOST_DOWN },
    refresh: true,
    expand: true,
    group: 'Stale and offline',
  }),
  cardScenario({
    id: 'offline-answered',
    provider: 'deepseek',
    title: 'DeepSeek: Host not reachable, answered { ok: false } (expanded)',
    note: 'The same lost connection on the other channel: the Refresh Remote call answered { ok: false } with the carrier code gateway/internal. The wording and the stale data match the rejected call above.',
    state: ready('deepseek'),
    stub: { refreshFailure: fixtures.LOST_CONNECTION },
    refresh: true,
    expand: true,
    group: 'Stale and offline',
  }),
  cardScenario({
    id: 'not-mounted',
    provider: 'deepseek',
    title: 'DeepSeek: provider not mounted (collapsed)',
    note: 'The Host has no deepseekUsage service (the row is disabled or its mount failed) while other providers answer: a neutral line with the Gateway message, no red, no "Host not reachable". The composer chip is not drawn at all for it (a hidden chip cannot be shown on this page; test/stale-ui.test.mjs checks it).',
    stub: { snapshotFailure: fixtures.notMounted('deepseekUsage') },
    group: 'Stale and offline',
  }),
  cardScenario({
    id: 'not-mounted-expanded',
    provider: 'deepseek',
    title: 'DeepSeek: provider not mounted (expanded)',
    note: 'The open panel: "Usage is not available for this provider: <message>" in the secondary colour, and the failure code.',
    stub: { snapshotFailure: fixtures.notMounted('deepseekUsage') },
    expand: true,
    group: 'Stale and offline',
  }),
  cardScenario({
    id: 'offline-collapsed',
    provider: 'openrouter',
    title: 'OpenRouter: Host not reachable (collapsed)',
    note: 'The same on the collapsed line: old summary, stale mark, and the note as a status.',
    state: ready('openrouter'),
    stub: { refreshRejection: fixtures.HOST_DOWN },
    refresh: true,
    group: 'Stale and offline',
  }),
  chipScenario({
    id: 'offline-chip',
    provider: 'openrouter',
    title: 'OpenRouter chip: Host not reachable',
    note: 'After a rejected Refresh the chip keeps its values with the word "stale".',
    state: ready('openrouter'),
    stub: { refreshRejection: fixtures.HOST_DOWN },
    refresh: true,
    group: 'Stale and offline',
  }),
  // ---- chips ----
  chipScenario({ id: 'chip-openrouter', provider: 'openrouter', title: 'OpenRouter chip', note: 'Used amount plus the account balance left; green dot.', state: ready('openrouter') }),
  chipScenario({ id: 'chip-openrouter-low', provider: 'openrouter', title: 'OpenRouter chip, low budget', note: 'Remaining budget under 20%: amber dot.', state: fixtures.openrouter({ remaining: 6, limit: 50, account: { totalCredits: 100, totalUsage: 99, remaining: 1 } }) }),
  chipScenario({ id: 'chip-kimi', provider: 'kimi', title: 'Kimi chip (quota chip with extra balance)', note: 'Worst quota percentage plus the Extra Usage balance; amber dot at 81%.', state: ready('kimi') }),
  chipScenario({ id: 'chip-codex', provider: 'codex', title: 'Codex chip (same chip type as Kimi)', note: 'Worst window percentage plus the credit balance.', state: ready('codex') }),
  chipScenario({
    id: 'chip-claude-extra-disabled',
    provider: 'anthropic',
    title: 'Claude chip, extra usage disabled',
    note: 'The account turned extra usage off: the chip shows the weekly percentage only, no extra amount.',
    state: withClaudeExtra({ enabled: false, balanceCents: 0, monthlyLimitCents: null, usedRatio: null, currency: 'USD', disabledReason: 'overage_not_provisioned' }),
  }),
  chipScenario({ id: 'chip-glm', provider: 'zhipu', title: 'GLM chip (generic quota chip)', note: 'Worst window percentage.', state: ready('zhipu') }),
  chipScenario({ id: 'chip-deepseek', provider: 'deepseek', title: 'DeepSeek chip (balance chip)', note: 'First balance entry.', state: ready('deepseek') }),
  chipScenario({ id: 'chip-deepseek-low', provider: 'deepseek', title: 'DeepSeek chip, nearly empty', note: 'Balance of one unit or less: amber dot.', state: fixtures.deepseek({ cny: 0.6 }) }),
  chipScenario({ id: 'chip-error', provider: 'zhipu', title: 'Chip after a failed first read', note: 'No data and an error: the chip says "unavailable" (the "!" mark only beside it) and the dot is red.', state: errorWithoutData('zhipu') }),
  chipScenario({ id: 'chip-loading', provider: 'kimi', title: 'Chip while loading', note: 'No data yet: the chip shows the word "usage".', state: fixtures.loading(ready('kimi'), { keepData: false }) }),
  chipScenario({ id: 'chip-anthropic', provider: 'anthropic', title: 'Claude chip (same chip type as Kimi)', note: 'Weekly percentage plus the extra usage used; amber dot at 88%.', state: ready('anthropic') }),
  chipScenario({ id: 'chip-popover-glm', provider: 'zhipu', title: 'GLM chip, popover open', note: 'Clicking the chip opens the full panel above it, as a dialog portaled to the page body; the most used window is the labelled bar.', state: ready('zhipu'), open: true }),
  chipScenario({ id: 'chip-popover-openrouter', provider: 'openrouter', title: 'OpenRouter chip, popover open', note: 'The key and account sections in the popover, each budget bar with its caption.', state: ready('openrouter'), open: true }),
  chipScenario({ id: 'chip-popover-kimi', provider: 'kimi', title: 'Kimi chip, popover open', note: 'Quota windows, requests and the Extra Usage wallet; the 7-day window is the labelled bar.', state: ready('kimi'), open: true }),
  chipScenario({ id: 'chip-popover-codex', provider: 'codex', title: 'Codex chip, popover open', note: 'Plan windows, credits and reset credits.', state: ready('codex'), open: true }),
  chipScenario({ id: 'chip-popover-anthropic', provider: 'anthropic', title: 'Claude chip, popover open', note: 'Weekly windows, the scoped limit, extra usage and spend; the bar under the figures is captioned with its window.', state: ready('anthropic'), open: true }),
  chipScenario({ id: 'chip-popover-deepseek', provider: 'deepseek', title: 'DeepSeek chip, popover open', note: 'The balance panel: one row per currency, no bar.', state: ready('deepseek'), open: true }),
  chipScenario({ id: 'chip-popover-left-edge', provider: 'zhipu', title: 'GLM chip at the left window edge, popover open', note: 'The chip starts 4px from the edge: the measured placement shifts the popover to 12px inside.', state: ready('zhipu'), open: true, anchor: { left: 4, top: 516 } }),
  chipScenario({ id: 'chip-popover-below', provider: 'zhipu', title: 'GLM chip near the top of the window, popover open', note: 'No room above the chip: the popover opens 8px below it, with a max-height that keeps it 12px above the window bottom.', state: ready('zhipu'), open: true, anchor: { left: 150, top: 20 } }),
  chipScenario({ id: 'chip-popover-waiting', provider: 'deepseek', title: 'DeepSeek chip, host service unreachable', note: 'Idle with the "usage host service is not reachable" hint.', waiting: true, open: true }),
  cardScenario({
    id: 'labelled-bar-claude',
    provider: 'anthropic',
    title: 'Claude: the labelled worst-window bar (expanded card)',
    note: 'The live case: the 7-day window at 74%. The bar under the figures has its own caption ("7-day window 74.0% used") and is a progressbar, so it no longer reads as the bar of the last metric row.',
    state: fixtures.anthropic({ sevenDay: 0.74 }),
    expand: true,
  }),
  // ---- sign-in ----
  signInScenario({ id: 'signin-checking', provider: 'codex', title: 'Sign-in: checking the stored state', note: 'The status call has not answered yet.', login: { status: 'pending' } }),
  signInScenario({ id: 'signin-signed-out', provider: 'codex', title: 'Sign-in: signed out (ChatGPT)', note: 'No stored OAuth record and no key: the sign-in button.', login: { configured: false } }),
  signInScenario({ id: 'signin-signed-out-claude', provider: 'anthropic', title: 'Sign-in: signed out (Claude)', note: 'The same action for the Claude route.', login: { configured: false } }),
  signInScenario({ id: 'signin-status-error', provider: 'anthropic', title: 'Sign-in: status call failed', note: 'The status read failed: the message appears under the button.', login: { status: 'error', statusError: 'The provider login service is unreachable.' } }),
  signInScenario({ id: 'signin-notice', provider: 'codex', title: 'Sign-in: waiting, with link and code', note: 'A notice with a URL and a device code while the flow is open.', login: { events: [notice], hold: true }, clickSignIn: true }),
  signInScenario({ id: 'signin-prompt-select', provider: 'codex', title: 'Sign-in: prompt, select', note: 'A select prompt; the first option is preselected.', login: { events: [notice, selectPrompt], hold: true }, clickSignIn: true }),
  signInScenario({ id: 'signin-prompt-select-chosen', provider: 'codex', title: 'Sign-in: prompt, select, third option chosen', note: 'The same prompt after the user picked another option.', login: { events: [notice, selectPrompt], hold: true }, clickSignIn: true, answer: 'edu' }),
  signInScenario({ id: 'signin-prompt-text', provider: 'anthropic', title: 'Sign-in: prompt, text', note: 'A plain text input with a placeholder.', login: { events: [textPrompt], hold: true }, clickSignIn: true }),
  signInScenario({ id: 'signin-prompt-secret', provider: 'anthropic', title: 'Sign-in: prompt, secret', note: 'A password input; the value never shows.', login: { events: [secretPrompt], hold: true }, clickSignIn: true }),
  signInScenario({ id: 'signin-cancelled', provider: 'codex', title: 'Sign-in: cancelled', note: 'The flow settled as cancelled: the button comes back with a note.', login: { events: [{ type: 'settled', status: 'cancelled' }] }, clickSignIn: true }),
  signInScenario({ id: 'signin-prompt-with-message', provider: 'codex', title: 'Sign-in: prompt with its message, long link and code', note: 'The host message labels the input; the 340-character link wraps and the code is its own line; Cancel sits next to the waiting button.', login: { events: [longLinkNotice, messagePrompt], hold: true }, clickSignIn: true }),
  signInScenario({ id: 'signin-cancelled-by-user', provider: 'codex', title: 'Sign-in: cancelled with the Cancel button', note: 'The user pressed Cancel while the flow waited: the stream is closed, the button comes back and a note says so.', login: { events: [longLinkNotice], hold: true }, clickSignIn: true, cancel: true }),
  signInScenario({ id: 'signin-error', provider: 'anthropic', title: 'Sign-in: the flow failed', note: 'The stream broke: the error shows in red and is announced as an alert (a notice is only a status).', login: { events: [fixtures.signInNotice()], failWith: 'The browser callback timed out. Try signing in again.' }, clickSignIn: true }),
  signInScenario({ id: 'signin-signed-in', provider: 'codex', title: 'Sign-in: signed in (ChatGPT)', note: 'A stored OAuth record: the status row and a re-authenticate button.', login: { configured: true } }),
  refreshingAfterSignInScenario({
    id: 'signin-claude-refreshing',
    provider: 'anthropic',
    title: 'Sign-in: signed in, usage refreshing (Claude)',
    note: 'Right after the sign-in settled: "Signed in with Claude" and a loading line, not the old missing-credential error.',
  }),
  signInScenario({ id: 'signin-signed-in-claude', provider: 'anthropic', title: 'Sign-in: signed in (Claude)', note: 'The same row for the Claude route.', login: { configured: true } }),
]

// ---------------------------------------------------------------------------
// Rendering and page assembly
// ---------------------------------------------------------------------------

/** Render one scenario. Throws on any failure; never returns a partial entry. */
export async function renderScenario(scenario) {
  const { html, css } = await scenario.run()
  if (typeof html !== 'string') throw new Error(`${scenario.id}: no HTML was produced`)
  if (html === '' && scenario.expectEmpty !== true) throw new Error(`${scenario.id}: the scenario rendered nothing`)
  return {
    id: scenario.id,
    group: scenario.group,
    title: scenario.title,
    note: scenario.note,
    popover: scenario.popover === true,
    anchor: scenario.anchor ?? null,
    expectEmpty: scenario.expectEmpty === true,
    html,
    css,
  }
}

/** Render every scenario in order. The plugin CSS must be the same in all of them. */
export async function renderAll(scenarios = SCENARIOS) {
  const rendered = []
  for (const scenario of scenarios) rendered.push(await renderScenario(scenario))
  if (rendered.length !== scenarios.length) throw new Error('a scenario was skipped')
  const css = rendered[0]?.css ?? ''
  if (!css) throw new Error('the harness captured no stylesheet')
  for (const entry of rendered) {
    if (entry.css !== css) throw new Error(`${entry.id}: the stylesheet differs from the first scenario`)
  }
  return { rendered, css }
}

const PAGE_CSS = `
*{box-sizing:border-box}
body{margin:0;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#e8e8ec;color:#1d1d1f}
.g-header{padding:20px 28px;background:#fff;border-bottom:1px solid #d0d0d6}
.g-header h1{margin:0 0 6px;font-size:20px}
.g-banner{margin:8px 0 0;padding:8px 12px;border-radius:6px;background:#fff6e0;border:1px solid #e8c36a;color:#5c4400;max-width:900px}
.g-nav{padding:12px 28px;background:#f6f6f8;border-bottom:1px solid #d0d0d6}
.g-nav h2{margin:8px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#6e6e73}
.g-nav a{display:inline-block;margin:0 10px 2px 0;color:#0b57d0;text-decoration:none}
.g-main{padding:8px 28px 40px}
.g-group{margin:28px 0 8px;font-size:16px}
.g-scenario{margin:0 0 22px}
.g-scenario h3{margin:0;font-size:14px}
.g-scenario h3 code{font-weight:400;font-size:12px;color:#6e6e73;margin-left:6px}
.g-note{margin:2px 0 8px;color:#55555a;max-width:900px}
.g-pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:12px}
.g-theme{margin:0;border-radius:10px;border:1px solid #c8c8ce;overflow:hidden;background:var(--g-page-bg);color:var(--dsw-alias-label-primary);color-scheme:light}
.g-theme.theme-dark{color-scheme:dark}
.g-theme figcaption{padding:4px 12px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1)}
.g-stage{padding:12px 16px 16px;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.g-stage-pop{position:relative;transform:translateZ(0);width:${POP_STAGE.width}px;max-width:100%;height:${POP_STAGE.height}px;padding:0;overflow:hidden}
.g-anchor{position:absolute}
.g-empty{font-style:italic;color:var(--dsw-alias-label-secondary)}
.dsw-primitive{font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:transparent;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);height:28px;padding:0 10px;cursor:default}
.dsw-primitive:disabled{opacity:.5}
.g-stage a{color:#2f7cf6}
`

function sectionHtml(entry) {
  let stage = entry.html === '' ? '<span class="g-empty">(renders nothing)</span>' : entry.html
  // An open chip sits where the harness measured it; its fixed popover is placed in the transformed stage.
  if (entry.popover && entry.anchor) stage = `<div class="g-anchor" style="left:${Number(entry.anchor.left)}px;top:${Number(entry.anchor.top)}px">${stage}</div>`
  const stageClass = entry.popover ? 'g-stage g-stage-pop' : 'g-stage'
  const panel = (theme, label) => `<figure class="g-theme theme-${theme}"><figcaption>${label}</figcaption><div class="${stageClass}">${stage}</div></figure>`
  return `<section class="g-scenario" id="s-${escapeHtml(entry.id)}">
<h3>${escapeHtml(entry.title)}<code>${escapeHtml(entry.id)}</code></h3>
<p class="g-note">${escapeHtml(entry.note ?? '')}</p>
<div class="g-pair">${panel('light', 'light (approximate tokens)')}${panel('dark', 'dark (approximate tokens)')}</div>
</section>`
}

/** Assemble the single self-contained page. */
export function buildGalleryHtml(rendered, pluginCss) {
  if (pluginCss.toLowerCase().includes('</style')) throw new Error('the plugin CSS would end the style element')
  const groups = []
  for (const entry of rendered) {
    let group = groups.find((candidate) => candidate.name === entry.group)
    if (!group) {
      group = { name: entry.group, entries: [] }
      groups.push(group)
    }
    group.entries.push(entry)
  }
  const nav = groups.map((group) => `<h2>${escapeHtml(group.name)}</h2>${group.entries.map((entry) => `<a href="#s-${escapeHtml(entry.id)}">${escapeHtml(entry.id)}</a>`).join('')}`).join('')
  const body = groups.map((group) => `<h2 class="g-group">${escapeHtml(group.name)}</h2>${group.entries.map(sectionHtml).join('\n')}`).join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Usage plugin gallery</title>
<style>
/* page chrome */${PAGE_CSS}
/* token sheets */
${tokenSheet('.theme-light', 'light tokens', LIGHT_TOKENS)}
${tokenSheet('.theme-dark', 'dark tokens', DARK_TOKENS)}
/* the plugin's own CSS string, verbatim from src/client.js */
${pluginCss}
</style>
</head>
<body>
<header class="g-header">
<h1>Usage plugin gallery</h1>
<p>${rendered.length} scenarios, each rendered by the plugin's own client code with fake data, under a light and a dark token sheet.</p>
<p class="g-banner">The token values below are approximate. They were written by hand, not exported from the host theme, so this page shows structure and layout, not exact colour. Host primitives (the sign-in buttons) are drawn as plain buttons. An open chip popover is a fixed dialog the client portals to the page body; here each one is drawn where the client's own measurement placed it, on a stage the size of the harness viewport (${POP_STAGE.width} x ${POP_STAGE.height}).</p>
</header>
<nav class="g-nav">${nav}</nav>
<main class="g-main">
${body}
</main>
</body>
</html>
`
}

/**
 * Render everything and write ONE file. Without `out` the file goes into a
 * fresh mkdtemp folder under os.tmpdir(); with `out` it goes into that folder.
 * Returns the file path.
 */
export async function writeGallery({ out } = {}) {
  const { rendered, css } = await renderAll()
  const page = buildGalleryHtml(rendered, css)
  let folder
  if (out) {
    folder = resolve(out)
    await mkdir(folder, { recursive: true })
  } else {
    folder = await mkdtemp(join(tmpdir(), TEMP_PREFIX))
  }
  const file = join(folder, GALLERY_FILE_NAME)
  await writeFile(file, page, 'utf8')
  return file
}

async function main(argv) {
  let out
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') {
      out = argv[index + 1]
      index += 1
      if (!out) throw new Error('--out needs a folder')
    } else {
      throw new Error(`unknown argument ${argv[index]}`)
    }
  }
  process.stdout.write(`${await writeGallery({ out })}\n`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`)
    process.exitCode = 1
  })
}
