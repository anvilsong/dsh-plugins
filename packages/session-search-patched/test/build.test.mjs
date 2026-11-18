// Tests for scripts/build.mjs (the deterministic type-strip generator).
// Run: node --test packages/session-search-patched/test/build.test.mjs   (Node 24)

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'

import { findFieldsWithoutInitializer, resolveInside, scanModuleSyntax, tokenize } from '../scripts/build.mjs'

const PKG = path.resolve(import.meta.dirname, '..')
const SCRIPT = path.join(PKG, 'scripts', 'build.mjs')
const FIXTURES = path.join(PKG, 'test', 'fixtures', 'build')
const OK = path.join(FIXTURES, 'ok')
const REFUSE = path.join(FIXTURES, 'refuse')
const NODE_MAJOR = Number(process.versions.node.split('.')[0])

const sha = (data) => createHash('sha256').update(data).digest('hex')
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8')

/** A temp package root with the given files ({ 'vendor/src/index.ts': text }); removed after the test. */
function makeRoot(t, files = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-build-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  return root
}

/** Root holding the whole ok fixture and its config. */
function okRoot(t, { config = true } = {}) {
  const files = {}
  for (const name of ['index.ts', 'query.ts', 'schema.ts']) files[`vendor/src/${name}`] = read(OK, name)
  if (config) files['scripts/build.config.json'] = read(OK, 'build.config.json')
  return makeRoot(t, files)
}

/** Root holding one refusal fixture as vendor/src/index.ts. */
function refuseRoot(t, name, extra = {}) {
  return makeRoot(t, { 'vendor/src/index.ts': read(REFUSE, name), ...extra })
}

/** Run the script. `root` null means the real package directory. */
function run(args, root) {
  const argv = [SCRIPT, ...(root === null ? [] : ['--root', root]), ...args]
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr.split('\n').filter((l) => !/ExperimentalWarning|trace-warnings/.test(l)).join('\n') }
}

const build = (root, args = []) => run(args, root)
const OUT_FILES = ['index.js', 'query.js', 'schema.js', 'manifest.json']
const outText = (root, name) => read(root, 'src', 'engine', name)
const outDir = (root) => path.join(root, 'src', 'engine')

/** Every file below `dir` as { relative path: bytes hex }, to prove that nothing changed. */
function snapshot(dir) {
  const result = {}
  const walk = (d, prefix) => {
    if (!fs.existsSync(d)) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), `${prefix}${e.name}/`)
      else result[`${prefix}${e.name}`] = sha(fs.readFileSync(path.join(d, e.name)))
    }
  }
  walk(dir, '')
  return result
}

describe('script shape', () => {
  test('imports only node: builtins and uses strip mode', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8')
    const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1])
    assert.ok(specifiers.length >= 5, 'expected the import lines to be found')
    for (const spec of specifiers) assert.match(spec, /^node:/, `non-builtin import: ${spec}`)
    assert.doesNotMatch(source, /^\s*import\s*\(/m)
    assert.doesNotMatch(source, /\brequire\(/)
    assert.match(source, /stripTypeScriptTypes\(source, \{ mode: 'strip' \}\)/)
    assert.doesNotMatch(source, /mode:\s*'transform'/)
  })

  test('--help exits 0 and an unknown argument exits 2', () => {
    assert.equal(run(['--help'], null).status, 0)
    const bad = run(['--nope'], null)
    assert.equal(bad.status, 2)
    assert.match(bad.stderr, /unknown argument/)
  })
})

