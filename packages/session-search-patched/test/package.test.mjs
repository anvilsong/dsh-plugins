// Package-shape test of dsh-plugin-session-search-patched: package.json, the
// bundle patch, the licences and the shipped file list.
// Run: node --test packages/session-search-patched/test/package.test.mjs   (Node 24)
//
// README.md is the one shipped path that may be missing: a later task writes it.
// The test accepts its absence ONLY for README.md (and says so in its name);
// every other listed path must exist.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const file = (...parts) => path.join(ROOT, ...parts)
const pkg = JSON.parse(fs.readFileSync(file('package.json'), 'utf8'))
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

// The patch text and its hash as decided by docs/composition-spike.md section 13.
const PATCH_SHA256 = 'b5217930e77e81ce833e8233f7861f41c2530115054318b11d8944cfcd84be0d'
const PATCH_BYTES = 846
const OPTIONAL_PATHS = new Set(['README.md'])

const PEERS = {
  '@deepseek-ai/cordis': '~4.1.0',
  '@deepseek-ai/schemastery': '~3.19.0',
  '@deepseek-ai/dsh-session': '0.2.2-rc.3 || 0.2.2-rc.5',
  '@deepseek-ai/dsh-session-query': '0.2.2-rc.3 || 0.2.2-rc.5',
  '@deepseek-ai/dsh-session-query-sqlite': '0.2.2-rc.3 || 0.2.2-rc.5',
}

const exists = (relative) => fs.existsSync(file(relative))

describe('package.json', () => {
  test('identity and module type', () => {
    assert.equal(pkg.name, 'dsh-plugin-session-search-patched')
    assert.equal(pkg.version, '0.1.0')
    assert.equal(pkg.license, 'MIT')
    assert.equal(pkg.type, 'module')
    assert.equal(typeof pkg.description, 'string')
    assert.ok(pkg.description.length > 0)
  })

  test('main and exports point at the host entry, the patch, the bundle patch and package.json', () => {
    assert.equal(pkg.main, 'src/index.host.js')
    assert.deepEqual(pkg.exports, {
      '.': { default: './src/index.host.js' },
      './cordis.patch.yml': './cordis.patch.yml',
      './package.json': './package.json',
    })
    assert.deepEqual(pkg.dsh, { bundle: { patch: './cordis.patch.yml' } })
  })

  test('no client half, no scripts, no dependencies of any kind besides the host peers', () => {
    assert.equal(pkg.dsh.client, undefined)
    assert.equal(pkg.scripts, undefined)
    for (const key of ['dependencies', 'optionalDependencies', 'devDependencies', 'bundleDependencies', 'bundledDependencies']) {
      assert.equal(pkg[key], undefined, key)
    }
    assert.equal(pkg.private, undefined)
  })

  test('peerDependencies are exactly the host packages of the spike decision', () => {
    assert.deepEqual(pkg.peerDependencies, PEERS)
  })

  test('engines.dsh admits exactly the pinned host versions', () => {
    assert.deepEqual(pkg.engines, { dsh: '0.2.2-rc.3 || 0.2.2-rc.5' })
  })

  test('the pin admits rc.3 and rc.5 because the engine sources are identical', () => {
    const provenance = fs.readFileSync(file('vendor/PROVENANCE.md'), 'utf8')
    assert.match(provenance, /dsh-v0\.2\.2-rc\.5/, 'the provenance names the rc.5 tag')
    assert.match(provenance, /ships the same `src\/index\.ts`/, 'the provenance records the identical engine bytes')
  })

  test('engines.dsh is the pinned host version', () => {
    assert.deepEqual(pkg.engines, { dsh: '0.2.2-rc.3 || 0.2.2-rc.5' })
  })

  test('every export target and the main entry exist', () => {
    const targets = [pkg.main]
    const collect = (value) => {
      if (typeof value === 'string') targets.push(value)
      else for (const inner of Object.values(value)) collect(inner)
    }
    collect(pkg.exports)
    targets.push(pkg.dsh.bundle.patch)
    for (const target of targets) {
      assert.ok(!target.includes('*'), `${target} is a pattern`)
      assert.ok(exists(target), `${target} does not exist`)
    }
  })
})

