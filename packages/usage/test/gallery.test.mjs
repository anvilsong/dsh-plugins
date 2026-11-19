import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  attachRefs, bootClient, cardProps, change, click, createFakeModelDirectory, createLocaleStub, createProviderLoginStub,
  createUsageNamespaceStub, findAll, findByClass, findByText, findByType, textContent,
} from './helpers/client-harness.mjs'
import * as fixtures from './helpers/fixtures.mjs'
import {
  buildGalleryHtml, DARK_TOKENS, GALLERY_FILE_NAME, LIGHT_TOKENS, renderAll, SCENARIOS, TEMP_PREFIX, writeGallery,
} from './helpers/gallery.mjs'
import { toHtml } from './helpers/html.mjs'

const execFileAsync = promisify(execFile)
const galleryScript = fileURLToPath(new URL('./helpers/gallery.mjs', import.meta.url))
const el = (h, type, props, ...children) => h.React.createElement(type, props, ...children)

const sandboxes = []
async function makeSandbox() {
  const folder = await mkdtemp(join(tmpdir(), 'usage-gallery-test-'))
  sandboxes.push(folder)
  return folder
}
after(async () => {
  for (const folder of sandboxes) await rm(folder, { recursive: true, force: true })
})

let renderedOnce
const renderEverything = () => (renderedOnce ??= renderAll())

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

test('harness boots src/client.js and exposes cards by settings namespace, chips by id, stores by provider id and the stylesheet', async () => {
  const h = await bootClient()
  try {
    assert.deepEqual([...h.cards.keys()].sort(), ['llm-deepseek', 'llm-pi-ai'])
    assert.deepEqual([...h.chips.keys()].sort(), [
      'anthropic-usage-chip', 'codex-usage-chip', 'deepseek-usage-chip', 'kimi-usage-chip',
      'minimax-usage-chip', 'newapi-usage-chip', 'openrouter-usage-chip', 'zhipu-usage-chip',
    ])
    assert.deepEqual([...h.stores.keys()].sort(), ['anthropic', 'codex', 'deepseek', 'kimi', 'minimax', 'newapi', 'openrouter', 'zhipu'])
    for (const [id, store] of h.stores) {
      assert.equal(typeof store.set, 'function', id)
      assert.equal(h.providers.get(id).store, store)
    }
    assert.ok(h.stylesheet.startsWith('.orup-root{'))
    assert.ok(h.stylesheet.includes('.kmup-pop .kmup-root{margin-top:0}'))
    assert.ok(h.stylesheet.includes('.pup-pop .pup-root{margin-top:0}'))
    assert.equal(h.document.getElementById('usage-plugin-styles').tagName, 'STYLE')
    assert.deepEqual(h.exports.inject, ['slots', 'remote'])
    assert.equal(h.mounted.length, 1)
    assert.equal(h.mounted[0].package, 'dsh-plugin-provider-usage')
    assert.ok(h.mounted[0].descriptors.some((descriptor) => descriptor.id === 'dsh-plugin-provider-usage#openrouterUsage/snapshot'))
  } finally {
    h.dispose()
  }
})

test('harness accepts stub Remote namespaces, a locale service, a session id and a fake model directory', async () => {
  const state = fixtures.openrouter()
  const namespace = createUsageNamespaceStub(state)
  const directory = createFakeModelDirectory({ provider: 'openrouter' })
  const locale = createLocaleStub({ locale: 'en', messages: { hello: 'Hello' } })
  const h = await bootClient({ namespaces: { openrouterUsage: namespace }, modelDirectory: directory, locale, sessionId: 's-42' })
  try {
    assert.equal(h.ctx.get('locale'), locale)
    assert.equal(h.ctx.get('locale').t('hello'), 'Hello')
    assert.equal(h.ctx.get('remote.openrouterUsage'), namespace)
    assert.equal(h.ctx.get('remote.kimiUsage'), undefined)

    const chip = await h.mountChip('openrouter-usage-chip')
    assert.deepEqual(directory.requested.filter((id) => id !== undefined).slice(0, 1), ['s-42'])
    assert.ok(namespace.calls.snapshot >= 1, 'the poll loop reads the stub namespace')
    assert.equal(h.stores.get('openrouter').state, state)
    assert.ok(textContent(chip.tree).includes('$12.35'))

    // The chip follows the session's active provider.
    directory.setProvider('kimi-coding')
    await chip.settle()
    assert.equal(textContent(chip.tree), '')
    directory.setProvider('openrouter')
    await chip.settle()
    assert.ok(textContent(chip.tree).includes('OpenRouter'))

    // Refresh reaches the stub namespace.
    await click(chip, findByType(chip.tree, 'button'))
    await click(chip, findByText(chip.tree, 'Refresh'))
    assert.equal(namespace.calls.refresh, 1)
  } finally {
    h.dispose()
  }
})

