#!/usr/bin/env node
// Deterministic type-strip generator for the vendored engine sources.
//
//   node scripts/build.mjs            generate src/engine/{index,query,schema}.js and manifest.json
//   node scripts/build.mjs --check    regenerate in memory; exit non-zero on any difference
//
// Input:  vendor/src/*.ts            (TypeScript sources, strip-only syntax)
// Output: src/engine/*.js            (same text with type syntax replaced by whitespace)
//         src/engine/manifest.json   (sha256 of every input and output, script hash, Node version, base version)
//
// The only rewrites are:
//   1. type syntax -> whitespace (module.stripTypeScriptTypes, mode 'strip'); the line count never changes.
//      Node may write one ';' (an empty class element) where erasing a modifier needs it; each is listed,
//   2. relative `.ts` specifiers -> `.js`,
//   3. specifiers named in scripts/build.config.json "map" (an absent file means no mapping).
//
// Refused (non-zero exit, nothing written): a specifier outside the allow-list (import, export-from,
// dynamic import, require), a dynamic import or require without a string literal, enum, namespace with values,
// parameter property, decorator, and output that fails a syntax check.
//
// Config file (all keys optional): { "baseVersion": "0.2.2-rc.3", "allow": ["node:path", ...], "map": { "from": "to" } }
//   baseVersion: the upstream version the sources are based on; --base-version wins; --check falls back to the manifest.
//   allow: replaces the default allow-list. Relative specifiers must name another input file; keys of "map"
//          are implicitly allowed. Mapped targets are written as given and are not checked again.
//
// Path rules: every path is resolved inside the package directory (the parent of scripts/). A path with a
// '..' segment, or an absolute path outside that directory, is rejected. --root exists for the tests only.
//
// Limits: the scanner is a tokenizer, not a parser. A regex literal directly after ')' or '}' and the
// automatic-semicolon case of a class field whose initializer is followed by a line starting with '*' or '['
// are not recognised. Output text keeps U+FEFF where Node replaces an astral character inside erased type syntax.

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import nodeModule from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const DEFAULT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..')
const DEFAULTS = {
  src: 'vendor/src',
  out: 'src/engine',
  config: 'scripts/build.config.json',
}
const MANIFEST_NAME = 'manifest.json'
const MANIFEST_SCHEMA = 1

/** Bare specifiers accepted when the config has no "allow" key. */
export const DEFAULT_ALLOW = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-query',
  '@deepseek-ai/schemastery',
  'node:crypto',
  'node:fs/promises',
  'node:path',
  'node:sqlite',
]

