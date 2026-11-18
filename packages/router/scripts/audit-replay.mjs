#!/usr/bin/env node
// Development tool: replay one session log through the routerAudit fold.
//
//   <decompress the log> | node packages/router/scripts/audit-replay.mjs
//
// Reads the log as JSONL from stdin (one event per line; the caller
// decompresses it), folds every line that is valid JSON with foldAudit,
// skips every other line, and prints one JSON object to stdout:
// { events, router: { mode, selections }, total, counts, levels, reserved, discovery }.
// It touches nothing but stdin and stdout: no file, network, clock or
// environment. It is not in the package's published files.
import { createInterface } from 'node:readline'
import { foldAudit, initAudit } from '../src/audit.js'

// A closed output pipe (for example `| head`) ends the run quietly.
process.stdout.on('error', () => process.exit(0))

let state = initAudit()
let events = 0
let first = true
for await (const raw of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  // A leading byte-order mark would make the first line invalid JSON.
  const line = first && raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  first = false
  let event
  try {
    event = JSON.parse(line)
  } catch {
    continue
  }
  events += 1
  state = foldAudit(state, event)
}
const { router, total, counts, levels, reserved, discovery } = state
process.stdout.write(`${JSON.stringify({ events, router: { mode: router.mode, selections: router.selections }, total, counts, levels, reserved, discovery })}\n`)
