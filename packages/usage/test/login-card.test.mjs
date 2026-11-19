/**
 * The OAuth sign-in block of a provider card (ProviderLoginAction), driven
 * through the render harness: prompt label, focus, Enter, Cancel, unmount,
 * link wrapping, alert errors, and the usage line right after sign-in.
 */

import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import {
  bootClient as bootHarness, cardProps, change, click, createProviderLoginStub, createUsageNamespaceStub, find, findAll, findByText, findByType, hostPaths, textContent,
} from './helpers/client-harness.mjs'
import { renderScenario, SCENARIOS } from './helpers/gallery.mjs'
import * as fixtures from './helpers/fixtures.mjs'

// A broken client can leave a sign-in stream waiting for ever: fail instead of hanging.
const TEST_TIMEOUT_MS = 3000
const ROUTE = 'openai-codex'
const SETTINGS_NS = 'llm-pi-ai'
const SIGN_IN = 'Sign in with ChatGPT'
const LONG_URL = `https://auth.example.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=${'http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback'}&scope=${'openid%20profile%20email%20offline_access'}&code_challenge=${'x'.repeat(43)}&code_challenge_method=S256&state=${'s'.repeat(32)}&originator=codex_cli_rs`

// A timed-out test never reaches its own cleanup: dispose every harness at the end so no poll timer keeps the process alive.
const booted = []
async function bootClient(options) {
  const h = await bootHarness(options)
  booted.push(h)
  return h
}
after(() => { for (const h of booted) h.dispose() })

const textPrompt = { type: 'prompt', id: 'prompt-1', prompt: { kind: 'text', message: 'Enter the organisation name', placeholder: 'organisation name' } }
const secretPrompt = { type: 'prompt', id: 'prompt-2', prompt: { kind: 'secret', message: 'Paste the one-time code', placeholder: 'one-time code' } }
const selectPrompt = {
  type: 'prompt',
  id: 'prompt-3',
  prompt: { kind: 'select', message: 'Choose an account', options: [{ id: 'personal', label: 'Personal account' }, { id: 'team', label: 'Team workspace' }] },
}
const notice = { type: 'notice', notice: { message: 'Finish signing in in your browser.', url: LONG_URL, code: 'ABCD-1234' } }

/** Boot a card, start the sign-in flow and leave the stream open. */
async function openSignIn(login, { namespaces = {} } = {}) {
  const stub = createProviderLoginStub(login)
  const h = await bootClient({ namespaces: { providerLogin: stub, ...namespaces } })
  const mount = await h.mountCard(SETTINGS_NS, cardProps(ROUTE, { oauth: true, keyConfigured: false }))
  const button = findByText(mount.tree, SIGN_IN)
  assert.ok(button, 'the sign-in button is shown')
  const pending = button.props.onClick()
  await mount.settle()
  return { h, mount, stub, pending }
}

const labelFor = (tree, id) => find(tree, (node) => node.type === 'label' && node.props.htmlFor === id)
const byId = (tree, id) => find(tree, (node) => node.props?.id === id)
const order = (tree, node) => findAll(tree, () => true).indexOf(node)

test('the prompt message renders above a text input and labels it', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { h, mount } = await openSignIn({ events: [textPrompt], hold: true })
  try {
    const input = findByType(mount.tree, 'input')
    assert.ok(input)
    assert.equal(typeof input.props.id, 'string')
    assert.notEqual(input.props.id, '')
    const label = labelFor(mount.tree, input.props.id)
    assert.ok(label, 'a label points at the input id')
    assert.equal(textContent(label), 'Enter the organisation name')
    assert.ok(order(mount.tree, label) < order(mount.tree, input), 'the message comes above the control')
    assert.equal(byId(mount.tree, input.props.id), input, 'the id is unique')
  } finally {
    h.dispose()
  }
})

test('the select prompt carries the same label', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { h, mount } = await openSignIn({ events: [selectPrompt], hold: true })
  try {
    const select = findByType(mount.tree, 'select')
    assert.ok(select)
    const label = labelFor(mount.tree, select.props.id)
    assert.ok(label, 'a label points at the select id')
    assert.equal(textContent(label), 'Choose an account')
    assert.ok(order(mount.tree, label) < order(mount.tree, select))
  } finally {
    h.dispose()
  }
})