test('harness without a model directory keeps the chip hidden; a custom effect list skips the poll loops', async () => {
  const namespace = createUsageNamespaceStub(fixtures.kimi())
  const h = await bootClient({ namespaces: { kimiUsage: namespace }, effects: ['usage: stylesheet'] })
  try {
    assert.deepEqual(h.ranEffects, ['usage: stylesheet'])
    assert.ok(h.skippedEffects.includes('usage: mount remotes'))
    assert.ok(h.skippedEffects.includes('usage: poll kimiUsage'))
    assert.equal(namespace.calls.snapshot, 0)
    assert.equal(h.stores.get('kimi').state, null)
    const chip = await h.mountChip('kimi-usage-chip')
    assert.equal(textContent(chip.tree), '')
  } finally {
    h.dispose()
  }
})

test('hook state is keyed by render path: two instances of one component type keep separate state', async () => {
  const h = await bootClient({ effects: 'none' })
  try {
    function Counter({ label }) {
      const [count, setCount] = h.React.useState(0)
      return el(h, 'button', { onClick: () => setCount((value) => value + 1) }, `${label}:${count}`)
    }
    function Pair() {
      return el(h, 'div', null, el(h, Counter, { label: 'a' }), el(h, Counter, { label: 'b' }))
    }
    const mount = await h.mount(Pair)
    const labels = () => findAll(mount.tree, (node) => node.type === 'button').map((node) => textContent(node))
    assert.deepEqual(labels(), ['a:0', 'b:0'])
    await click(mount, findAll(mount.tree, (node) => node.type === 'button')[0])
    assert.deepEqual(labels(), ['a:1', 'b:0'])
    await click(mount, findAll(mount.tree, (node) => node.type === 'button')[1])
    await click(mount, findAll(mount.tree, (node) => node.type === 'button')[1])
    assert.deepEqual(labels(), ['a:1', 'b:2'])
    assert.equal(mount.instancePaths.filter((path) => path.includes('Counter#')).length, 2)

    // Keyed instances keep their state when the order changes.
    function List({ order }) {
      return el(h, 'div', null, order.map((label) => el(h, Counter, { label, key: label })))
    }
    const list = await h.mount(List, { order: ['x', 'y'] })
    await click(list, findAll(list.tree, (node) => node.type === 'button')[0])
    list.render({ order: ['y', 'x'] })
    assert.deepEqual(findAll(list.tree, (node) => node.type === 'button').map((node) => textContent(node)), ['y:0', 'x:1'])
  } finally {
    h.dispose()
  }
})

test('hook state stays separate for two real chips that share one chip component', async () => {
  const gated = (state) => ({ ...state, ui: { composerChip: true, gate: ['anthropic'] } })
  const h = await bootClient({
    namespaces: { codexUsage: createUsageNamespaceStub(gated(fixtures.codex())), anthropicUsage: createUsageNamespaceStub(gated(fixtures.anthropic())) },
    activeProvider: 'anthropic',
  })
  try {
    const Codex = h.chips.get('codex-usage-chip')
    const Claude = h.chips.get('anthropic-usage-chip')
    function Both(props) {
      return el(h, 'div', null, el(h, Codex, props), el(h, Claude, props))
    }
    const mount = await h.mount(Both, { sessionId: 's-1' })
    const chipButtons = () => findAll(mount.tree, (node) => node.type === 'button')
    assert.equal(chipButtons().length, 2)
    assert.equal(findAll(mount.tree, (node) => node.props?.className === 'kmup-pop').length, 0)
    await click(mount, chipButtons()[0])
    const pops = findAll(mount.tree, (node) => node.props?.className === 'kmup-pop')
    assert.equal(pops.length, 1)
    assert.ok(textContent(pops[0]).includes('OpenAI Codex'))
    assert.ok(!textContent(pops[0]).includes('Claude'))
  } finally {
    h.dispose()
  }
})