/** Error carrying every reason a run was refused. */
export class BuildError extends Error {
  constructor(problems, code = 1) {
    super(problems.join('\n'))
    this.name = 'BuildError'
    this.problems = problems
    this.code = code
  }
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

// ---------------------------------------------------------------------------------------------
// Tokenizer: comments, strings, templates and regex literals are consumed; positions are 1-based.
// ---------------------------------------------------------------------------------------------

const REGEX_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
])
const ID_START = /[\p{ID_Start}$_]/u
const ID_PART = /[\p{ID_Continue}$\u200c\u200d]/u
const NUMBER = /0[xXbBoO][\da-fA-F_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?n?/y
const WHITESPACE = new Set([' ', '\t', '\r', '\v', '\f', '\u00a0', '\ufeff', '\u2028', '\u2029'])

/**
 * Split JavaScript text into tokens. Token kinds: id, priv (#name), num, str, tpl (template chunk),
 * regex, punct. `nl` tells whether a line break precedes the token; str tokens carry `esc` when the
 * literal contains a backslash.
 */
export function tokenize(src) {
  const toks = []
  const braces = [] // 'b' for a block or object brace, 't' for a template substitution
  let i = 0
  let line = 1
  let lineStart = 0
  let nl = false
  const n = src.length

  const fail = (message, at = i) => {
    throw new SyntaxError(`${message} at ${line}:${at - lineStart + 1}`)
  }
  const push = (t, v, s, e, extra) => {
    toks.push({ t, v, s, e, line, col: s - lineStart + 1, nl, ...extra })
    nl = false
  }
  const newline = (at) => {
    line += 1
    lineStart = at + 1
    nl = true
  }
  const scanTemplate = (from) => {
    // `from` is the index after the opening backtick or the closing brace of a substitution
    const startLine = line
    const startCol = from - lineStart
    let j = from
    while (j < n) {
      const c = src[j]
      if (c === '\\') {
        if (src[j + 1] === '\n') newline(j + 1)
        j += 2
        continue
      }
      if (c === '\n') {
        newline(j)
        j += 1
        continue
      }
      if (c === '`') {
        toks.push({ t: 'tpl', v: src.slice(from, j), s: from, e: j + 1, line: startLine, col: startCol, nl: false })
        return j + 1
      }
      if (c === '$' && src[j + 1] === '{') {
        toks.push({ t: 'tpl', v: src.slice(from, j), s: from, e: j + 2, line: startLine, col: startCol, nl: false })
        braces.push('t')
        return j + 2
      }
      j += 1
    }
    return fail('unterminated template literal', from)
  }
  const regexAllowed = () => {
    const prev = toks[toks.length - 1]
    if (!prev) return true
    if (prev.t === 'num' || prev.t === 'str' || prev.t === 'tpl' || prev.t === 'priv' || prev.t === 'regex') return false
    if (prev.t === 'id') return REGEX_AFTER_KEYWORD.has(prev.v)
    return !(prev.v === ')' || prev.v === ']' || prev.v === '}')
  }

  if (src.startsWith('#!')) {
    while (i < n && src[i] !== '\n') i += 1
  }
  while (i < n) {
    const c = src[i]
    if (c === '\n') {
      newline(i)
      i += 1
      continue
    }
    if (WHITESPACE.has(c)) {
      i += 1
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end < 0) fail('unterminated comment')
      for (let j = i + 2; j < end; j += 1) if (src[j] === '\n') newline(j)
      i = end + 2
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      let esc = false
      while (j < n && src[j] !== c) {
        if (src[j] === '\n') fail('unterminated string', j)
        if (src[j] === '\\') {
          esc = true
          if (src[j + 1] === '\n') newline(j + 1)
          j += 1
        }
        j += 1
      }
      if (j >= n) fail('unterminated string')
      push('str', src.slice(i + 1, j), i + 1, j, { esc, quote: c })
      i = j + 1
      continue
    }
    if (c === '`') {
      i = scanTemplate(i + 1)
      continue
    }
    if (c === '}' && braces[braces.length - 1] === 't') {
      braces.pop() // the close of a substitution is not a block close; the next template chunk replaces it
      i = scanTemplate(i + 1)
      continue
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1
      let inClass = false
      while (j < n) {
        const d = src[j]
        if (d === '\n') fail('unterminated regular expression', j)
        if (d === '\\') j += 1
        else if (d === '[') inClass = true
        else if (d === ']') inClass = false
        else if (d === '/' && !inClass) break
        j += 1
      }
      if (j >= n) fail('unterminated regular expression')
      j += 1
      while (j < n && ID_PART.test(src[j])) j += 1
      push('regex', src.slice(i, j), i, j)
      i = j
      continue
    }
    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      NUMBER.lastIndex = i
      const m = NUMBER.exec(src)
      const j = m ? i + m[0].length : i + 1
      push('num', src.slice(i, j), i, j)
      i = j
      continue
    }
    if (c === '#' && ID_START.test(src[i + 1] ?? '')) {
      let j = i + 2
      while (j < n && ID_PART.test(src[j])) j += 1
      push('priv', src.slice(i, j), i, j)
      i = j
      continue
    }
    if (ID_START.test(c)) {
      let j = i + 1
      while (j < n && ID_PART.test(src[j])) j += 1
      push('id', src.slice(i, j), i, j)
      i = j
      continue
    }
    if (c === '{') braces.push('b')
    else if (c === '}') braces.pop()
    push('punct', c, i, i + 1)
    i += 1
  }
  if (braces.length > 0) fail('unbalanced braces', n)
  return toks
}