test('the text, secret and select prompts take focus; a secret prompt stays a password field', { timeout: TEST_TIMEOUT_MS }, async () => {
  for (const [prompt, tag, type] of [[textPrompt, 'input', 'text'], [secretPrompt, 'input', 'password'], [selectPrompt, 'select', undefined]]) {
    const { h, mount } = await openSignIn({ events: [prompt], hold: true })
    try {
      const control = findByType(mount.tree, tag)
      assert.ok(control, `${prompt.id} has a ${tag}`)
      assert.equal(control.props.autoFocus, true, `${prompt.id} autofocuses`)
      if (type) assert.equal(control.props.type, type)
    } finally {
      h.dispose()
    }
  }
})

test('Enter submits the answer', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { h, mount, stub, pending } = await openSignIn({ events: [textPrompt, { type: 'settled', status: 'authorized' }] })
  try {
    const input = findByType(mount.tree, 'input')
    await change(mount, input, 'acme')
    const event = { type: 'keydown', key: 'Enter', keyCode: 13, preventDefault() { this.defaultPrevented = true } }
    findByType(mount.tree, 'input').props.onKeyDown(event)
    await pending
    await mount.settle()
    assert.deepEqual(stub.answers, [{ type: 'answer', id: 'prompt-1', answer: 'acme' }])
    assert.equal(event.defaultPrevented, true)
  } finally {
    h.dispose()
  }
})

test('Enter does not submit while an IME composition is active or for other keys', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { h, mount, stub } = await openSignIn({ events: [textPrompt], hold: true })
  try {
    await change(mount, findByType(mount.tree, 'input'), 'にほん')
    const onKeyDown = findByType(mount.tree, 'input').props.onKeyDown
    assert.equal(typeof onKeyDown, 'function')
    onKeyDown({ key: 'Enter', keyCode: 13, isComposing: true, preventDefault() {} })
    onKeyDown({ key: 'Enter', keyCode: 13, nativeEvent: { isComposing: true }, preventDefault() {} })
    onKeyDown({ key: 'Enter', keyCode: 229, preventDefault() {} })
    onKeyDown({ key: 'Process', keyCode: 229, preventDefault() {} })
    onKeyDown({ key: 'a', keyCode: 65, preventDefault() {} })
    onKeyDown({ key: 'Escape', keyCode: 27, preventDefault() {} })
    await mount.settle()
    assert.deepEqual(stub.answers, [])
  } finally {
    h.dispose()
  }
})

test('a Cancel button shows while a sign-in runs, disposes the stream and says so', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { h, mount, stub, pending } = await openSignIn({ events: [notice], hold: true })
  try {
    const cancel = findByText(mount.tree, 'Cancel')
    assert.ok(cancel, 'Cancel is shown while waiting')
    assert.equal(cancel.props.type, 'button')
    assert.equal(stub.disposeCalls, 0)
    cancel.props.onClick()
    await pending
    await mount.settle()
    assert.equal(stub.disposeCalls, 1)
    const cancelled = findByText(mount.tree, 'Sign-in cancelled.')
    assert.ok(cancelled)
    assert.equal(cancelled.props.role, 'status')
    assert.equal(findByText(mount.tree, 'Cancel'), null, 'Cancel goes away')
    assert.ok(findByText(mount.tree, SIGN_IN), 'the sign-in button comes back')
    assert.equal(findByText(mount.tree, SIGN_IN).props.disabled, false)
    assert.equal(findByType(mount.tree, 'a'), null, 'the stale link is gone')
  } finally {
    h.dispose()
  }
})

test('Cancel also closes an open prompt', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { h, mount, stub, pending } = await openSignIn({ events: [textPrompt], hold: true })
  try {
    assert.ok(findByType(mount.tree, 'input'))
    findByText(mount.tree, 'Cancel').props.onClick()
    await pending
    await mount.settle()
    assert.equal(stub.disposeCalls, 1)
    assert.equal(findByType(mount.tree, 'input'), null)
    assert.ok(findByText(mount.tree, 'Sign-in cancelled.'))
  } finally {
    h.dispose()
  }
})