describe('cordis.patch.yml', () => {
  const bytes = fs.readFileSync(file('cordis.patch.yml'))
  const text = bytes.toString('utf8')

  test('is byte-identical to the patch text chosen in the spike (sha256 and size)', () => {
    assert.equal(sha256(bytes), PATCH_SHA256)
    assert.equal(bytes.length, PATCH_BYTES)
  })

  test('the spike document records the same sha256 and the candidate file has it', () => {
    const doc = fs.readFileSync(file('docs/composition-spike.md'), 'utf8')
    assert.ok(doc.includes(PATCH_SHA256), 'docs/composition-spike.md does not name the sha256')
    const candidate = fs.readFileSync(file('docs/spike/candidates/A-bare-disable-insert.yml'))
    assert.ok(candidate.equals(bytes), 'differs from docs/spike/candidates/A-bare-disable-insert.yml')
  })

  test('row id, name and config of the new row, and no expression', () => {
    assert.match(text, /^ {4}- id: session-query-sqlite-patched$/m)
    assert.match(text, /^ {6}name: dsh-plugin-session-search-patched$/m)
    assert.match(
      text,
      /^ {6}config:\n {8}path: ':memory:'\n {8}openAt: first-search\n {8}persistedReadConcurrency: 1\n?$/m,
    )
    assert.ok(!text.includes('!!js'))
  })

  test('the shipped row is switched off by its bare id and the new row joins the same group', () => {
    assert.match(text, /^- id: optional-session-query-sqlite\n {2}name: '@deepseek-ai\/dsh-session-query-sqlite'\n {2}disabled: true$/m)
    assert.match(text, /^- id: optional-session-search\n {2}insert:$/m)
  })

  test('the config key persistedReadConcurrency exists in the vendored engine schema', () => {
    // The key is declared in the config schema inside vendor/src/index.ts
    // (vendor/src/schema.ts holds only the store schema and has no such key).
    const index = fs.readFileSync(file('vendor/src/index.ts'), 'utf8')
    assert.match(index, /persistedReadConcurrency: z\.number\(\)/)
    assert.match(index, /openAt/)
    assert.match(index, /path: z\.string\(\)/)
  })
})

describe('licences', () => {
  test('LICENSE is the MIT licence of this package', () => {
    const text = fs.readFileSync(file('LICENSE'), 'utf8')
    assert.match(text, /^MIT License\n\nCopyright \(c\) 2026 .+\n\nPermission is hereby granted, free of charge/)
    assert.ok(text.includes('THE SOFTWARE IS PROVIDED "AS IS"'))
    assert.ok(!text.includes('DeepSeek'), 'the upstream notice belongs to vendor/LICENSE.upstream')
  })

  test('the upstream notice stays in vendor/LICENSE.upstream (MIT) and ships through files', () => {
    const text = fs.readFileSync(file('vendor/LICENSE.upstream'), 'utf8')
    assert.match(text, /^MIT License\n\nCopyright \(c\) 2026 DeepSeek\n/)
    assert.ok(pkg.files.includes('vendor/LICENSE.upstream'))
    assert.ok(pkg.files.includes('LICENSE'))
  })
})

describe('files', () => {
  const REQUIRED = [
    'src',
    'cordis.patch.yml',
    'README.md',
    'LICENSE',
    'vendor/src',
    'vendor/PROVENANCE.md',
    'vendor/LICENSE.upstream',
    'patches',
  ]

  test('lists exactly the shipped paths', () => {
    assert.deepEqual([...pkg.files].sort(), [...REQUIRED].sort())
  })

  test('does not ship vendor/tests, docs, scripts or test', () => {
    const covers = (entry, target) => target === entry || target.startsWith(`${entry}/`)
    for (const target of ['vendor/tests', 'vendor/tests/sqlite.spec.ts', 'docs', 'scripts', 'test']) {
      for (const entry of pkg.files) assert.ok(!covers(entry, target), `${entry} ships ${target}`)
    }
    assert.ok(!pkg.files.includes('vendor'), 'the whole vendor folder would ship vendor/tests')
  })

  test('every listed path exists (README.md alone may be missing until the README task adds it)', (t) => {
    const missing = []
    for (const entry of pkg.files) {
      if (!exists(entry)) missing.push(entry)
    }
    const unexpected = missing.filter((entry) => !OPTIONAL_PATHS.has(entry))
    assert.deepEqual(unexpected, [], `missing shipped paths: ${unexpected.join(', ')}`)
    if (missing.length > 0) t.diagnostic(`accepted absence (written by a later task): ${missing.join(', ')}`)
  })

  test('the shipped src folder contains the entry, the guard and the engine', () => {
    for (const relative of ['src/index.host.js', 'src/guard.js', 'src/engine/index.js', 'src/engine/query.js', 'src/engine/schema.js']) {
      assert.ok(exists(relative), relative)
    }
    assert.ok(fs.statSync(file('patches')).isDirectory())
    assert.ok(fs.statSync(file('vendor/src')).isDirectory())
  })
})