test('effects, layout effects, ids, memo and callbacks follow React ordering and cleanup rules', async () => {
  const h = await bootClient({ effects: 'none' })
  try {
    const log = []
    let memoRuns = 0
    function Child({ id, dep }) {
      h.React.useEffect(() => { log.push(`mount ${id}`); return () => log.push(`cleanup ${id}`) }, [id])
      h.React.useLayoutEffect(() => { log.push(`layout ${id}`) }, [id])
      const memoized = h.React.useMemo(() => { memoRuns += 1; return dep * 2 }, [dep])
      const callback = h.React.useCallback(() => memoized, [memoized])
      const uid = h.React.useId()
      return el(h, 'i', { id: uid, 'data-value': callback() })
    }
    function Parent({ ids, dep = 1 }) {
      return el(h, 'div', null, ids.map((id) => el(h, Child, { id, dep, key: id })))
    }
    const mount = await h.mount(Parent, { ids: ['a', 'b'] })
    assert.deepEqual(log, ['layout a', 'layout b', 'mount a', 'mount b'])
    const idsOf = () => findAll(mount.tree, (node) => node.type === 'i').map((node) => node.props.id)
    const firstIds = idsOf()
    assert.equal(new Set(firstIds).size, 2)

    mount.render({ ids: ['a', 'b'] })
    assert.equal(memoRuns, 2, 'unchanged deps do not recompute')
    assert.deepEqual(idsOf(), firstIds, 'useId is stable across renders')
    mount.render({ ids: ['a', 'b'], dep: 5 })
    assert.equal(memoRuns, 4)

    log.length = 0
    mount.render({ ids: ['b'], dep: 5 })
    assert.deepEqual(log, ['cleanup a'], 'an unmounted instance runs its cleanup')
    mount.unmount()
    assert.deepEqual(log, ['cleanup a', 'cleanup b'])
  } finally {
    h.dispose()
  }
})

test('ref props get fake elements and stub document events (mousedown, keydown) reach effect listeners', async () => {
  const h = await bootClient({ effects: 'none' })
  try {
    const refs = {}
    function Menu() {
      const menuRef = h.React.useRef(null)
      const itemRef = h.React.useRef(null)
      const toggleRef = h.React.useRef(null)
      refs.menu = menuRef
      refs.item = itemRef
      refs.toggle = toggleRef
      const [open, setOpen] = h.React.useState(true)
      h.React.useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => { if (menuRef.current && !menuRef.current.contains(event.target)) setOpen(false) }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        h.document.addEventListener('mousedown', onDown)
        h.document.addEventListener('keydown', onKey)
        return () => {
          h.document.removeEventListener('mousedown', onDown)
          h.document.removeEventListener('keydown', onKey)
        }
      }, [open])
      return el(h, 'div', null,
        el(h, 'button', { ref: toggleRef, onClick: () => setOpen((value) => !value) }, 'toggle'),
        open ? el(h, 'ul', { ref: menuRef, role: 'menu' }, el(h, 'li', { ref: itemRef }, 'item')) : null,
      )
    }
    const mount = await h.mount(Menu)
    assert.equal(refs.menu.current.tagName, 'UL')
    assert.ok(refs.menu.current.contains(refs.item.current))
    assert.ok(!refs.menu.current.contains(refs.toggle.current))
    assert.equal(h.document.listenerCount('mousedown'), 1)

    h.document.dispatch('mousedown', { target: refs.item.current })
    await mount.settle()
    assert.ok(findByType(mount.tree, 'ul'), 'a mousedown inside keeps the menu open')

    h.document.dispatch('keydown', { key: 'a' })
    await mount.settle()
    assert.ok(findByType(mount.tree, 'ul'), 'another key keeps it open')

    h.document.dispatch('mousedown', { target: refs.toggle.current })
    await mount.settle()
    assert.equal(findByType(mount.tree, 'ul'), null, 'a mousedown outside closes it')
    assert.equal(h.document.listenerCount('mousedown'), 0, 'the cleanup removed the listeners')

    await click(mount, findByType(mount.tree, 'button'))
    assert.ok(findByType(mount.tree, 'ul'))
    const event = h.document.dispatch('keydown', { key: 'Escape' })
    assert.equal(event.defaultPrevented, false)
    await mount.settle()
    assert.equal(findByType(mount.tree, 'ul'), null, 'Escape closes it')
    assert.equal(h.document.listenerCount('keydown'), 0)

    // The standalone helper attaches elements to a bare tree, callback refs included.
    const seen = []
    const bare = el(h, 'div', { ref: (element) => seen.push(element.tagName) }, el(h, 'span', { ref: { current: null } }))
    assert.equal(attachRefs(bare).length, 2)
    assert.deepEqual(seen, ['DIV'])
    const manual = await h.mount(() => el(h, 'p', { ref: refs.menu }, 'x'), {}, { autoRefs: false })
    refs.menu.current = null
    assert.equal(manual.attachRefs().length, 1)
    assert.equal(refs.menu.current.tagName, 'P')
  } finally {
    h.dispose()
  }
})