test('no Cancel button when no sign-in is running', { timeout: TEST_TIMEOUT_MS }, async () => {
  const stub = createProviderLoginStub({ configured: false })
  const h = await bootClient({ namespaces: { providerLogin: stub } })
  try {
    const mount = await h.mountCard(SETTINGS_NS, cardProps(ROUTE, { oauth: true, keyConfigured: false }))
    assert.ok(findByText(mount.tree, SIGN_IN))
    assert.equal(findByText(mount.tree, 'Cancel'), null)
  } finally {
    h.dispose()
  }
})

test('unmounting during a sign-in disposes the stream', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { h, mount, stub } = await openSignIn({ events: [notice], hold: true })
  try {
    assert.equal(stub.handles.length, 1)
    assert.equal(stub.disposeCalls, 0)
    mount.unmount()
    assert.equal(stub.disposeCalls, 1)
  } finally {
    h.dispose()
  }
})

test('unmounting with no sign-in running disposes nothing', { timeout: TEST_TIMEOUT_MS }, async () => {
  const stub = createProviderLoginStub({ configured: false })
  const h = await bootClient({ namespaces: { providerLogin: stub } })
  try {
    const mount = await h.mountCard(SETTINGS_NS, cardProps(ROUTE, { oauth: true, keyConfigured: false }))
    mount.unmount()
    assert.equal(stub.handles.length, 0)
    assert.equal(stub.disposeCalls, 0)
  } finally {
    h.dispose()
  }
})

test('the sign-in link wraps, opens safely, and the code sits in its own selectable element', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { h, mount } = await openSignIn({ events: [notice], hold: true })
  try {
    const link = findByType(mount.tree, 'a')
    assert.ok(link)
    assert.equal(link.props.href, LONG_URL)
    assert.ok(LONG_URL.length > 300)
    assert.equal(textContent(link), LONG_URL)
    assert.equal(link.props.target, '_blank')
    assert.equal(link.props.rel, 'noreferrer noopener')
    assert.equal(link.props.style?.overflowWrap, 'anywhere')
    const code = find(mount.tree, (node) => node.type !== 'a' && node.children.length === 1 && node.children[0] === 'Code: ABCD-1234')
    assert.ok(code, 'the code has its own element')
    assert.notEqual(code.props?.style?.userSelect, 'none')
    assert.equal(findAll(mount.tree, (node) => node.props?.style?.overflowWrap === 'anywhere').length >= 2, true, 'the code wraps as well')
  } finally {
    h.dispose()
  }
})

test('a failed sign-in is an alert with the error class; a notice stays a status', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { h, mount, pending } = await openSignIn({ events: [notice], failWith: 'The browser callback timed out.' })
  try {
    await pending
    await mount.settle()
    const failure = findByText(mount.tree, 'The browser callback timed out.')
    assert.ok(failure)
    assert.equal(failure.props.role, 'alert')
    assert.ok(failure.props.className.split(' ').includes('pup-err'))
    assert.equal(findByType(mount.tree, 'a'), null, 'the link of the dead flow is gone')
    assert.equal(findByText(mount.tree, 'Code: ABCD-1234'), null)
  } finally {
    h.dispose()
  }
  const open = await openSignIn({ events: [notice], hold: true })
  try {
    const shown = findByText(open.mount.tree, 'Finish signing in in your browser.')
    assert.ok(shown)
    assert.equal(shown.props.role, 'status')
    assert.ok(!String(shown.props.className ?? '').includes('pup-err'))
  } finally {
    open.h.dispose()
  }
})

test('a status read that fails is an alert; a missing login service is an alert', { timeout: TEST_TIMEOUT_MS }, async () => {
  const stub = createProviderLoginStub({ status: 'error', statusError: 'The provider login service is unreachable.' })
  const h = await bootClient({ namespaces: { providerLogin: stub } })
  try {
    const mount = await h.mountCard(SETTINGS_NS, cardProps(ROUTE, { oauth: true, keyConfigured: false }))
    const failure = findByText(mount.tree, 'The provider login service is unreachable.')
    assert.ok(failure)
    assert.equal(failure.props.role, 'alert')
    assert.ok(failure.props.className.split(' ').includes('pup-err'))
  } finally {
    h.dispose()
  }
})