// ---------------------------------------------------------------------------------------------
// Specifier scan
// ---------------------------------------------------------------------------------------------

const isPunct = (tok, v) => tok !== undefined && tok.t === 'punct' && tok.v === v
const isId = (tok, v) => tok !== undefined && tok.t === 'id' && tok.v === v

/**
 * Find every module specifier and every decorator in stripped JavaScript.
 * Returns { specs: [{kind, value, tok}], problems: [string] } (problems carry line:col).
 */
export function scanModuleSyntax(toks) {
  const specs = []
  const problems = []
  const at = (tok) => `${tok.line}:${tok.col}`
  const spec = (kind, tok) => {
    if (tok.esc) problems.push(`${at(tok)}: ${kind} specifier with an escape sequence is refused`)
    else specs.push({ kind, value: tok.v, tok })
  }
  for (let k = 0; k < toks.length; k += 1) {
    const tok = toks[k]
    const prev = toks[k - 1]
    const next = toks[k + 1]
    if (tok.t === 'punct' && tok.v === '@') {
      problems.push(`${at(tok)}: decorator is refused (strip mode cannot erase it)`)
      continue
    }
    if (tok.t !== 'id' || isPunct(prev, '.')) continue
    if (tok.v === 'import') {
      if (isPunct(next, '(')) {
        const arg = toks[k + 2]
        const after = toks[k + 3]
        if (arg !== undefined && arg.t === 'str' && (isPunct(after, ')') || isPunct(after, ','))) spec('dynamic import', arg)
        else problems.push(`${at(tok)}: dynamic import without a string literal specifier is refused`)
      } else if (isPunct(next, '.')) {
        // import.meta
      } else if (next !== undefined && next.t === 'str') {
        spec('import', next)
      } else if (next !== undefined && (next.t === 'id' || isPunct(next, '{') || isPunct(next, '*'))) {
        for (let j = k + 1; j < toks.length && !isPunct(toks[j], ';'); j += 1) {
          if (isId(toks[j], 'from') && toks[j + 1] !== undefined && toks[j + 1].t === 'str') {
            spec('import', toks[j + 1])
            break
          }
        }
      }
    } else if (tok.v === 'export') {
      if (isPunct(next, '{') || isPunct(next, '*')) {
        let j = k + 1
        if (isPunct(next, '{')) {
          while (j < toks.length && !isPunct(toks[j], '}')) j += 1
          j += 1
          if (isId(toks[j], 'from') && toks[j + 1] !== undefined && toks[j + 1].t === 'str') spec('export-from', toks[j + 1])
        } else {
          for (; j < toks.length && j < k + 8 && !isPunct(toks[j], ';'); j += 1) {
            if (isId(toks[j], 'from') && toks[j + 1] !== undefined && toks[j + 1].t === 'str') {
              spec('export-from', toks[j + 1])
              break
            }
          }
        }
      }
    } else if (tok.v === 'require' && isPunct(next, '(')) {
      const arg = toks[k + 2]
      if (arg !== undefined && arg.t === 'str' && isPunct(toks[k + 3], ')')) spec('require', arg)
      else problems.push(`${at(tok)}: require without a string literal specifier is refused`)
    }
  }
  return { specs, problems }
}

// ---------------------------------------------------------------------------------------------
// Class fields without initializer
// ---------------------------------------------------------------------------------------------

const OPEN = new Set(['{', '(', '['])
const CLOSE = new Set(['}', ')', ']'])
const NOT_MEMBER_START = new Set(['in', 'instanceof', 'of', 'as', 'satisfies'])
const memberName = (tok) => (tok.t === 'str' ? `${tok.quote}${tok.v}${tok.quote}` : tok.v)