test('the provider login stub drives the sign-in flow through the real card occupant', async () => {
  const prompt = { type: 'prompt', id: 'prompt-7', prompt: { kind: 'select', message: 'Choose', options: [{ id: 'personal', label: 'Personal' }, { id: 'team', label: 'Team' }] } }
  const login = createProviderLoginStub({ configured: false, events: [prompt, { type: 'settled', status: 'authorized' }] })
  const h = await bootClient({ namespaces: { providerLogin: login } })
  try {
    const mount = await h.mountCard('llm-pi-ai', cardProps('openai-codex', { oauth: true, keyConfigured: false }))
    assert.ok(login.statusCalls.length >= 1)
    const pending = click(mount, findByText(mount.tree, 'Sign in with ChatGPT'))
    await mount.settle()
    const select = findByType(mount.tree, 'select')
    assert.ok(select)
    await change(mount, select, 'team')
    await click(mount, findByText(mount.tree, 'Submit'))
    await pending
    await mount.settle()
    assert.deepEqual(login.beginCalls, [{ provider: 'openai-codex', method: 'oauth' }])
    assert.deepEqual(login.answers, [{ type: 'answer', id: 'prompt-7', answer: 'team' }])
    assert.ok(findByText(mount.tree, 'Signed in with ChatGPT'))
  } finally {
    h.dispose()
  }
})

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

test('toHtml escapes text and attribute values', () => {
  const html = toHtml({
    type: 'div',
    props: { title: '"><img src=x onerror=alert(1)> & \'q\'' },
    children: ['<script>alert(1)</script> & "quoted" \'single\'', 3, 0],
  })
  assert.ok(!html.includes('<script'))
  assert.ok(!html.includes('<img'))
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot; &#39;single&#39;'))
  assert.ok(html.includes('title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt; &amp; &#39;q&#39;"'))
  assert.ok(html.endsWith('3' + '0' + '</div>'))
})

test('toHtml maps attributes: class, inline style, role and aria kept; functions, refs and keys dropped', () => {
  const html = toHtml({
    type: 'div',
    props: {
      className: 'a b',
      style: { marginTop: 12, flex: 1, lineHeight: '18px', opacity: 0, '--dsw-x': 4, display: undefined },
      role: 'status',
      'aria-live': 'polite',
      'data-id': 'x1',
      onClick: () => {},
      ref: { current: null },
      key: 'k',
      children: 'ignored',
      bogus: 'dropped',
      disabled: false,
      hidden: true,
    },
    children: [[{ type: 'span', props: {}, children: ['one'] }, null, false], 'two'],
  })
  assert.equal(html, '<div class="a b" style="margin-top:12px;flex:1;line-height:18px;opacity:0;--dsw-x:4" role="status" aria-live="polite" data-id="x1" hidden><span>one</span>two</div>')
})