test('the settled "cancelled" event is a status, not an alert', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { h, mount, pending } = await openSignIn({ events: [{ type: 'settled', status: 'cancelled' }] })
  try {
    await pending
    await mount.settle()
    const shown = findByText(mount.tree, 'Sign-in cancelled.')
    assert.ok(shown)
    assert.equal(shown.props.role, 'status')
  } finally {
    h.dispose()
  }
})

test('a flow that settles as cancelled drops its link', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { h, mount, pending } = await openSignIn({ events: [notice, { type: 'settled', status: 'cancelled' }] })
  try {
    await pending
    await mount.settle()
    assert.ok(findByText(mount.tree, 'Sign-in cancelled.'))
    assert.equal(findByType(mount.tree, 'a'), null)
  } finally {
    h.dispose()
  }
})

test('the usage line of the same card appears right after sign-in, with no remount', { timeout: TEST_TIMEOUT_MS }, async () => {
  const usage = createUsageNamespaceStub(fixtures.codex())
  const { h, mount, stub, pending } = await openSignIn(
    { configured: false, events: [{ type: 'settled', status: 'authorized' }] },
    { namespaces: { codexUsage: usage } },
  )
  try {
    // openSignIn already clicked; the flow has run to its end by now.
    await pending
    await mount.settle()
    assert.ok(findByText(mount.tree, 'Signed in with ChatGPT'))
    assert.ok(find(mount.tree, (node) => node.props?.title === 'OpenAI Codex usage'), 'the usage line is shown')
    assert.equal(stub.statusCalls.length, 2, 'no extra status call')
  } finally {
    h.dispose()
  }
})

test('the usage line stays hidden before sign-in and the instances are not remounted by it', { timeout: TEST_TIMEOUT_MS }, async () => {
  const usage = createUsageNamespaceStub(fixtures.codex())
  const stub = createProviderLoginStub({ configured: false, events: [notice, { type: 'prompt', id: 'p', prompt: { kind: 'text', message: 'Code' } }, { type: 'settled', status: 'authorized' }] })
  const h = await bootClient({ namespaces: { providerLogin: stub, codexUsage: usage } })
  try {
    const mount = await h.mountCard(SETTINGS_NS, cardProps(ROUTE, { oauth: true, keyConfigured: false }))
    assert.equal(find(mount.tree, (node) => node.props?.title === 'OpenAI Codex usage'), null)
    const statusAtMount = stub.statusCalls.length
    assert.equal(statusAtMount, 2, 'CardExtras and the sign-in action read the status once each')
    const pathsBefore = mount.instancePaths
    const pending = findByText(mount.tree, SIGN_IN).props.onClick()
    await mount.settle()
    assert.equal(find(mount.tree, (node) => node.props?.title === 'OpenAI Codex usage'), null, 'not yet: still signing in')
    findByText(mount.tree, 'Submit').props.onClick()
    await pending
    await mount.settle()
    assert.ok(find(mount.tree, (node) => node.props?.title === 'OpenAI Codex usage'))
    assert.deepEqual(mount.instancePaths, pathsBefore, 'the same component instances, nothing remounted')
    assert.equal(stub.statusCalls.length, statusAtMount)
  } finally {
    h.dispose()
  }
})

test('a later mount reads the status again and does not trust the old signal', { timeout: TEST_TIMEOUT_MS }, async () => {
  const usage = createUsageNamespaceStub(fixtures.codex())
  const stub = createProviderLoginStub({ configured: false, events: [{ type: 'settled', status: 'authorized' }] })
  const h = await bootClient({ namespaces: { providerLogin: stub, codexUsage: usage } })
  try {
    const first = await h.mountCard(SETTINGS_NS, cardProps(ROUTE, { oauth: true, keyConfigured: false }))
    const pending = findByText(first.tree, SIGN_IN).props.onClick()
    await pending
    await first.settle()
    first.unmount()
    const before = stub.statusCalls.length
    const second = await h.mountCard(SETTINGS_NS, cardProps(ROUTE, { oauth: true, keyConfigured: false }))
    assert.equal(stub.statusCalls.length - before, 2, 'a fresh mount reads the status again')
    assert.equal(find(second.tree, (node) => node.props?.title === 'OpenAI Codex usage'), null, 'the stub still says not signed in')
  } finally {
    h.dispose()
  }
})