describe('generation of the ok fixture', () => {
  test('writes index, query, schema and the manifest, and nothing else', (t) => {
    const root = okRoot(t)
    const r = build(root)
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(fs.readdirSync(outDir(root)).sort(), [...OUT_FILES].sort())
    assert.deepEqual(fs.readdirSync(root).sort(), ['scripts', 'src', 'vendor'])
  })

  test('manifest hashes: every input and output, script, config, node and base version', (t) => {
    const root = okRoot(t)
    assert.equal(build(root).status, 0)
    const manifest = JSON.parse(outText(root, 'manifest.json'))
    assert.equal(manifest.schema, 1)
    assert.equal(manifest.baseVersion, 'fixture-1')
    assert.equal(manifest.node.major, NODE_MAJOR)
    assert.equal(manifest.node.version, process.version)
    assert.deepEqual(Object.keys(manifest.inputs), ['vendor/src/index.ts', 'vendor/src/query.ts', 'vendor/src/schema.ts'])
    assert.deepEqual(Object.keys(manifest.outputs), ['src/engine/index.js', 'src/engine/query.js', 'src/engine/schema.js'])
    for (const [rel, hash] of Object.entries({ ...manifest.inputs, ...manifest.outputs })) {
      assert.equal(sha(fs.readFileSync(path.join(root, rel))), hash, rel)
    }
    assert.equal(manifest.script.path, 'scripts/build.mjs')
    assert.equal(manifest.script.sha256, sha(fs.readFileSync(SCRIPT)))
    assert.equal(manifest.config.sha256, sha(fs.readFileSync(path.join(root, 'scripts', 'build.config.json'))))
  })

  test('every generated file parses', (t) => {
    const root = okRoot(t)
    assert.equal(build(root).status, 0)
    for (const name of ['index.js', 'query.js', 'schema.js']) {
      // a plain .js file without a package.json is read as CommonJS, so check the text as a module on stdin
      const m = spawnSync(process.execPath, ['--check', '--input-type=module', '-'], { input: outText(root, name), encoding: 'utf8' })
      assert.equal(m.status, 0, `${name}: ${m.stderr}`)
    }
  })

  test('type syntax is erased to whitespace and the line count is preserved', (t) => {
    const root = okRoot(t)
    assert.equal(build(root).status, 0)
    const normalize = (text) => text.replace(/'@deepseek-ai\/dsh-session-query'/g, "'../x'").replace(/'\.{1,2}\/[^'\n]*'/g, "'REL'")
    for (const name of ['index', 'query', 'schema']) {
      const input = read(OK, `${name}.ts`)
      const output = outText(root, `${name}.js`)
      assert.equal(output.split('\n').length, input.split('\n').length, `${name}: line count`)
      const a = normalize(input).split('\n')
      const b = normalize(output).split('\n')
      a.forEach((line, i) => {
        assert.equal(b[i].length, line.length, `${name}:${i + 1}: width`)
        for (let c = 0; c < line.length; c += 1) {
          const out = b[i][c]
          assert.ok(out === line[c] || out === ' ' || out === '\ufeff' || out === ';', `${name}:${i + 1}:${c + 1}: ${JSON.stringify(out)} replaces ${JSON.stringify(line[c])}`)
        }
      })
    }
  })

  test('erases import type, inline type specifiers, satisfies, as, override, declare fields and generics', (t) => {
    const root = okRoot(t)
    const inputs = ['index', 'query', 'schema'].map((n) => read(OK, `${n}.ts`)).join('\n')
    for (const [what, pattern] of Object.entries({
      'import type': /^import type /m,
      'inline type specifier': /import \{[^}]*\btype \w+/,
      satisfies: /\} satisfies Record/,
      as: /\bas number\b/,
      override: /static override inject|override async close/,
      'declare field': /declare note: string/,
      'declare module': /declare module '/,
      generics: /identity<T>\(value\)|method<T extends object>/,
    })) assert.match(inputs, pattern, `fixture lacks ${what}`)
    assert.equal(build(root).status, 0)
    const all = ['index', 'query', 'schema'].map((n) => outText(root, `${n}.js`)).join('\n')
    assert.doesNotMatch(all, /^import type /m)
    assert.doesNotMatch(all, /\btype \w+[,}]/)
    assert.doesNotMatch(all, /\bsatisfies\s+[A-Z]/)
    assert.doesNotMatch(all, /\bas (number|T)\b/)
    assert.doesNotMatch(all, /\boverride\b/)
    assert.doesNotMatch(all, /\bdeclare\b/)
    assert.doesNotMatch(all, /\babstract\b/)
    assert.doesNotMatch(all, /\w<[A-Za-z]/)
    assert.doesNotMatch(all, /\bnote\b/)
    assert.doesNotMatch(all, /\bbrand\b/)
    assert.doesNotMatch(all, /interface |type Mode =|type Unused/)
    assert.match(all, /static\s+inject = \['sessions'\]/)
    assert.match(all, /\bclass Engine extends Service\b/)
  })

  test('string, template, regex and comment text is never mistaken for syntax', (t) => {
    const root = okRoot(t)
    const r = build(root)
    assert.equal(r.status, 0, r.stderr)
    const schema = outText(root, 'schema.js')
    assert.match(schema, /NOT_A_SPECIFIER = "import x from 'left-pad'; @decorator class A \{\}"/)
    assert.match(schema, /import\('also-nothing'\)/)
    assert.match(schema, /\/import\\s\+\['"\]x\['"\]\|@\\w\+\/g/)
  })

  test('specifier lists: type-only imports vanish, .ts becomes .js, configured specifiers are mapped', (t) => {
    const root = okRoot(t)
    assert.equal(build(root).status, 0)
    const staticSpecs = (text) => [...text.matchAll(/^(?:import|export)\b[^;'"`]*?\bfrom\s*(['"])([^'"\n]+)\1/gm)].map((m) => m[2])
    const dynamicSpecs = (text) => [...text.matchAll(/\bawait import\('([^']+)'\)/g)].map((m) => m[1])
    const before = { index: read(OK, 'index.ts'), query: read(OK, 'query.ts'), schema: read(OK, 'schema.ts') }
    assert.deepEqual(staticSpecs(before.schema), ['node:sqlite', 'node:path'])
    assert.deepEqual(dynamicSpecs(before.schema), ['node:sqlite'])
    assert.deepEqual(staticSpecs(before.query), ['@deepseek-ai/dsh-session-query', './schema.ts', 'left-pad', './schema.ts', './schema.js'])
    assert.deepEqual(staticSpecs(before.index), [
      'node:crypto', '@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-session-persistence', './query.ts', './schema.ts',
    ])
    const after = { index: outText(root, 'index.js'), query: outText(root, 'query.js'), schema: outText(root, 'schema.js') }
    assert.deepEqual(staticSpecs(after.schema), ['node:path'])
    assert.deepEqual(dynamicSpecs(after.schema), ['node:sqlite'])
    assert.deepEqual(staticSpecs(after.query), ['../shim/session-query.js', './schema.js', './schema.js', './schema.js'])
    assert.deepEqual(staticSpecs(after.index), ['node:crypto', '@deepseek-ai/cordis', '@deepseek-ai/schemastery', './query.js', './schema.js'])
  })

  test('without a config file nothing is mapped (and the base version must come from the flag)', (t) => {
    const root = okRoot(t, { config: false })
    const missing = build(root)
    assert.equal(missing.status, 2)
    assert.match(missing.stderr, /base version is missing/)
    assert.equal(fs.existsSync(path.join(root, 'src')), false)
    const r = build(root, ['--base-version', 'flag-1'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(outText(root, 'query.js'), /from '@deepseek-ai\/dsh-session-query'/)
    assert.doesNotMatch(outText(root, 'query.js'), /shim/)
    const manifest = JSON.parse(outText(root, 'manifest.json'))
    assert.equal(manifest.baseVersion, 'flag-1')
    assert.equal(manifest.config.sha256, null)
  })

  test('prints and records the class fields without initializer', (t) => {
    const root = okRoot(t)
    const r = build(root)
    assert.equal(r.status, 0, r.stderr)
    const input = read(OK, 'index.ts').split('\n')
    const expected = []
    input.forEach((line, i) => {
      const m = /\/\/ field: (static )?(\w+)\.(#?\w+)$/.exec(line)
      if (m === null) return
      const col = line.search(new RegExp(`(?<![\\w#])${m[3].replace('#', '#?')}(?![\\w])`)) + 1
      expected.push(`src/engine/index.js:${i + 1}:${col} ${m[1] ?? ''}${m[2]}.${m[3]}`)
    })
    assert.equal(expected.length, 10)
    const listed = r.stdout.split('\n').filter((l) => /^ {2}src\/engine\/.*:\d+:\d+ /.test(l) && !l.endsWith('0)')).map((l) => l.trim())
    const fields = listed.filter((l) => expected.includes(l))
    assert.deepEqual(fields, expected)
    assert.match(r.stdout, /class fields without initializer \(10\):/)
    const manifest = JSON.parse(outText(root, 'manifest.json'))
    assert.deepEqual(manifest.classFieldsWithoutInitializer, expected)
  })

  test('semicolons that Node writes in place of erased modifiers are listed, and only those', (t) => {
    const root = okRoot(t)
    assert.equal(build(root).status, 0)
    const manifest = JSON.parse(outText(root, 'manifest.json'))
    const found = []
    for (const name of ['index', 'query', 'schema']) {
      const input = read(OK, `${name}.ts`).split('\n')
      const output = outText(root, `${name}.js`).split('\n')
      output.forEach((line, i) => {
        for (let c = 0; c < line.length; c += 1) {
          if (line[c] === ';' && input[i][c] !== ';' && !/['"`/]/.test(input[i])) found.push(`src/engine/${name}.js:${i + 1}:${c + 1}`)
        }
      })
    }
    assert.deepEqual(manifest.semicolonsInsertedByStrip, found)
    assert.ok(found.length >= 1, 'the fixture should exercise the case')
  })
})

describe('determinism', () => {
  test('two runs and two different roots give identical bytes, with no path, date or host name', (t) => {
    const a = okRoot(t)
    const b = okRoot(t)
    assert.equal(build(a).status, 0)
    const first = snapshot(outDir(a))
    assert.equal(build(a).status, 0)
    assert.deepEqual(snapshot(outDir(a)), first)
    assert.equal(build(b).status, 0)
    assert.deepEqual(snapshot(outDir(b)), first)
    for (const name of OUT_FILES) {
      const text = outText(a, name)
      for (const forbidden of [a, b, os.tmpdir(), os.homedir(), os.hostname(), process.cwd(), PKG, '/Users/', '/home/', '/private/']) {
        assert.ok(!text.includes(forbidden), `${name} contains ${forbidden}`)
      }
      assert.doesNotMatch(text, /\b(?:19|20)\d\d-\d\d-\d\d\b/)
      assert.doesNotMatch(text, /\d\d:\d\d:\d\d/)
    }
  })
})

describe('--check', () => {
  test('passes on a fresh build', (t) => {
    const root = okRoot(t)
    assert.equal(build(root).status, 0)
    const r = build(root, ['--check'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /matches a fresh generation/)
  })

  test('fails on one mutated byte of an output', (t) => {
    const root = okRoot(t)
    assert.equal(build(root).status, 0)
    const file = path.join(outDir(root), 'query.js')
    const bytes = fs.readFileSync(file)
    bytes[bytes.indexOf('Fixture')] ^= 0x01
    fs.writeFileSync(file, bytes)
    const r = build(root, ['--check'])
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /differs from regenerated output: src\/engine\/query\.js/)
  })

  test('fails on one mutated byte of the manifest', (t) => {
    const root = okRoot(t)
    assert.equal(build(root).status, 0)
    const file = path.join(outDir(root), 'manifest.json')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"schema": 1', '"schema": 2'))
    const r = build(root, ['--check'])
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /manifest\.json/)
  })

  test('fails on an extra file, also in a subfolder', (t) => {
    const root = okRoot(t)
    assert.equal(build(root).status, 0)
    fs.writeFileSync(path.join(outDir(root), 'stray.js'), 'export {}\n')
    const r = build(root, ['--check'])
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /extra file: src\/engine\/stray\.js/)
    fs.rmSync(path.join(outDir(root), 'stray.js'))
    fs.mkdirSync(path.join(outDir(root), 'sub'))
    fs.writeFileSync(path.join(outDir(root), 'sub', 'x.txt'), 'x')
    const s = build(root, ['--check'])
    assert.notEqual(s.status, 0)
    assert.match(s.stderr, /extra file: src\/engine\/sub\/x\.txt/)
  })

  test('fails on a missing output and on a missing manifest', (t) => {
    const root = okRoot(t)
    assert.equal(build(root).status, 0)
    fs.rmSync(path.join(outDir(root), 'schema.js'))
    const r = build(root, ['--check'])
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /missing file: src\/engine\/schema\.js/)
    fs.rmSync(path.join(outDir(root), 'manifest.json'))
    const m = build(root, ['--check'])
    assert.notEqual(m.status, 0)
    assert.match(m.stderr, /missing file: src\/engine\/manifest\.json/)
  })

  test('fails when an input changed after the build', (t) => {
    const root = okRoot(t)
    assert.equal(build(root).status, 0)
    const file = path.join(root, 'vendor', 'src', 'schema.ts')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('VERSION = 1', 'VERSION = 2'))
    const r = build(root, ['--check'])
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /schema\.js|manifest\.json/)
  })

  test('cannot verify a manifest from another Node major (exit 3, not a pass)', (t) => {
    const root = okRoot(t)
    assert.equal(build(root).status, 0)
    const file = path.join(outDir(root), 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    manifest.node.major = NODE_MAJOR + 1
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
    const r = build(root, ['--check'])
    assert.equal(r.status, 3)
    assert.match(r.stderr, /cannot check: the manifest was generated with Node/)
  })

  test('ignores the Node patch level recorded in the manifest when the major matches', (t) => {
    const root = okRoot(t)
    assert.equal(build(root).status, 0)
    const file = path.join(outDir(root), 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    manifest.node.version = `v${NODE_MAJOR}.0.0-recorded`
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
    assert.equal(build(root, ['--check']).status, 0)
  })

  test('refuses to build over a folder with an extra file and leaves everything as it was', (t) => {
    const root = okRoot(t)
    fs.mkdirSync(outDir(root), { recursive: true })
    fs.writeFileSync(path.join(outDir(root), 'stray.js'), 'export {}\n')
    const before = snapshot(outDir(root))
    const r = build(root)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /extra file in the output folder/)
    assert.deepEqual(snapshot(outDir(root)), before)
  })
})

describe('manifest against the files on disk', () => {
  /** Independent check: recompute every sha256 named by a manifest. */
  function verifyManifest(root) {
    const manifest = JSON.parse(read(root, 'src', 'engine', 'manifest.json'))
    const mismatches = []
    for (const [rel, hash] of Object.entries({ ...manifest.inputs, ...manifest.outputs })) {
      const file = path.join(root, rel)
      if (!fs.existsSync(file)) mismatches.push(`missing ${rel}`)
      else if (sha(fs.readFileSync(file)) !== hash) mismatches.push(`hash differs ${rel}`)
    }
    if (manifest.config.sha256 !== null && sha(fs.readFileSync(path.join(root, manifest.config.path))) !== manifest.config.sha256) {
      mismatches.push('hash differs config')
    }
    return { manifest, mismatches }
  }

  test('always runs: a fresh fixture build matches, one mutated byte is caught', (t) => {
    const root = okRoot(t)
    assert.equal(build(root).status, 0)
    assert.deepEqual(verifyManifest(root).mismatches, [])
    const file = path.join(root, 'vendor', 'src', 'query.ts')
    fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}// changed\n`)
    assert.deepEqual(verifyManifest(root).mismatches, ['hash differs vendor/src/query.ts'])
  })

  test('the committed src/engine/manifest.json matches the files on disk (when generated)', (t) => {
    const manifestFile = path.join(PKG, 'src', 'engine', 'manifest.json')
    if (!fs.existsSync(manifestFile)) {
      t.diagnostic('src/engine/manifest.json does not exist yet; only the fixture check ran')
      return
    }
    const { manifest, mismatches } = verifyManifest(PKG)
    assert.deepEqual(mismatches, [])
    assert.equal(manifest.script.sha256, sha(fs.readFileSync(SCRIPT)), 'scripts/build.mjs changed after the last generation')
  })

  test('regeneration of the real src/engine matches (--check); skipped when the Node major differs', (t) => {
    const manifestFile = path.join(PKG, 'src', 'engine', 'manifest.json')
    if (!fs.existsSync(manifestFile)) return t.skip('src/engine/manifest.json does not exist yet')
    const recorded = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).node.major
    if (recorded !== NODE_MAJOR) return t.skip(`the manifest was generated with Node ${recorded}; this is Node ${NODE_MAJOR}`)
    const r = run(['--check'], null)
    assert.equal(r.status, 0, r.stderr)
  })
})