test('toHtml refuses active content and unknown shapes', () => {
  assert.throws(() => toHtml({ type: 'script', props: {}, children: ['x'] }), /script/)
  assert.throws(() => toHtml({ type: 'style', props: {}, children: ['x'] }), /style/)
  assert.throws(() => toHtml({ type: 'iframe', props: {}, children: [] }), /iframe/)
  assert.throws(() => toHtml({ type: 'div', props: { dangerouslySetInnerHTML: { __html: '<b>' } }, children: [] }), /dangerouslySetInnerHTML/)
  assert.throws(() => toHtml({ type: 'Mystery', props: {}, children: [] }), /Mystery/)
  assert.throws(() => toHtml({ type: 'div', props: {}, children: [{ plain: 'object' }] }), /neither text nor an element/)
  assert.throws(() => toHtml({ type: () => null, props: {}, children: [] }), /unrendered component/)
  assert.throws(() => toHtml({ type: 'a b', props: {}, children: [] }), /bad tag/)
  assert.ok(!toHtml({ type: 'a', props: { href: 'javascript:alert(1)' }, children: ['x'] }).includes('href'))
  assert.ok(toHtml({ type: 'a', props: { href: 'https://example.com/a?b=1&c=2' }, children: ['x'] }).includes('href="https://example.com/a?b=1&amp;c=2"'))
})

test('toHtml renders inputs, selects, fragments and the Button primitive', () => {
  const html = toHtml({
    type: 'fragment',
    props: {},
    children: [
      { type: 'input', props: { type: 'password', value: 'v', placeholder: 'p', onChange() {} }, children: [] },
      {
        type: 'select',
        props: { value: 'b', onChange() {} },
        children: [[{ type: 'option', props: { value: 'a' }, children: ['A'] }, { type: 'option', props: { value: 'b' }, children: ['B'] }]],
      },
      { type: 'Button', props: { type: 'button', variant: 'outline', size: 'sm', onClick() {}, disabled: true }, children: ['Go'] },
    ],
  })
  assert.equal(html, '<input type="password" value="v" placeholder="p"><select><option value="a">A</option><option value="b" selected>B</option></select>'
    + '<button class="dsw-primitive" data-primitive="Button" data-variant="outline" data-size="sm" type="button" disabled>Go</button>')
})

// ---------------------------------------------------------------------------
// Scenarios and gallery
// ---------------------------------------------------------------------------

test('the gallery names at least 12 distinct scenarios covering cards, errors, chips and sign-in', () => {
  const ids = SCENARIOS.map((scenario) => scenario.id)
  assert.ok(ids.length >= 12)
  assert.equal(new Set(ids).size, ids.length)
  for (const provider of ['openrouter', 'kimi', 'zhipu', 'deepseek', 'codex', 'anthropic']) {
    assert.ok(ids.includes(`${provider}-card-collapsed`), `${provider} collapsed`)
    assert.ok(ids.includes(`${provider}-card-expanded`), `${provider} expanded`)
  }
  assert.ok(ids.some((id) => id.includes('error-with-data')))
  assert.ok(ids.some((id) => id.includes('error-without-data')))
  for (const chip of ['chip-openrouter', 'chip-kimi', 'chip-glm', 'chip-deepseek']) assert.ok(ids.includes(chip), chip)
  for (const flow of ['signin-signed-out', 'signin-prompt-select', 'signin-prompt-text', 'signin-prompt-secret', 'signin-signed-in']) assert.ok(ids.includes(flow), flow)
  for (const scenario of SCENARIOS) {
    assert.equal(typeof scenario.title, 'string')
    assert.equal(typeof scenario.run, 'function')
  }
})