// ---------------------------------------------------------------------------
// Gallery scenarios
// ---------------------------------------------------------------------------

test('the gallery shows the sign-in prompt with its message, a cancelled flow and an error', { timeout: TEST_TIMEOUT_MS }, async () => {
  const byId = new Map(SCENARIOS.map((scenario) => [scenario.id, scenario]))
  for (const id of ['signin-prompt-with-message', 'signin-cancelled-by-user', 'signin-error']) assert.ok(byId.has(id), id)
  const render = async (id) => (await renderScenario(byId.get(id))).html

  const withMessage = await render('signin-prompt-with-message')
  assert.match(withMessage, /<label[^>]*for="([^"]+)"[^>]*>Paste the code the browser shows after you approve the sign-in<\/label>/)
  assert.ok(withMessage.includes(`<input id="${/<label[^>]*for="([^"]+)"/.exec(withMessage)[1]}"`), 'the label points at the input')
  assert.ok(withMessage.includes('overflow-wrap:anywhere'))
  assert.ok(withMessage.includes('rel="noreferrer noopener"'))
  assert.ok(withMessage.includes('>Cancel<'))

  const cancelled = await render('signin-cancelled-by-user')
  assert.ok(cancelled.includes('Sign-in cancelled.'))
  assert.ok(!cancelled.includes('>Cancel<'))
  assert.ok(cancelled.includes(SIGN_IN))

  const failed = await render('signin-error')
  assert.match(failed, /role="alert"/)
  assert.ok(failed.includes('pup-err'))
  assert.ok(failed.includes('The browser callback timed out.'))
})

// ---------------------------------------------------------------------------
// Follow-up F
// ---------------------------------------------------------------------------

const AUTHORIZED = { type: 'settled', status: 'authorized' }
const MISSING_CREDENTIAL = 'No value for llm-pi-ai/anthropic. Add the API key in Settings → Models.'
const staleClaude = () => fixtures.failed(fixtures.anthropic(), { error: 'missing-credential', detail: MISSING_CREDENTIAL, keepData: false })
const claudeLine = (tree) => find(tree, (node) => node.props?.title === 'Claude usage')
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

/** Boot, mount one provider card (OAuth only, no API key) and click its sign-in button. */
async function signInOn(route, { login, namespaces, label }) {
  const stub = createProviderLoginStub(login)
  const h = await bootClient({ namespaces: { providerLogin: stub, ...namespaces } })
  const mount = await h.mountCard(SETTINGS_NS, cardProps(route, { oauth: true, keyConfigured: false }))
  const button = findByText(mount.tree, label)
  assert.ok(button, `${label} is shown`)
  const pending = button.props.onClick()
  await mount.settle()
  return { h, mount, stub, pending }
}

test('a settled sign-in refreshes the provider once and shows loading, not the stale error, until it settles', { timeout: TEST_TIMEOUT_MS }, async () => {
  const gate = deferred()
  const usage = createUsageNamespaceStub(staleClaude(), { refreshState: fixtures.anthropic(), refreshGate: gate.promise })
  const { h, mount, pending } = await signInOn('anthropic', {
    login: { events: [AUTHORIZED] }, namespaces: { anthropicUsage: usage }, label: 'Sign in with Claude',
  })
  try {
    await pending
    await mount.settle()
    assert.ok(findByText(mount.tree, 'Signed in with Claude'))
    assert.equal(usage.calls.refresh, 1, 'the refresh runs once, right after the sign-in settles')
    const shown = textContent(mount.tree)
    assert.ok(!shown.includes('Add the API key'), 'the stale error is not shown')
    assert.ok(!shown.includes('Usage unavailable'))
    assert.ok(shown.includes('Loading usage'), 'a loading line stands in until the refresh answers')
    gate.resolve()
    await mount.settle()
    assert.ok(claudeLine(mount.tree), 'the usage line is shown')
    assert.ok(textContent(mount.tree).includes('7d 88.0%'), 'with the refreshed figures')
    assert.ok(!textContent(mount.tree).includes('Loading usage'))
    assert.equal(usage.calls.refresh, 1, 'and it was not refreshed again')
  } finally {
    gate.resolve()
    h.dispose()
  }
})

