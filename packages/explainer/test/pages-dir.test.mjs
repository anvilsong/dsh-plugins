import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { MAX_PATH_LENGTH, PAGES_FOLDER, resolvePagesDir } from '../src/pages-dir.js'

// Decoy strings only: the resolver reads no file system, so nothing here names
// a directory that exists.
const HOME = '/decoy-home'
const win = (config, home) => resolvePagesDir(config, { home, platform: 'win32' })

test('the folder name is explainer', () => {
  assert.equal(PAGES_FOLDER, 'explainer')
})

test('without dataDir the folder is <home>/explainer', () => {
  assert.equal(resolvePagesDir({}, { home: HOME }), '/decoy-home/explainer')
  assert.equal(resolvePagesDir(undefined, { home: HOME }), '/decoy-home/explainer')
  assert.equal(resolvePagesDir(null, { home: HOME }), '/decoy-home/explainer')
  assert.equal(resolvePagesDir('text', { home: HOME }), '/decoy-home/explainer')
  assert.equal(resolvePagesDir([], { home: HOME }), '/decoy-home/explainer')
  assert.equal(resolvePagesDir({}, { home: '/decoy-home/' }), '/decoy-home/explainer')
  assert.equal(resolvePagesDir({ dataDir: undefined }, { home: HOME }), '/decoy-home/explainer')
})

test('a set dataDir wins over the home, and is not joined with anything', () => {
  assert.equal(resolvePagesDir({ dataDir: '/decoy-data/pages' }, { home: HOME }), '/decoy-data/pages')
  assert.equal(resolvePagesDir({ dataDir: '/decoy-data/pages/' }, { home: HOME }), '/decoy-data/pages')
  assert.equal(resolvePagesDir({ dataDir: '/decoy-data/my pages' }, { home: HOME }), '/decoy-data/my pages')
})

test('a set dataDir needs no home, and an unusable home does not matter', () => {
  assert.equal(resolvePagesDir({ dataDir: '/decoy-data/pages' }), '/decoy-data/pages')
  assert.equal(resolvePagesDir({ dataDir: '/decoy-data/pages' }, {}), '/decoy-data/pages')
  assert.equal(resolvePagesDir({ dataDir: '/decoy-data/pages' }, { home: '/decoy/../home' }), '/decoy-data/pages')
  assert.equal(resolvePagesDir({ dataDir: '/decoy-data/pages' }, { home: 5 }), '/decoy-data/pages')
})

// Every rule of the shared path check, one value each.
const INVALID_PATHS = {
  'an empty string': '',
  'a number': 7,
  'null': null,
  'an object': {},
  'a boolean': false,
  'a relative path': 'relative/pages',
  'a dot-relative path': './pages',
  'a home shortcut': '~/pages',
  'a bare home shortcut': '~',
  '.. segments': '/decoy/../pages',
  'a trailing ..': '/decoy/pages/..',
  'a . segment': '/decoy/./pages',
  'a doubled separator': '/decoy//pages',
  'a leading space': ' /decoy/pages',
  'a trailing space': '/decoy/pages ',
  'a trailing newline': '/decoy/pages\n',
  'a newline': '/decoy/pa\nges',
  'a NUL': '/decoy/pa\u0000ges',
  'a C0 control': '/decoy/pa\u001bges',
  'a DEL': '/decoy/pa\u007fges',
  'a C1 control': '/decoy/pa\u0085ges',
  'a right-to-left override': '/decoy/\u202epages',
  'a left-to-right mark': '/decoy/\u200epages',
  'an isolate': '/decoy/\u2066pages',
  'an Arabic letter mark': '/decoy/\u061cpages',
  'a line separator': '/decoy/pa\u2028ges',
  'a paragraph separator': '/decoy/pa\u2029ges',
  'a backtick': '/decoy/pa`ges',
  'a zero-width space': '/decoy/pa\u200bges',
  'a zero-width joiner': '/decoy/pa\u200dges',
  'a word joiner': '/decoy/pa\u2060ges',
  'a byte order mark': '/decoy/pa\ufeffges',
  'a soft hyphen': '/decoy/pa\u00adges',
  'a tag character': '/decoy/pa\u{e0041}ges',
  'a tag cancel character': '/decoy/pa\u{e007f}ges',
  'more than 512 characters': `/${'a'.repeat(512)}`,
  'the filesystem root': '/',
  'a drive letter on this platform': 'C:\\decoy\\pages',
}