/**
 * Report class fields that have no initializer in stripped JavaScript. Such a field still exists in the
 * output and is defined as `undefined` on every instance, so it can overwrite a value a base class set.
 * Returns [{ line, col, className, name, isStatic }] in source order. Fields erased by strip (`declare`,
 * abstract, index signatures) are not in the output and are not reported.
 */
export function findFieldsWithoutInitializer(toks) {
  const found = []
  const stack = []
  let pending = null
  const top = () => stack[stack.length - 1]
  const report = (fr) => {
    if (fr.cur) {
      found.push({ line: fr.cur.line, col: fr.cur.col, className: fr.name ?? '(anonymous)', name: fr.cur.name, isStatic: fr.isStatic })
    }
    fr.cur = null
  }
  const beginMember = (fr, tok) => {
    fr.cur = { name: memberName(tok), line: tok.line, col: tok.col }
    fr.isStatic = false
    fr.st = 'name'
  }
  const endsExpression = (tok) =>
    tok !== undefined && (['id', 'num', 'str', 'tpl', 'priv', 'regex'].includes(tok.t) || isPunct(tok, ')') || isPunct(tok, ']') || isPunct(tok, '}'))
  const member = (fr, tok, prev) => {
    const named = tok.t === 'id' || tok.t === 'str' || tok.t === 'num' || tok.t === 'priv'
    switch (fr.st) {
      case 'start':
        if (named) beginMember(fr, tok)
        break
      case 'name':
        if (isPunct(tok, '(')) fr.st = 'method'
        else if (isPunct(tok, '=')) fr.st = 'init'
        else if (isPunct(tok, ';')) {
          report(fr)
          fr.st = 'start'
        } else if (isPunct(tok, '*')) fr.st = 'start'
        else if (isPunct(tok, '{')) fr.st = 'method' // static block
        else if (named) {
          if (tok.nl) {
            report(fr)
            beginMember(fr, tok)
          } else {
            const wasStatic = fr.cur.name === 'static'
            fr.cur = { name: memberName(tok), line: tok.line, col: tok.col }
            if (wasStatic) fr.isStatic = true
          }
        }
        break
      case 'init':
        if (isPunct(tok, ';')) fr.st = 'start'
        else if (tok.nl && named && !(tok.t === 'id' && NOT_MEMBER_START.has(tok.v)) && endsExpression(prev)) {
          fr.st = 'start'
          member(fr, tok, prev)
        }
        break
      default: // 'method': wait for the closing brace of the body
        break
    }
  }

  for (let k = 0; k < toks.length; k += 1) {
    const tok = toks[k]
    const prev = toks[k - 1]
    const next = toks[k + 1]
    if (tok.t === 'id' && tok.v === 'class' && !isPunct(prev, '.') && next !== undefined && (next.t === 'id' || isPunct(next, '{'))) {
      pending = { depth: stack.length, name: null, extended: false }
      continue
    }
    if (pending !== null && stack.length === pending.depth && tok.t === 'id' && !pending.extended) {
      if (tok.v === 'extends') pending.extended = true
      else if (pending.name === null) pending.name = tok.v
      continue
    }
    if (tok.t === 'punct' && OPEN.has(tok.v)) {
      if (pending !== null && stack.length === pending.depth && tok.v === '{') {
        stack.push({ kind: 'class', name: pending.name, st: 'start', cur: null, isStatic: false })
        pending = null
        continue
      }
      const fr = top()
      const inClass = fr !== undefined && fr.kind === 'class'
      if (inClass) member(fr, tok, prev)
      const frame = { kind: tok.v === '{' ? 'brace' : tok.v === '(' ? 'paren' : 'bracket', computedKey: false }
      if (inClass && tok.v === '[' && (fr.st === 'start' || fr.st === 'name') && !(fr.st === 'name' && !tok.nl && fr.cur === null)) {
        frame.computedKey = true
        frame.line = tok.line
        frame.col = tok.col
        if (fr.st === 'name' && tok.nl) report(fr)
      }
      stack.push(frame)
      continue
    }
    if (tok.t === 'punct' && CLOSE.has(tok.v)) {
      const closed = stack.pop()
      if (closed === undefined) continue
      if (closed.kind === 'class') {
        if (closed.st === 'name') report(closed)
        continue
      }
      const fr = top()
      if (fr !== undefined && fr.kind === 'class') {
        if (closed.computedKey) {
          const wasStatic = fr.cur !== null && fr.cur.name === 'static'
          fr.cur = { name: '[computed]', line: closed.line, col: closed.col }
          fr.isStatic = wasStatic || fr.isStatic
          fr.st = 'name'
        } else if (closed.kind === 'brace' && fr.st === 'method') {
          fr.st = 'start'
          fr.cur = null
        }
      }
      continue
    }
    const fr = top()
    if (fr !== undefined && fr.kind === 'class') member(fr, tok, prev)
  }
  return found
}

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