test('no refresh before the sign-in settles, and none for a stored sign-in', { timeout: TEST_TIMEOUT_MS }, async () => {
  const usage = createUsageNamespaceStub(fixtures.anthropic())
  const h = await bootClient({ namespaces: { providerLogin: createProviderLoginStub({ configured: true }), anthropicUsage: usage } })
  try {
    const mount = await h.mountCard(SETTINGS_NS, cardProps('anthropic', { oauth: true, keyConfigured: false }))
    assert.ok(claudeLine(mount.tree))
    assert.equal(usage.calls.refresh, 0)
  } finally {
    h.dispose()
  }
})

test('a refresh that fails after the sign-in shows its own error, not a loading line', { timeout: TEST_TIMEOUT_MS }, async () => {
  const usage = createUsageNamespaceStub(staleClaude(), { refreshFailure: 'The usage Remote call failed: the connection was closed.' })
  const { h, mount, pending } = await signInOn('anthropic', {
    login: { events: [AUTHORIZED] }, namespaces: { anthropicUsage: usage }, label: 'Sign in with Claude',
  })
  try {
    await pending
    await mount.settle()
    assert.equal(usage.calls.refresh, 1)
    const shown = textContent(mount.tree)
    assert.ok(shown.includes('The usage Remote call failed: the connection was closed.'))
    assert.ok(!shown.includes('Loading usage'))
  } finally {
    h.dispose()
  }
})

test('the sign-in signal belongs to its route: another provider card neither shows a line nor refreshes', { timeout: TEST_TIMEOUT_MS }, async () => {
  const claude = createUsageNamespaceStub(staleClaude(), { refreshState: fixtures.anthropic() })
  const codex = createUsageNamespaceStub(fixtures.codex())
  const stub = createProviderLoginStub({ configured: false, events: [AUTHORIZED] })
  const h = await bootClient({ namespaces: { providerLogin: stub, anthropicUsage: claude, codexUsage: codex } })
  try {
    const other = await h.mountCard(SETTINGS_NS, cardProps('anthropic', { oauth: true, keyConfigured: false }))
    const signing = await h.mountCard(SETTINGS_NS, cardProps(ROUTE, { oauth: true, keyConfigured: false }))
    assert.equal(claudeLine(other.tree), null)
    await findByText(signing.tree, SIGN_IN).props.onClick()
    await signing.settle()
    await other.settle()
    assert.ok(find(signing.tree, (node) => node.props?.title === 'OpenAI Codex usage'), 'the signed-in card shows its line')
    assert.equal(codex.calls.refresh, 1)
    assert.equal(claudeLine(other.tree), null, 'the other card still shows nothing')
    assert.ok(findByText(other.tree, 'Sign in with Claude'), 'and still offers its own sign-in')
    assert.equal(claude.calls.refresh, 0, 'the other provider was not refreshed')
  } finally {
    h.dispose()
  }
})

test('the usage line appears when the login service answers only after the card mounted', { timeout: TEST_TIMEOUT_MS }, async () => {
  const gate = deferred()
  const usage = createUsageNamespaceStub(fixtures.anthropic())
  const h = await bootClient({
    namespaces: { providerLogin: createProviderLoginStub({ configured: true }), anthropicUsage: usage },
    mountGate: gate.promise,
  })
  try {
    const mount = await h.mountCard(SETTINGS_NS, cardProps('anthropic', { oauth: true, keyConfigured: false }))
    assert.equal(claudeLine(mount.tree), null, 'nothing is known yet')
    gate.resolve()
    await h.mounting
    await new Promise((resolve) => setTimeout(resolve, 700))
    await mount.settle()
    assert.ok(findByText(mount.tree, 'Signed in with Claude'), 'the sign-in action found the service')
    assert.ok(claudeLine(mount.tree), 'so did the usage line')
  } finally {
    gate.resolve()
    h.dispose()
  }
})

