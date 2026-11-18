#!/usr/bin/env node
// S8 drill (c): plant one SYNTHETIC session into the store of a scratch DSH
// home. Nothing here reads an existing session log.
//
//   node test/scratch/plant-session.mjs <scratch-root> unknown-type
//       a v4 log whose only event has a type outside the rc.3 vocabulary and no
//       `ignorable` marker (a log of a newer harness: the reader must refuse it)
//   node test/scratch/plant-session.mjs <scratch-root> unreadable
//       a header-only v4 log whose file mode is 000 (unreadable by the host)
//   node test/scratch/plant-session.mjs <scratch-root> valid-empty
//       a readable header-only v4 log (control: the planted format is accepted)
//   node test/scratch/plant-session.mjs <scratch-root> remove
//       remove the planted session directory again
//
// Gate: scratch-home.mjs must accept <root>/home/.dsh, and every written path
// lies under <root>/home/.dsh/sessions/--tmp-ssp-s8-drill--/.

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

const here = path.dirname(fileURLToPath(import.meta.url))
const [root, mode] = process.argv.slice(2)
if (!root || !['unknown-type', 'unreadable', 'valid-empty', 'remove'].includes(mode)) {
  process.stderr.write('usage: plant-session.mjs <scratch-root> unknown-type|unreadable|valid-empty|remove\n')
  process.exit(64)
}
const check = spawnSync(process.execPath, [path.join(here, '../../scripts/scratch-home.mjs'), 'check', path.join(root, 'home', '.dsh')], { encoding: 'utf8' })
if (check.status !== 0) {
  process.stderr.write(check.stderr)
  process.exit(2)
}

// The JSONL backend keys a project by its cwd (format.ts projectKey) and a
// session by its id (encodeSegment): /tmp/ssp-s8-drill -> --tmp-ssp-s8-drill--.
const CWD = '/tmp/ssp-s8-drill'
const IDS = { 'unknown-type': '5508d8c0-0000-4000-8000-00000000000a', unreadable: '5508d8c0-0000-4000-8000-00000000000b', 'valid-empty': '5508d8c0-0000-4000-8000-00000000000c' }
const ID = IDS[mode]
const store = path.join(root, 'home', '.dsh', 'sessions')
const project = path.join(store, '--tmp-ssp-s8-drill--')
if (!existsSync(store)) {
  process.stderr.write(`no store at ${store}\n`)
  process.exit(2)
}

if (mode === 'remove') {
  if (existsSync(project)) {
    for (const id of Object.values(IDS)) {
      const log = path.join(project, id, 'session.v4.jsonl.zstd')
      if (existsSync(log)) chmodSync(log, 0o600)
    }
    rmSync(project, { recursive: true, force: true })
  }
  process.stdout.write(`removed ${project}\n`)
  process.exit(0)
}

const now = Date.UTC(2026, 10, 18, 10, 0, 0)
const header = { type: 'session', version: 4, id: ID, createdAt: now, cwd: CWD, isSeeded: false, delegationDepth: 0 }
// The backend's Zstandard layout: the first frame holds exactly the header
// line, each later frame a batch of event lines (frames are concatenated).
const frames = [zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n'))]
if (mode === 'unknown-type') {
  const event = { type: 'ssp-s8-drill/required-future-event', seq: 0, time: now + 1, data: { note: 'synthetic drill event' } }
  frames.push(zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n')))
}
const dir = path.join(project, ID)
mkdirSync(dir, { recursive: true, mode: 0o700 })
const log = path.join(dir, 'session.v4.jsonl.zstd')
writeFileSync(log, Buffer.concat(frames), { mode: 0o600 })
writeFileSync(path.join(dir, 'session.lock'), '', { mode: 0o600 })
if (mode === 'unreadable') chmodSync(log, 0o000)
process.stdout.write(`planted ${mode} session ${ID} at ${dir}\n`)