test('every scenario renders without a throw, none is skipped, and none renders nothing by accident', async () => {
  const { rendered } = await renderEverything()
  assert.deepEqual(rendered.map((entry) => entry.id), SCENARIOS.map((scenario) => scenario.id))
  const empty = rendered.filter((entry) => entry.html === '').map((entry) => entry.id)
  assert.deepEqual(empty, SCENARIOS.filter((scenario) => scenario.expectEmpty).map((scenario) => scenario.id))
  assert.deepEqual(empty, ['glm-loading-no-data'])
  for (const entry of rendered) {
    for (const bad of ['undefined', 'NaN', '[object Object]']) assert.ok(!entry.html.includes(bad), `${entry.id} contains ${bad}`)
  }
})

test('scenarios render the provider states they claim to show', async () => {
  const { rendered } = await renderEverything()
  const html = Object.fromEntries(rendered.map((entry) => [entry.id, entry.html]))
  const expectations = {
    'openrouter-card-collapsed': ['used $12.35', 'balance $37.50 left', '▾ details'],
    'openrouter-card-expanded': ['Used (key)', 'Balance (account)', '▴ less'],
    'kimi-card-expanded': ['5-hour window', 'Extra Usage balance', 'Requests'],
    'zhipu-card-expanded': ['Tool calls', 'pro plan', 'search-prime: 182'],
    'deepseek-card-expanded': ['Balance (CNY)', 'topped up'],
    'codex-card-expanded': ['Rate-limit reset credits', 'Signed in with ChatGPT'],
    'anthropic-card-expanded': ['Usage credits spent', 'Opus: 55%', 'Signed in with Claude'],
    'openrouter-error-with-data': ['&lt;model&gt;', '&quot;limit&quot;', 'Used (key)', 'orup-err'],
    'glm-error-without-data': ['Usage unavailable', 'HTTP 401', 'pup-err'],
    'kimi-error-without-data-expanded': ['timed out', 'kmup-code'],
    'deepseek-wire-error': ['The usage Remote call failed'],
    'codex-loading-with-data': ['Refreshing…', 'disabled'],
    'chip-error': ['unavailable', '>!<'],
    'chip-loading': ['>usage<'],
    'chip-popover-waiting': ['not reachable yet'],
    'chip-popover-glm': ['pup-pop', 'Tool calls'],
    'signin-checking': ['Checking sign-in…'],
    'signin-signed-out': ['Sign in with ChatGPT', 'data-variant="outline"'],
    'signin-status-error': ['The provider login service is unreachable.'],
    'signin-notice': ['Code: ABCD-1234', 'href="https://auth.example.com/device"', 'Waiting for sign-in…'],
    'signin-prompt-select': ['<select', '<option value="personal" selected>', 'Submit'],
    'signin-prompt-select-chosen': ['<option value="edu" selected>'],
    'signin-prompt-text': ['type="text"', 'placeholder="organisation name"'],
    'signin-prompt-secret': ['type="password"'],
    'signin-cancelled': ['Sign-in cancelled.'],
    'signin-signed-in': ['Signed in with ChatGPT', 'Re-authenticate'],
  }
  for (const [id, needles] of Object.entries(expectations)) {
    assert.ok(html[id] !== undefined, `${id} was rendered`)
    for (const needle of needles) assert.ok(html[id].includes(needle), `${id} should include ${needle}`)
  }
  assert.ok(!html['signin-prompt-select'].includes('<option value="edu" selected>'))
  assert.ok(!html['openrouter-error-with-data'].includes('<model>'))
})

