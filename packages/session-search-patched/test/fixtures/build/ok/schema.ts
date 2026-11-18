/** Fixture: schema module. Mentions of import 'nowhere' and require("nowhere") in comments are not specifiers. */

import type { DatabaseSync } from 'node:sqlite'
import { dirname, type ParsedPath } from 'node:path'

export type Mode = 'a' | 'b'
export interface Options<T = unknown> {
  mode?: Mode
  extra?: T
}

export const VERSION = 1 as const
export const NOT_A_SPECIFIER = "import x from 'left-pad'; @decorator class A {}"
export const TEMPLATE = `a ${dirname('/x/y')} import('also-nothing') ${`nested ${VERSION}`} @tag`
export const PATTERN = /import\s+['"]x['"]|@\w+/g

export function identity<T>(value: T): T {
  return value as T
}

export async function open(): Promise<DatabaseSync> {
  const { DatabaseSync } = await import('node:sqlite')
  return new DatabaseSync(':memory:')
}

export const parsed = (p: ParsedPath): string => p.base