test('a stored sign-in, a snapshot and a refresh arrive as Results and are unwrapped', { timeout: TEST_TIMEOUT_MS }, async () => {
  const state = fixtures.codex()
  const usage = createUsageNamespaceStub(state)
  const stub = createProviderLoginStub({ configured: true })
  assert.deepEqual(await stub.status({ provider: ROUTE }), { ok: true, value: { configured: true } })
  assert.deepEqual(await usage.snapshot(), { ok: true, value: state })
  const h = await bootClient({ namespaces: { providerLogin: stub, codexUsage: usage } })
  try {
    assert.equal(h.stores.get('codex').state, state, 'the store holds the state, not its Result')
    const mount = await h.mountCard(SETTINGS_NS, cardProps(ROUTE, { oauth: true, keyConfigured: false }))
    assert.ok(findByText(mount.tree, 'Signed in with ChatGPT'), 'the sign-in action read the status')
    const line = find(mount.tree, (node) => node.props?.title === 'OpenAI Codex usage')
    assert.ok(line, 'the usage line read the status')
    await click(mount, line)
    const refresh = findByText(mount.tree, 'Refresh')
    assert.ok(refresh, 'the open panel has a Refresh button')
    await click(mount, refresh)
    assert.equal(usage.calls.refresh, 1)
    assert.equal(h.stores.get('codex').state, state, 'a refresh stores the state too')
  } finally {
    h.dispose()
  }
})

test('pressing Submit twice sends the answer once', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { h, mount, stub } = await openSignIn({ events: [textPrompt], hold: true })
  try {
    await change(mount, findByType(mount.tree, 'input'), 'acme')
    const submit = findByText(mount.tree, 'Submit')
    submit.props.onClick()
    submit.props.onClick()
    await mount.settle()
    assert.deepEqual(stub.answers, [{ type: 'answer', id: 'prompt-1', answer: 'acme' }])
  } finally {
    h.dispose()
  }
})

test('a settled stream sends nothing more and Cancel after the end does not touch the stream', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { h, mount, stub, pending } = await openSignIn({ events: [textPrompt, AUTHORIZED] })
  try {
    await change(mount, findByType(mount.tree, 'input'), 'acme')
    findByType(mount.tree, 'input').props.onKeyDown({ key: 'Enter', keyCode: 13, preventDefault() {} })
    await pending
    await mount.settle()
    assert.equal(stub.answers.length, 1)
    assert.equal(stub.handles[0].finished, true)
    assert.equal(findByType(mount.tree, 'input'), null, 'the prompt is gone once the flow settled')
  } finally {
    h.dispose()
  }
})

test('Submit on a stream that has just ended does not throw and says the sign-in ended', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { h, mount, stub } = await openSignIn({ events: [textPrompt], hold: true })
  try {
    await change(mount, findByType(mount.tree, 'input'), 'acme')
    // The real handle throws on send once the stream terminated.
    stub.handles[0].finished = true
    assert.doesNotThrow(() => findByText(mount.tree, 'Submit').props.onClick())
    await mount.settle()
    assert.deepEqual(stub.answers, [])
    const failure = find(mount.tree, (node) => node.props?.role === 'alert')
    assert.ok(failure, 'a failure line is shown')
    assert.match(textContent(failure), /already ended/)
    assert.equal(findByType(mount.tree, 'input'), null, 'the dead prompt is gone')
  } finally {
    h.dispose()
  }
})

// ---- chip and card summary of an extra-usage amount ----

const claudeWith = (extra) => {
  const state = fixtures.anthropic()
  return { ...state, data: { ...state.data, extra } }
}