test('an invalid dataDir throws, one rule at a time, and never falls back to the home', () => {
  for (const [label, dataDir] of Object.entries(INVALID_PATHS)) {
    assert.throws(() => resolvePagesDir({ dataDir }, { home: HOME }), { message: /^dataDir / }, label)
  }
})

test('an invalid home throws when it is needed, one rule at a time', () => {
  for (const [label, home] of Object.entries(INVALID_PATHS)) {
    // A non-string or relative home is "no home" (undefined), not an error.
    if (typeof home !== 'string' || !home.startsWith('/')) {
      assert.equal(resolvePagesDir({}, { home }), undefined, label)
      continue
    }
    assert.throws(() => resolvePagesDir({}, { home }), { message: /^The DSH home .*\(needed for the default folder\)$/ }, label)
  }
})

test('the home is checked before explainer is joined: .. and doubled separators are not hidden', () => {
  assert.throws(() => resolvePagesDir({}, { home: '/decoy/../home' }), /\.\./)
  assert.throws(() => resolvePagesDir({}, { home: '/decoy/home/..' }), /\.\./)
  assert.throws(() => resolvePagesDir({}, { home: '/decoy//home' }), /normalized/)
  assert.throws(() => resolvePagesDir({}, { home: '/' }), /root/)
})

test('no usable home and no dataDir gives undefined, not a throw', () => {
  assert.equal(resolvePagesDir({}, { home: undefined }), undefined)
  assert.equal(resolvePagesDir({}, {}), undefined)
  assert.equal(resolvePagesDir({}), undefined)
  assert.equal(resolvePagesDir(), undefined)
  assert.equal(resolvePagesDir({}, { home: null }), undefined)
  assert.equal(resolvePagesDir({}, { home: 12 }), undefined)
  assert.equal(resolvePagesDir({}, { home: '' }), undefined)
  assert.equal(resolvePagesDir({}, { home: 'relative-home' }), undefined)
  assert.equal(resolvePagesDir({}, { home: '~' }), undefined)
  assert.equal(resolvePagesDir({}, { home: './home' }), undefined)
})

test('the process environment and the real home are never consulted', (t) => {
  const real = process.env.HOME
  t.after(() => { process.env.HOME = real })
  process.env.HOME = '/decoy-env-home'
  assert.equal(resolvePagesDir({}, {}), undefined)
  assert.equal(resolvePagesDir({}), undefined)
  assert.equal(resolvePagesDir({}, { home: HOME }), '/decoy-home/explainer')
})