const toPosix = (p) => p.split(path.sep).join('/')
const isInside = (base, target) => {
  const rel = path.relative(base, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Resolve `rel` inside `root` or throw. Rejects '..' segments, outside absolute paths and escaping symlinks. */
export function resolveInside(root, rel, label) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0')) {
    throw new BuildError([`${label}: path must be a non-empty string`], 2)
  }
  if (rel.split(/[\\/]+/).includes('..')) {
    throw new BuildError([`${label}: path with '..' is rejected: ${rel}`], 2)
  }
  const abs = path.resolve(root, rel)
  if (!isInside(root, abs)) {
    throw new BuildError([`${label}: path is outside the package directory: ${rel}`], 2)
  }
  const realRoot = fs.realpathSync(root)
  let probe = abs
  while (!fs.existsSync(probe)) probe = path.dirname(probe)
  if (!isInside(realRoot, fs.realpathSync(probe))) {
    throw new BuildError([`${label}: path leaves the package directory through a symlink: ${rel}`], 2)
  }
  return abs
}

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

function loadConfig(file) {
  if (!fs.existsSync(file)) return { present: false, text: null, allow: DEFAULT_ALLOW, map: {}, baseVersion: undefined }
  const text = fs.readFileSync(file)
  let data
  try {
    data = JSON.parse(text.toString('utf8'))
  } catch (error) {
    throw new BuildError([`config is not valid JSON: ${error.message}`], 2)
  }
  const problems = []
  if (data === null || typeof data !== 'object' || Array.isArray(data)) problems.push('config must be a JSON object')
  else {
    for (const key of Object.keys(data)) {
      if (!['allow', 'map', 'baseVersion'].includes(key)) problems.push(`config: unknown key "${key}"`)
    }
    if (data.allow !== undefined && !(Array.isArray(data.allow) && data.allow.every((s) => typeof s === 'string'))) {
      problems.push('config: "allow" must be an array of strings')
    }
    if (data.map !== undefined) {
      const ok = data.map !== null && typeof data.map === 'object' && !Array.isArray(data.map)
      if (!ok || Object.values(data.map).some((v) => typeof v !== 'string' || v === '')) {
        problems.push('config: "map" must be an object of non-empty strings')
      }
    }
    if (data.baseVersion !== undefined && (typeof data.baseVersion !== 'string' || data.baseVersion === '')) {
      problems.push('config: "baseVersion" must be a non-empty string')
    }
  }
  if (problems.length > 0) throw new BuildError(problems, 2)
  return {
    present: true,
    text,
    allow: data.allow ?? DEFAULT_ALLOW,
    map: data.map ?? {},
    baseVersion: data.baseVersion,
  }
}

// ---------------------------------------------------------------------------------------------
// Generation (pure: reads inputs, returns every output; writes nothing)
// ---------------------------------------------------------------------------------------------