test('the gallery page is one self-contained file with the plugin CSS and approximate light and dark token sheets', async () => {
  const { rendered, css } = await renderEverything()
  const page = buildGalleryHtml(rendered, css)

  // The CSS is the plugin's own string, byte for byte as the harness captures it.
  const h = await bootClient({ effects: ['usage: stylesheet'] })
  const clientCss = h.stylesheet
  h.dispose()
  assert.ok(clientCss.length > 1000)
  assert.equal(css, clientCss)
  assert.ok(page.includes(clientCss))

  assert.ok(page.startsWith('<!doctype html>'))
  for (const bad of ['undefined', 'NaN', '[object Object]']) assert.ok(!page.includes(bad), `the page contains ${bad}`)
  for (const forbidden of ['<script', '<link', '@import', 'url(', '<iframe', '<img', ' src=']) assert.ok(!page.includes(forbidden), `the page contains ${forbidden}`)
  assert.equal(page.split('<style>').length - 1, 1)
  assert.ok(!page.includes('<model>'))
  assert.ok(page.includes('&lt;model&gt;'))

  // Every scenario appears once per theme.
  assert.equal(page.split('<figure class="g-theme theme-light">').length - 1, rendered.length)
  assert.equal(page.split('<figure class="g-theme theme-dark">').length - 1, rendered.length)
  for (const entry of rendered) assert.ok(page.includes(`id="s-${entry.id}"`), entry.id)

  // Both token sheets exist, say "approximate", and define every token the page uses.
  const light = /(?:^|\n)\.theme-light\{([^}]*)\}/.exec(page)
  const dark = /(?:^|\n)\.theme-dark\{([^}]*)\}/.exec(page)
  assert.ok(light, 'light token sheet')
  assert.ok(dark, 'dark token sheet')
  assert.ok(/light tokens: approximate/.test(page))
  assert.ok(/dark tokens: approximate/.test(page))
  assert.ok(page.includes('approximate'))
  const used = new Set([...page.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((match) => match[1]))
  assert.ok(used.size >= 12, `found ${used.size} tokens`)
  for (const token of used) {
    assert.ok(light[1].includes(`${token}:`), `light sheet lacks ${token}`)
    assert.ok(dark[1].includes(`${token}:`), `dark sheet lacks ${token}`)
    assert.ok(token in LIGHT_TOKENS && token in DARK_TOKENS, `${token} is missing from an exported token map`)
  }
  assert.notEqual(light[1], dark[1])
})

test('writeGallery writes one file into the folder it was given and nothing else', async () => {
  const sandbox = await makeSandbox()
  const file = await writeGallery({ out: join(sandbox, 'out') })
  assert.equal(file, join(sandbox, 'out', GALLERY_FILE_NAME))
  assert.deepEqual(await readdir(join(sandbox, 'out')), [GALLERY_FILE_NAME])
  assert.deepEqual(await readdir(sandbox), ['out'])
  const text = await readFile(file, 'utf8')
  assert.ok(text.startsWith('<!doctype html>'))
  assert.ok(text.length > 20_000)
})

test('the gallery script prints only its file path and writes only inside a mkdtemp folder under TMPDIR', async () => {
  const sandbox = await makeSandbox()
  const { stdout, stderr } = await execFileAsync(process.execPath, [galleryScript], { env: { ...process.env, TMPDIR: sandbox } })
  assert.equal(stderr, '')
  assert.ok(stdout.endsWith('\n'))
  const lines = stdout.split('\n').filter(Boolean)
  assert.equal(lines.length, 1, 'one line of output')
  const file = lines[0]
  assert.equal(basename(file), GALLERY_FILE_NAME)
  assert.ok(basename(dirname(file)).startsWith(TEMP_PREFIX))
  assert.equal(await realpath(dirname(dirname(file))), await realpath(sandbox))
  const entries = await readdir(sandbox)
  assert.equal(entries.length, 1, 'the script made exactly one folder')
  assert.deepEqual(await readdir(join(sandbox, entries[0])), [GALLERY_FILE_NAME])
  const page = await readFile(file, 'utf8')
  assert.ok(page.includes('approximate'))
  await rm(sandbox, { recursive: true, force: true })
  assert.equal(existsSync(file), false, 'the test removed the folder')
})

test('the gallery script honours --out and rejects unknown arguments without printing a path', async () => {
  const sandbox = await makeSandbox()
  const target = join(sandbox, 'chosen')
  const { stdout } = await execFileAsync(process.execPath, [galleryScript, '--out', target], { env: { ...process.env, TMPDIR: sandbox } })
  assert.equal(stdout, `${join(target, GALLERY_FILE_NAME)}\n`)
  assert.deepEqual(await readdir(sandbox), ['chosen'])

  await assert.rejects(
    execFileAsync(process.execPath, [galleryScript, '--bogus'], { env: { ...process.env, TMPDIR: sandbox } }),
    (error) => error.code === 1 && error.stdout === '' && /unknown argument/.test(error.stderr),
  )
  assert.deepEqual(await readdir(sandbox), ['chosen'])
})