test('the resolver imports no file system, os or environment access and names no fixed folder but its own', () => {
  const source = readFileSync(new URL('../src/pages-dir.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /node:fs|node:os|process\.env|homedir|explainers|from 'fs'|from 'os'/)
  assert.match(source, /^import path from 'node:path'$/m)
  assert.equal(source.match(/^import /gm).length, 1)
})

test('on the win32 flavor a drive, a UNC share and either separator are accepted', () => {
  assert.equal(win({ dataDir: 'C:\\Decoy\\pages' }), 'C:\\Decoy\\pages')
  assert.equal(win({ dataDir: 'C:\\Decoy\\pages\\' }), 'C:\\Decoy\\pages')
  assert.equal(win({ dataDir: 'C:/Decoy/pages' }), 'C:\\Decoy\\pages')
  assert.equal(win({ dataDir: '\\\\server\\share\\pages' }), '\\\\server\\share\\pages')
  assert.equal(win({}, 'C:\\Decoy\\home'), 'C:\\Decoy\\home\\explainer')
  assert.equal(win({}, 'C:/Decoy/home'), 'C:\\Decoy\\home\\explainer')
})

test('on the win32 flavor the same rules reject a root, a drive-relative path, .. and a POSIX path', () => {
  for (const dataDir of ['C:\\', '\\decoy\\pages', '/decoy/pages', 'decoy\\pages', 'C:\\decoy\\..\\pages', 'C:\\decoy\\..', 'C:\\decoy\\pa\nges', 'C:\\decoy\\pa`ges', 'C:\\decoy\\\\pages', '~\\pages']) {
    assert.throws(() => win({ dataDir }), { message: /^dataDir / }, dataDir)
  }
  assert.throws(() => win({}, 'C:\\decoy\\..\\home'), /\.\./)
})

test('on the win32 flavor a POSIX home counts as no home or an invalid one, never a default', () => {
  // '/decoy-home' is rooted on win32 but not drive-absolute: the check refuses it.
  assert.throws(() => win({}, '/decoy-home'), /drive|absolute/)
  assert.equal(win({}, 'decoy-home'), undefined)
})

test('the flavor follows options.platform and defaults to the running platform', () => {
  assert.equal(resolvePagesDir({ dataDir: '/decoy-data/pages' }, { platform: 'linux' }), '/decoy-data/pages')
  assert.equal(resolvePagesDir({ dataDir: '/decoy-data/pages' }, { platform: 'darwin' }), '/decoy-data/pages')
  assert.throws(() => resolvePagesDir({ dataDir: 'C:\\decoy' }, { platform: 'linux' }), /absolute/)
  const here = resolvePagesDir({ dataDir: process.platform === 'win32' ? 'C:\\Decoy\\pages' : '/decoy-data/pages' })
  assert.equal(typeof here, 'string')
})

test('the length cap is 512 characters of the resolved path: 512 passes, 513 throws', () => {
  const at = `/${'a'.repeat(511)}`
  assert.equal(at.length, 512)
  assert.equal(resolvePagesDir({ dataDir: at }, {}), at)
  assert.throws(() => resolvePagesDir({ dataDir: `${at}a` }, {}), { message: /^dataDir .*512 characters/ })
  assert.equal(MAX_PATH_LENGTH, 512)
  // A trailing separator is dropped before the count.
  assert.equal(resolvePagesDir({ dataDir: `${at}/` }, {}), at)
})

test('the cap counts the default folder too: <home>/explainer', () => {
  const room = 512 - '/explainer'.length
  const fits = `/${'h'.repeat(room - 1)}`
  assert.equal(fits.length, room)
  assert.equal(resolvePagesDir({}, { home: fits }).length, 512)
  assert.throws(() => resolvePagesDir({}, { home: `${fits}h` }), /512 characters/)
})

test('each invisible format character is named by the rule, not just refused by chance', () => {
  for (const ch of ['\u200b', '\u200c', '\u200d', '\u2060', '\ufeff', '\u00ad', '\u{e0041}', '\u{e0001}']) {
    assert.throws(() => resolvePagesDir({ dataDir: `/decoy/a${ch}b` }, {}), /control, format|invisible|format/, JSON.stringify(ch))
    assert.throws(() => resolvePagesDir({}, { home: `/decoy/a${ch}b` }), /format/, JSON.stringify(ch))
  }
})

test('a dataDir equal to the home is refused after normalization; a subfolder or an unrelated folder is not', () => {
  const refused = /the pages folder must be a subfolder, not the home itself/
  assert.throws(() => resolvePagesDir({ dataDir: '/decoy-home' }, { home: '/decoy-home' }), refused)
  assert.throws(() => resolvePagesDir({ dataDir: '/decoy-home/' }, { home: '/decoy-home' }), refused)
  assert.throws(() => resolvePagesDir({ dataDir: '/decoy-home' }, { home: '/decoy-home/' }), refused)
  assert.equal(resolvePagesDir({ dataDir: '/decoy-home/pages' }, { home: '/decoy-home' }), '/decoy-home/pages')
  assert.equal(resolvePagesDir({ dataDir: '/decoy-home2' }, { home: '/decoy-home' }), '/decoy-home2')
  assert.equal(resolvePagesDir({ dataDir: '/decoy-home' }, { home: '/other-home' }), '/decoy-home')
  assert.equal(resolvePagesDir({ dataDir: '/decoy-home' }, {}), '/decoy-home', 'no home: nothing to compare with')
  assert.equal(resolvePagesDir({ dataDir: '/decoy-home' }, { home: 'relative' }), '/decoy-home')
  // A home that fails the rules is still compared, best effort, and never repaired.
  assert.equal(resolvePagesDir({ dataDir: '/decoy-home' }, { home: '/decoy-home/../x' }), '/decoy-home')
})

test('on the win32 flavor the home comparison ignores case and the separator style', () => {
  const refused = /not the home itself/
  assert.throws(() => win({ dataDir: 'C:\\Decoy\\Home' }, 'c:/decoy/home/'), refused)
  assert.throws(() => win({ dataDir: 'C:/Decoy/Home' }, 'C:\\Decoy\\Home'), refused)
  assert.equal(win({ dataDir: 'C:\\Decoy\\Home\\pages' }, 'C:\\Decoy\\Home'), 'C:\\Decoy\\Home\\pages')
})