function syntaxCheck(code) {
  const child = spawnSync(process.execPath, ['--check', '--input-type=module', '-'], {
    input: code,
    encoding: 'utf8',
    env: {},
    maxBuffer: 16 * 1024 * 1024,
  })
  if (child.error) return `syntax check could not run: ${child.error.message}`
  if (child.status === 0) return null
  const lines = child.stderr.split('\n').filter((l) => l.trim() !== '')
  const detail = lines.find((l) => /Error/.test(l)) ?? lines[0] ?? `exit ${child.status}`
  return `output fails the syntax check: ${detail.trim()}`
}

function readInputs(srcDir, srcRel) {
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    throw new BuildError([`source folder not found: ${srcRel}`])
  }
  const names = []
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) {
      throw new BuildError([`unexpected entry in ${srcRel}: ${entry.name} (only plain .ts files are accepted)`])
    }
    names.push(entry.name)
  }
  names.sort()
  if (names.length === 0) throw new BuildError([`no .ts files in ${srcRel}`])
  return names.map((name) => ({ name, rel: `${srcRel}/${name}`, bytes: fs.readFileSync(path.join(srcDir, name)) }))
}

/**
 * Generate every output in memory.
 * @returns {{ files: Map<string, string>, manifest: object, fields: string[] }} files maps output path
 *   (relative to root, '/' separators) to text; the manifest is also in `files`.
 */
export function generate({ root, srcRel, outRel, configRel, baseVersionFlag, fallbackBaseVersion, nodeVersion = process.version }) {
  const srcDir = resolveInside(root, srcRel, '--src')
  resolveInside(root, outRel, '--out')
  const configPath = resolveInside(root, configRel, '--config')
  const config = loadConfig(configPath)
  const baseVersion = baseVersionFlag ?? config.baseVersion ?? fallbackBaseVersion
  if (baseVersion === undefined) {
    throw new BuildError(['base version is missing: set "baseVersion" in the config or pass --base-version'], 2)
  }
  if (typeof nodeModule.stripTypeScriptTypes !== 'function') {
    throw new BuildError([`this Node (${process.version}) has no module.stripTypeScriptTypes; use Node 24`], 2)
  }

  const inputs = readInputs(srcDir, srcRel)
  const inputNames = new Set(inputs.map((f) => f.name))
  const allowed = new Set([...config.allow, ...Object.keys(config.map)])
  const problems = []
  const files = new Map()
  const fields = []
  const semicolons = []

  for (const input of inputs) {
    const label = input.rel
    const source = input.bytes.toString('utf8')
    let stripped
    try {
      stripped = nodeModule.stripTypeScriptTypes(source, { mode: 'strip' })
    } catch (error) {
      problems.push(`${label}: ${String(error.message).split('\n')[0]}`)
      continue
    }
    if (stripped.length !== source.length || stripped.split('\n').length !== source.split('\n').length) {
      problems.push(`${label}: strip changed the text length or line count (refused)`)
      continue
    }
    // Node writes the erased text as spaces (U+FEFF for the second half of an astral character) and, where
    // erasing a modifier could change how the next class element parses, a single ';' (an empty class element).
    let drift = -1
    for (let i = 0; i < source.length; i += 1) {
      const out = stripped[i]
      if (out === source[i] || out === ' ' || out === '\ufeff') continue
      if (out === ';' && source[i] !== '\n') {
        const before = source.slice(0, i).split('\n')
        semicolons.push(`${outRel}/${input.name.replace(/\.ts$/, '.js')}:${before.length}:${before[before.length - 1].length + 1}`)
        continue
      }
      drift = i
      break
    }
    if (drift >= 0) {
      problems.push(`${label}: strip changed a character other than to whitespace or ';' at offset ${drift} (refused)`)
      continue
    }

    let toks
    try {
      toks = tokenize(stripped)
    } catch (error) {
      problems.push(`${label}: ${error.message}`)
      continue
    }
    const problemsBefore = problems.length
    const { specs, problems: scanProblems } = scanModuleSyntax(toks)
    for (const p of scanProblems) problems.push(`${label}:${p}`)

    const edits = []
    for (const s of specs) {
      const where = `${label}:${s.tok.line}:${s.tok.col}`
      const value = s.value
      if (Object.hasOwn(config.map, value)) {
        edits.push({ s: s.tok.s, e: s.tok.e, text: config.map[value] })
      } else if (value.startsWith('.')) {
        const m = /^\.\/([^/]+)\.(ts|js)$/.exec(value)
        if (m !== null && inputNames.has(`${m[1]}.ts`)) {
          if (m[2] === 'ts') edits.push({ s: s.tok.s, e: s.tok.e, text: `./${m[1]}.js` })
        } else {
          problems.push(`${where}: relative ${s.kind} specifier "${value}" does not name another input file (refused)`)
        }
      } else if (!allowed.has(value)) {
        problems.push(`${where}: ${s.kind} specifier "${value}" is outside the allow-list (refused)`)
      }
    }
    let text = stripped
    for (const edit of edits.sort((a, b) => b.s - a.s)) text = text.slice(0, edit.s) + edit.text + text.slice(edit.e)
    if (text.split('\n').length !== source.split('\n').length) {
      problems.push(`${label}: a rewrite changed the line count (refused)`)
      continue
    }

    const outName = input.name.replace(/\.ts$/, '.js')
    const outRelPath = `${outRel}/${outName}`
    for (const f of findFieldsWithoutInitializer(toks)) {
      fields.push(`${outRelPath}:${f.line}:${f.col} ${f.isStatic ? 'static ' : ''}${f.className}.${f.name}`)
    }
    const failure = problems.length === problemsBefore ? syntaxCheck(text) : null
    if (failure !== null) {
      problems.push(`${label}: ${failure}`)
      continue
    }
    files.set(outRelPath, text)
  }
  if (problems.length > 0) throw new BuildError(problems)

  const manifest = {
    schema: MANIFEST_SCHEMA,
    baseVersion,
    node: { major: Number(nodeVersion.replace(/^v/, '').split('.')[0]), version: nodeVersion },
    script: { path: toPosix(path.relative(DEFAULT_ROOT, SCRIPT_PATH)), sha256: sha256(fs.readFileSync(SCRIPT_PATH)) },
    config: { path: configRel, sha256: config.text === null ? null : sha256(config.text) },
    inputs: Object.fromEntries(inputs.map((f) => [f.rel, sha256(f.bytes)])),
    outputs: Object.fromEntries([...files.entries()].map(([p, text]) => [p, sha256(text)])),
    classFieldsWithoutInitializer: fields,
    semicolonsInsertedByStrip: semicolons,
  }
  files.set(`${outRel}/${MANIFEST_NAME}`, `${JSON.stringify(manifest, null, 2)}\n`)
  return { files, manifest, fields, semicolons }
}