describe('refusals: non-zero exit and nothing written', () => {
  const cases = {
    'bad-import.ts': /import specifier "left-pad" is outside the allow-list/,
    'bad-side-effect-import.ts': /import specifier "left-pad" is outside the allow-list/,
    'bad-export-from.ts': /export-from specifier "evil-star" is outside the allow-list[\s\S]*"evil-named"[\s\S]*"evil-ns"/,
    'bad-dynamic-import.ts': /dynamic import specifier "evil-dynamic" is outside the allow-list/,
    'bad-dynamic-import-nonliteral.ts': /dynamic import without a string literal/,
    'bad-require.ts': /require specifier "fs" is outside the allow-list/,
    'bad-require-nonliteral.ts': /require without a string literal/,
    'bad-relative-missing.ts': /relative import specifier "\.\/missing\.ts" does not name another input file/,
    'bad-relative-parent.ts': /relative import specifier "\.\.\/outside\.ts"/,
    'bad-relative-bare.ts': /relative import specifier "\.\/sibling"/,
    'enum.ts': /enum is not supported/,
    'const-enum.ts': /enum is not supported/,
    'namespace-values.ts': /namespace declaration is not supported/,
    'param-property.ts': /parameter property is not supported/,
    'decorator.ts': /index\.ts:2:1: decorator is refused/,
    'method-decorator.ts': /index\.ts:3:3: decorator is refused/,
    'import-equals.ts': /import equals declaration is not supported/,
    'bad-syntax.ts': /output fails the syntax check: SyntaxError: Identifier 'a' has already been declared/,
    'invalid-ts.ts': /Unexpected token/,
  }
  for (const name of fs.readdirSync(REFUSE).sort()) {
    test(name, (t) => {
      assert.ok(Object.hasOwn(cases, name), `no expectation for fixture ${name}`)
      const root = refuseRoot(t, name)
      const r = build(root, ['--base-version', 'x'])
      assert.equal(r.status, 1, r.stdout)
      assert.match(r.stderr, cases[name])
      assert.equal(fs.existsSync(path.join(root, 'src')), false, 'nothing may be written')
      assert.equal(r.stdout, '')
    })
  }

  test('every expectation names an existing fixture', () => {
    for (const name of Object.keys(cases)) assert.ok(fs.existsSync(path.join(REFUSE, name)), name)
  })

  test('one bad file stops the whole run: the good files are not written either', (t) => {
    const root = refuseRoot(t, 'enum.ts', { 'vendor/src/schema.ts': read(OK, 'schema.ts') })
    const r = build(root, ['--base-version', 'x'])
    assert.equal(r.status, 1)
    assert.equal(fs.existsSync(path.join(root, 'src')), false)
  })

  test('a refused run leaves earlier outputs byte for byte as they were', (t) => {
    const root = okRoot(t)
    assert.equal(build(root).status, 0)
    const before = snapshot(outDir(root))
    fs.writeFileSync(path.join(root, 'vendor', 'src', 'extra.ts'), read(REFUSE, 'decorator.ts'))
    const r = build(root)
    assert.equal(r.status, 1)
    assert.deepEqual(snapshot(outDir(root)), before)
  })

  test('refusal is reported for --check too', (t) => {
    const root = okRoot(t)
    assert.equal(build(root).status, 0)
    fs.writeFileSync(path.join(root, 'vendor', 'src', 'extra.ts'), read(REFUSE, 'enum.ts'))
    const r = build(root, ['--check'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /enum is not supported/)
  })

  test('the allow-list is replaced by the config "allow" key, and mapped specifiers are allowed', (t) => {
    const strict = makeRoot(t, {
      'vendor/src/index.ts': "import { join } from 'node:path'\nexport const j = join\n",
      'scripts/build.config.json': '{ "baseVersion": "x", "allow": [] }\n',
    })
    const refused = build(strict)
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /import specifier "node:path" is outside the allow-list/)
    const mapped = makeRoot(t, {
      'vendor/src/index.ts': "import x from 'left-pad'\nexport default x\n",
      'scripts/build.config.json': '{ "baseVersion": "x", "map": { "left-pad": "./pad-shim.js" } }\n',
    })
    const ok = build(mapped)
    assert.equal(ok.status, 0, ok.stderr)
    assert.equal(outText(mapped, 'index.js'), "import x from './pad-shim.js'\nexport default x\n")
  })

  test('a malformed config is refused', (t) => {
    for (const config of ['{ nope', '{ "baseVersion": "x", "extra": 1 }', '{ "baseVersion": "x", "map": { "a": 1 } }', '[]']) {
      const root = makeRoot(t, { 'vendor/src/index.ts': 'export const a = 1\n', 'scripts/build.config.json': config })
      const r = build(root)
      assert.equal(r.status, 2, config)
      assert.equal(fs.existsSync(path.join(root, 'src')), false)
    }
  })

  test('an unexpected entry in the source folder is refused', (t) => {
    const root = makeRoot(t, { 'vendor/src/index.ts': 'export const a = 1\n', 'vendor/src/notes.md': 'x\n' })
    const r = build(root, ['--base-version', 'x'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /unexpected entry in vendor\/src: notes\.md/)
  })
})

describe('paths stay inside the package directory', () => {
  const goodSource = { 'vendor/src/index.ts': 'export const a = 1\n' }

  test('a path with ".." is rejected for --src, --out and --config, and nothing is written', (t) => {
    const parent = makeRoot(t, { 'sibling/src/index.ts': 'export const a = 1\n' })
    const root = path.join(parent, 'pkg')
    fs.mkdirSync(path.join(root, 'vendor', 'src'), { recursive: true })
    fs.writeFileSync(path.join(root, 'vendor', 'src', 'index.ts'), 'export const a = 1\n')
    const before = snapshot(parent)
    for (const args of [
      ['--src', '../sibling/src'],
      ['--src', 'vendor/../vendor/src'],
      ['--out', '../escaped'],
      ['--out', 'src/../../escaped'],
      ['--config', '../cfg.json'],
    ]) {
      const r = build(root, ['--base-version', 'x', ...args])
      assert.equal(r.status, 2, args.join(' '))
      assert.match(r.stderr, /'\.\.'/)
    }
    assert.deepEqual(snapshot(parent), before)
  })

  test('an absolute path outside the package is rejected, one inside is accepted', (t) => {
    const outside = makeRoot(t, { 'src/index.ts': 'export const a = 1\n' })
    const root = makeRoot(t, goodSource)
    const before = snapshot(outside)
    for (const args of [['--src', path.join(outside, 'src')], ['--out', path.join(outside, 'out')], ['--config', path.join(outside, 'c.json')]]) {
      const r = build(root, ['--base-version', 'x', ...args])
      assert.equal(r.status, 2, args.join(' '))
      assert.match(r.stderr, /outside the package directory/)
    }
    assert.deepEqual(snapshot(outside), before)
    assert.equal(fs.existsSync(path.join(root, 'src')), false)
    assert.equal(build(root, ['--base-version', 'x', '--out', '.']).status, 2)
    const inside = build(root, ['--base-version', 'x', '--out', path.join(root, 'src', 'engine')])
    assert.equal(inside.status, 0, inside.stderr)
    assert.ok(fs.existsSync(path.join(root, 'src', 'engine', 'index.js')))
  })

  test('a symlink that leaves the package directory is rejected', (t) => {
    const outside = makeRoot(t)
    const root = makeRoot(t, goodSource)
    fs.symlinkSync(outside, path.join(root, 'src'))
    const r = build(root, ['--base-version', 'x'])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /through a symlink/)
    assert.deepEqual(fs.readdirSync(outside), [])
  })

  test('a symlinked source file is not followed', (t) => {
    const outside = makeRoot(t, { 'index.ts': 'export const a = 1\n' })
    const root = makeRoot(t)
    fs.mkdirSync(path.join(root, 'vendor', 'src'), { recursive: true })
    fs.symlinkSync(path.join(outside, 'index.ts'), path.join(root, 'vendor', 'src', 'index.ts'))
    const r = build(root, ['--base-version', 'x'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /unexpected entry/)
  })

  test('--root must be an existing directory', () => {
    const r = run(['--base-version', 'x'], path.join(os.tmpdir(), 'ssp-build-does-not-exist'))
    assert.equal(r.status, 2)
    assert.match(r.stderr, /--root is not a directory/)
  })

  test('resolveInside unit cases', (t) => {
    const root = makeRoot(t)
    assert.equal(resolveInside(root, 'a/b', 'x'), path.join(root, 'a', 'b'))
    assert.equal(resolveInside(root, path.join(root, 'a'), 'x'), path.join(root, 'a'))
    for (const bad of ['..', '../x', 'a/../b', 'a\\..\\b', '/etc/passwd', path.join(path.dirname(root), 'other'), '', 'a\0b']) {
      assert.throws(() => resolveInside(root, bad, 'x'), (e) => e.name === 'BuildError' && e.code === 2, JSON.stringify(bad))
    }
  })
})

describe('scanner units', () => {
  const specs = (code) => scanModuleSyntax(tokenize(code))
  const fields = (code) => findFieldsWithoutInitializer(tokenize(code)).map((f) => `${f.isStatic ? 'static ' : ''}${f.className}.${f.name}`)

  test('finds every specifier form and skips lookalikes', () => {
    const code = [
      "import a from 'one'",
      "import { b, c as d } from \"two\"",
      "import * as e from 'three'",
      "import 'four'",
      "export * from 'five'",
      "export * as f from 'six'",
      "export { g, h as i } from 'seven'",
      "export { j }",
      "const k = await import('eight')",
      "const l = require('nine')",
      "const m = { import: 1, require: 2 }; m.import(); obj.require('ten')",
      "const s = 'import x from \"no\"' + `a ${'b'} import('no')` + /import 'no'/.source // import 'no'",
      "/* import 'no' */ export const n = import.meta.url",
    ].join('\n')
    const r = specs(code)
    assert.deepEqual(r.problems, [])
    assert.deepEqual(r.specs.map((s) => `${s.kind}:${s.value}`), [
      'import:one', 'import:two', 'import:three', 'import:four', 'export-from:five', 'export-from:six', 'export-from:seven',
      'dynamic import:eight', 'require:nine',
    ])
  })

  test('reports decorators and non-literal dynamic import and require', () => {
    const r = specs('@dec class A {}\nimport(name)\nrequire(`x`)\nimport(\'ok\', { with: {} })')
    assert.equal(r.problems.length, 3)
    assert.match(r.problems[0], /^1:1: decorator/)
    assert.match(r.problems[1], /^2:1: dynamic import without a string literal/)
    assert.match(r.problems[2], /^3:1: require without a string literal/)
    assert.deepEqual(r.specs.map((s) => s.value), ['ok'])
  })

  test('refuses a specifier with an escape sequence', () => {
    const r = specs("import a from 'o\\u006ee'")
    assert.equal(r.specs.length, 0)
    assert.match(r.problems[0], /escape sequence/)
  })

  test('class fields: bare, optional markers gone, static, private, computed, ASI style', () => {
    assert.deepEqual(fields('class A {\n  a\n  b = 1\n  c;\n  static d\n  #e\n  [k]\n  f() {}\n  static g = 2\n  static { A.x = 1 }\n  get h() { return 1 }\n  async *i() {}\n  j\n}'), [
      'A.a', 'A.c', 'static A.d', 'A.#e', 'A.[computed]', 'A.j',
    ])
  })

  test('class fields: initializers with arrows, objects and calls do not leak into the next member', () => {
    assert.deepEqual(fields('class A {\n  a = () => {\n    return 1\n  }\n  b = { x: 1 }\n  c = fn(1, [2])\n  d\n  e = `t ${1} x`\n  f\n}'), ['A.d', 'A.f'])
  })

  test('class fields: nested classes, class expressions and extends expressions', () => {
    assert.deepEqual(fields('class A extends mix({ a: 1 }) {\n  p\n  m() {\n    return class B {\n      q\n    }\n  }\n}\nconst C = class {\n  r\n}\nconst o = { class: { z: 1 } }'), [
      'A.p', 'B.q', '(anonymous).r',
    ])
  })

  test('class fields: a keyword used as a field name and modifiers followed by a name', () => {
    assert.deepEqual(fields('class A {\n  static\n  get\n  static x\n  async\n  y() {}\n}'), ['A.static', 'A.get', 'static A.x', 'A.async'])
  })

  test('tokenizer: regex after an operator, division after a value, nested templates', () => {
    const toks = tokenize('const a = b / c / d\nconst r = x ? /a\\/b[/]/g : 1\nconst t = `a${`b${1}`}c`\nclass Q {\n  z\n}')
    assert.deepEqual(toks.filter((t) => t.t === 'regex').map((t) => t.v), ['/a\\/b[/]/g'])
    assert.equal(toks.filter((t) => t.t === 'tpl').length, 4)
    assert.deepEqual(findFieldsWithoutInitializer(toks).map((f) => f.name), ['z'])
  })

  test('tokenizer: unterminated input throws a located SyntaxError', () => {
    assert.throws(() => tokenize("const a = 'x"), /unterminated string at 1:/)
    assert.throws(() => tokenize('/* open'), /unterminated comment/)
    assert.throws(() => tokenize('const a = `open'), /unterminated template/)
  })
})
