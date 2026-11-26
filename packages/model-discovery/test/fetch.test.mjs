import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchJson, MAX_BODY_BYTES } from '../src/index.host.js'

// Fake fetch implementations only; no request leaves the process.
const streamOf = (...chunks) => new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk)
    controller.close()
  },
})

test('fetchJson refuses redirects, asks for JSON and parses the body', async () => {
  let seen
  const value = await fetchJson('https://registry.npmjs.org/x', 1000, async (url, init) => {
    seen = { url, init }
    return new Response(streamOf('{"version":', '"1.6.0"}'), { status: 200 })
  })
  assert.deepEqual(value, { version: '1.6.0' })
  assert.equal(seen.init.redirect, 'error')
  assert.equal(seen.init.headers.accept, 'application/json')
  assert.ok(seen.init.signal instanceof AbortSignal)
})

test('fetchJson reports HTTP errors', async () => {
  await assert.rejects(fetchJson('https://unpkg.com/x', 1000, async () => new Response('no', { status: 404 })), /HTTP 404/)
})

test('fetchJson rejects a declared body over 1 MB without reading it', async () => {
  let pulled = false
  const body = new ReadableStream({ pull(controller) { pulled = true; controller.close() } }, { highWaterMark: 0 })
  const response = new Response(body, { status: 200, headers: { 'content-length': String(MAX_BODY_BYTES + 1) } })
  await assert.rejects(fetchJson('https://unpkg.com/x', 1000, async () => response), /exceeds 1 MB/)
  assert.equal(pulled, false)
})

test('fetchJson stops reading a streamed body once it passes 1 MB', async () => {
  let chunks = 0
  const body = new ReadableStream({
    pull(controller) {
      chunks += 1
      controller.enqueue(new Uint8Array(256 * 1024))
    },
  })
  await assert.rejects(fetchJson('https://unpkg.com/x', 1000, async () => new Response(body, { status: 200 })), /exceeds 1 MB/)
  assert.ok(chunks <= 6, `read ${chunks} chunks`)
})

test('fetchJson times out and aborts the request', async () => {
  let aborted = false
  const started = Date.now()
  await assert.rejects(fetchJson('https://unpkg.com/x', 30, (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => { aborted = true; reject(init.signal.reason) })
  })), /timed out after 30 ms/)
  assert.equal(aborted, true)
  assert.ok(Date.now() - started < 2000)
})

test('fetchJson rejects invalid UTF-8 and invalid JSON', async () => {
  await assert.rejects(fetchJson('https://unpkg.com/x', 1000, async () => new Response(streamOf(new Uint8Array([0xff, 0xfe])), { status: 200 })))
  await assert.rejects(fetchJson('https://unpkg.com/x', 1000, async () => new Response(streamOf('<html>'), { status: 200 })), SyntaxError)
})