function listFiles(dir, prefix, acc = []) {
  if (!fs.existsSync(dir)) return acc
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`
    if (entry.isDirectory()) listFiles(path.join(dir, entry.name), rel, acc)
    else acc.push(rel)
  }
  return acc.sort()
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

export function runBuild(opts) {
  const { root, outRel } = opts
  const { files, fields, semicolons } = generate(opts)
  const outDir = resolveInside(root, outRel, '--out')
  const extra = listFiles(outDir, outRel).filter((f) => !files.has(f))
  if (extra.length > 0) {
    throw new BuildError([...extra.map((f) => `extra file in the output folder (remove it): ${f}`)])
  }
  fs.mkdirSync(outDir, { recursive: true })
  for (const [rel, text] of files) fs.writeFileSync(path.join(root, ...rel.split('/')), text)
  return { files, fields, semicolons }
}

export function runCheck(opts) {
  const { root, outRel } = opts
  const outDir = resolveInside(root, outRel, '--out')
  const manifestRel = `${outRel}/${MANIFEST_NAME}`
  const manifestPath = path.join(root, ...manifestRel.split('/'))
  let nodeVersion = process.version
  let fallbackBaseVersion
  if (fs.existsSync(manifestPath)) {
    let existing = null
    try {
      existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch {
      existing = null
    }
    const recorded = existing?.node
    if (recorded && typeof recorded.major === 'number') {
      const major = Number(process.version.replace(/^v/, '').split('.')[0])
      if (recorded.major !== major) {
        throw new BuildError([`cannot check: the manifest was generated with Node ${recorded.major}, this is Node ${major}`], 3)
      }
      nodeVersion = recorded.version
    }
    if (typeof existing?.baseVersion === 'string') fallbackBaseVersion = existing.baseVersion
  }
  const { files } = generate({ ...opts, nodeVersion, fallbackBaseVersion })
  const problems = []
  for (const [rel, text] of files) {
    const file = path.join(root, ...rel.split('/'))
    if (!fs.existsSync(file)) problems.push(`missing file: ${rel}`)
    else if (Buffer.compare(fs.readFileSync(file), Buffer.from(text, 'utf8')) !== 0) problems.push(`differs from regenerated output: ${rel}`)
  }
  for (const rel of listFiles(outDir, outRel)) if (!files.has(rel)) problems.push(`extra file: ${rel}`)
  if (problems.length > 0) throw new BuildError(problems)
  return { files }
}

const USAGE = `usage: node scripts/build.mjs [--check] [--src <dir>] [--out <dir>] [--config <file>] [--base-version <v>] [--root <dir>]
  defaults: --src ${DEFAULTS.src} --out ${DEFAULTS.out} --config ${DEFAULTS.config}
  --root is for tests: the package directory (default: the parent of scripts/)`

function parseArgs(argv) {
  const opts = { check: false, root: DEFAULT_ROOT, srcRel: DEFAULTS.src, outRel: DEFAULTS.out, configRel: DEFAULTS.config, baseVersionFlag: undefined }
  const valued = { '--src': 'srcRel', '--out': 'outRel', '--config': 'configRel', '--base-version': 'baseVersionFlag', '--root': 'root' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--check') opts.check = true
    else if (arg === '--help' || arg === '-h') throw new BuildError([USAGE], 0)
    else if (Object.hasOwn(valued, arg)) {
      i += 1
      if (i >= argv.length) throw new BuildError([`${arg} needs a value`, USAGE], 2)
      opts[valued[arg]] = argv[i]
    } else throw new BuildError([`unknown argument: ${arg}`, USAGE], 2)
  }
  const root = path.resolve(opts.root)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new BuildError([`--root is not a directory: ${opts.root}`], 2)
  opts.root = root
  // From here on every folder option is a '/'-separated path relative to the root, never empty.
  for (const [key, flag] of [['srcRel', '--src'], ['outRel', '--out'], ['configRel', '--config']]) {
    const rel = toPosix(path.relative(root, resolveInside(root, opts[key], flag)))
    if (rel === '') throw new BuildError([`${flag}: must name a path below the package directory, not the directory itself`], 2)
    opts[key] = rel
  }
  return opts
}

export function main(argv) {
  try {
    const opts = parseArgs(argv)
    if (opts.check) {
      runCheck(opts)
      console.log(`ok: ${opts.outRel} matches a fresh generation`)
    } else {
      const { files, fields, semicolons } = runBuild(opts)
      for (const [rel, text] of files) console.log(`wrote ${rel} (sha256 ${sha256(text).slice(0, 16)}...)`)
      console.log(`class fields without initializer (${fields.length}):`)
      for (const f of fields) console.log(`  ${f}`)
      console.log(`semicolons inserted by strip (${semicolons.length}):`)
      for (const f of semicolons) console.log(`  ${f}`)
    }
    return 0
  } catch (error) {
    if (!(error instanceof BuildError)) throw error
    const stream = error.code === 0 ? process.stdout : process.stderr
    stream.write(`${error.problems.join('\n')}\n`)
    return error.code
  }
}

const invoked = process.argv[1] !== undefined && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(SCRIPT_PATH)
if (invoked) process.exitCode = main(process.argv.slice(2))