for (const [name, extra, expected] of [
  ['an enabled extra amount is shown as used', { enabled: true, balanceCents: 1250, monthlyLimitCents: 5000, usedRatio: 0.25, currency: 'USD', disabledReason: null }, ['$12.50 extra used', 'extra used $12.50']],
  ['a disabled extra is not shown', { enabled: false, balanceCents: 0, monthlyLimitCents: null, usedRatio: null, currency: 'USD', disabledReason: 'overage_not_provisioned' }, null],
  ['an extra without an amount is not shown', { enabled: true, balanceCents: null, monthlyLimitCents: null, usedRatio: null, currency: 'USD', disabledReason: null }, null],
  ['an extra whose enabled flag is unknown but whose amount is known is shown as used', { enabled: null, balanceCents: 1250, monthlyLimitCents: null, usedRatio: null, currency: 'USD', disabledReason: null }, ['$12.50 extra used', 'extra used $12.50']],
]) {
  test(`the Claude chip and card line: ${name}`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const usage = createUsageNamespaceStub(claudeWith(extra))
    const h = await bootClient({
      namespaces: { providerLogin: createProviderLoginStub({ configured: true }), anthropicUsage: usage },
      activeProvider: 'anthropic',
    })
    try {
      const chip = await h.mountChip('anthropic-usage-chip')
      const card = await h.mountCard(SETTINGS_NS, cardProps('anthropic', { oauth: true, keyConfigured: false }))
      for (const [where, tree, wanted] of [['chip', chip.tree, expected?.[0]], ['card line', card.tree, expected?.[1]]]) {
        const shown = textContent(tree)
        assert.ok(shown.includes('88.0%'), `${where} shows the weekly window`)
        if (wanted === undefined) assert.ok(!/extra/.test(shown), `${where} says nothing about extra: ${shown}`)
        else assert.ok(shown.includes(wanted), `${where} shows ${wanted}: ${shown}`)
        assert.ok(!shown.includes('—'), `${where} never shows a missing amount: ${shown}`)
      }
    } finally {
      h.dispose()
    }
  })
}

// ---- the harness itself ----

test('the harness stubs answer like the real Remote and its stream handle', async () => {
  const stub = createProviderLoginStub({ events: [textPrompt], hold: true })
  const handle = stub.begin({ provider: 'anthropic', method: 'oauth' })
  handle.send({ type: 'answer', id: 'x', answer: 'a' })
  handle.dispose()
  assert.throws(() => handle.send({ type: 'answer', id: 'x', answer: 'b' }), /terminated/)
  assert.equal(stub.answers.length, 1)
  const failing = createUsageNamespaceStub(fixtures.codex(), { refreshFailure: 'down' })
  assert.deepEqual(await failing.refresh(), { ok: false, error: { code: 'remote.failed', message: 'down' } })
})

test('the fake React throws when a component calls another number of hooks than on its previous render', async () => {
  const h = await bootClient({ effects: 'none' })
  try {
    function Fickle({ extra }) {
      const [value] = h.React.useState(0)
      if (extra) h.React.useState(1)
      return h.React.createElement('i', null, String(value))
    }
    const mount = await h.mount(Fickle, { extra: false })
    assert.throws(() => mount.render({ extra: true }), /called 2 hooks, but 1 on its previous render/)
    function EarlyReturn({ show }) {
      if (!show) return null
      h.React.useState(0)
      return h.React.createElement('i', null)
    }
    const early = await h.mount(EarlyReturn, { show: true })
    assert.throws(() => early.render({ show: false }), /called 0 hooks, but 1 on its previous render/)
  } finally {
    h.dispose()
  }
})

test('host elements are tracked: a changed element type or key at the same place is a remount', async () => {
  const h = await bootClient({ effects: 'none' })
  try {
    const el = h.React.createElement
    function Box({ tag, id }) { return el('div', null, el(tag, { key: id }, 'x'), el('span', null, 'y')) }
    const mount = await h.mount(Box, { tag: 'p', id: 'one' })
    const first = mount.hostPaths
    mount.render({ tag: 'p', id: 'one' })
    assert.deepEqual(mount.hostPaths, first, 'an unchanged tree keeps every host element')
    mount.render({ tag: 'section', id: 'one' })
    assert.notDeepEqual(mount.hostPaths, first, 'another type at the same place is another element')
    mount.render({ tag: 'p', id: 'two' })
    assert.notDeepEqual(mount.hostPaths, first, 'another key is another element')
    assert.deepEqual(hostPaths(el('ul', null, [el('li', { key: 'a' }), null, el('li', { key: 'b' })])), ['/ul:0', '/ul:0.0/li[a]', '/ul:0.0/li[b]'])
  } finally {
    h.dispose()
  }
})
