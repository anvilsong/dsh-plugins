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

/** A provider card (usage line), optionally expanded to its full panel. */
function cardScenario({ id, provider, title, note, state, expand = false, expectEmpty = false, group = 'Provider cards' }) {
  const spec = PROVIDERS[provider]
  return {
    id,
    group,
    title,
    note,
    expectEmpty,
    async run() {
      const namespaces = { providerLogin: createProviderLoginStub({ configured: true }) }
      if (state) namespaces[spec.namespace] = createUsageNamespaceStub(state)
      const h = await bootClient({ namespaces })
      try {
        const props = cardProps(spec.route, { oauth: spec.oauth === true, keyConfigured: spec.oauth !== true })
        const mount = await h.mountCard(spec.settingsNs, props)
        if (expand) {
          const toggle = must(findByType(mount.tree, 'button'), `${id}: the card has no expand button`)
          await click(mount, toggle)
        }
        return { html: toHtml(mount.tree), css: h.stylesheet }
      } finally {
        h.dispose()
      }
    },
  }
}

/** A composer dock chip, optionally with its popover open. */
function chipScenario({ id, provider, title, note, state, open = false, waiting = false }) {
  const spec = PROVIDERS[provider]
  return {
    id,
    group: 'Composer chips',
    title,
    note,
    popover: open,
    async run() {
      const namespaces = state ? { [spec.namespace]: createUsageNamespaceStub(state) } : {}
      const h = await bootClient({ namespaces, activeProvider: spec.route })
      try {
        if (waiting) h.stores.get(provider).waiting = true
        const mount = await h.mountChip(`${provider}-usage-chip`)
        if (open) {
          const chip = must(findByType(mount.tree, 'button'), `${id}: the chip has no button`)
          await click(mount, chip)
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
      const stale = fixtures.failed(ready(provider), { error: 'missing-credential', detail: 'No value for llm-pi-ai/anthropic. Add the API key in Settings → Models.', keepData: false })
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
    note: 'A failed refresh keeps the last good figures and shows the error above them. The detail text holds characters that must be escaped.',
    state: errorWithData('openrouter', { error: 'http-400', detail: 'HTTP 400: unknown field <model> in "limit" & more' }),
    expand: true,
    group: 'Error and loading',
  }),
  cardScenario({
    id: 'glm-error-with-data-collapsed',
    provider: 'zhipu',
    title: 'GLM: error with data (collapsed)',
    note: 'Error status with data: the summary stays and the dot turns red.',
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
    title: 'DeepSeek: Remote call failed',
    note: 'The Remote call itself failed (wire error), not the provider read.',
    state: fixtures.wireFailure(),
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
  chipScenario({ id: 'chip-error', provider: 'zhipu', title: 'Chip after a failed first read', note: 'No data and an error: the chip says "unavailable" with a "!" mark.', state: errorWithoutData('zhipu') }),
  chipScenario({ id: 'chip-loading', provider: 'kimi', title: 'Chip while loading', note: 'No data yet: the chip shows the word "usage".', state: fixtures.loading(ready('kimi'), { keepData: false }) }),
  chipScenario({ id: 'chip-popover-glm', provider: 'zhipu', title: 'GLM chip, popover open', note: 'Clicking the chip opens the full panel above it.', state: ready('zhipu'), open: true }),
  chipScenario({ id: 'chip-popover-openrouter', provider: 'openrouter', title: 'OpenRouter chip, popover open', note: 'The key and account sections in the popover.', state: ready('openrouter'), open: true }),
  chipScenario({ id: 'chip-popover-waiting', provider: 'deepseek', title: 'DeepSeek chip, host service unreachable', note: 'Idle with the "usage host service is not reachable" hint.', waiting: true, open: true }),
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
.g-stage-pop{display:flex;justify-content:flex-end;padding-top:340px;padding-left:360px}
.g-empty{font-style:italic;color:var(--dsw-alias-label-secondary)}
.dsw-primitive{font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:transparent;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);height:28px;padding:0 10px;cursor:default}
.dsw-primitive:disabled{opacity:.5}
.g-stage a{color:#2f7cf6}
`

function sectionHtml(entry) {
  const stage = entry.html === '' ? '<span class="g-empty">(renders nothing)</span>' : entry.html
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
<p class="g-banner">The token values below are approximate. They were written by hand, not exported from the host theme, so this page shows structure and layout, not exact colour. Host primitives (the sign-in buttons) are drawn as plain buttons.</p>
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
