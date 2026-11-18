// Decoy home folders for the tests of this package.
//
// HOME, DSH_HOME and the XDG roots of this test process point at empty folders
// under one mkdtemp folder (os.tmpdir()) while the tests run. The code under test
// must never write there; the last test of each file asserts that every decoy is
// still empty, then restore() puts the saved values back and removes the folders.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DECOY_KEYS = Object.freeze(['HOME', 'DSH_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'])

/**
 * @param {string} label short name used in the temp folder name
 * @returns {{ base: string, folders: Record<string, string>, touched(): string[], restore(): void }}
 */
export function installDecoys(label) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ssp-${label}-`)))
  const saved = {}
  const folders = {}
  for (const key of DECOY_KEYS) {
    saved[key] = process.env[key]
    folders[key] = path.join(base, `decoy-${key.toLowerCase().replace(/_/g, '-')}`)
    fs.mkdirSync(folders[key])
    process.env[key] = folders[key]
  }
  let restored = false
  return {
    base,
    folders,
    /** Every entry found in a decoy folder, as `KEY/name`; empty while nothing leaked. */
    touched() {
      const found = []
      for (const [key, dir] of Object.entries(folders)) {
        for (const name of fs.readdirSync(dir)) found.push(`${key}/${name}`)
      }
      return found
    },
    restore() {
      if (restored) return
      restored = true
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      fs.rmSync(base, { recursive: true, force: true })
    },
  }
}
