/**
 * The OAuth sign-in block of a provider card (ProviderLoginAction), driven
 * through the render harness: prompt label, focus, Enter, Cancel, unmount,
 * link wrapping, alert errors, and the usage line right after sign-in.
 */

import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import {
  bootClient as bootHarness, cardProps, change, createProviderLoginStub, createUsageNamespaceStub, find, findAll, findByText, findByType, textContent,
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
