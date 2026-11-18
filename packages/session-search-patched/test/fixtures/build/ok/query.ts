/** Fixture: query module. */

import SessionQueryEngine, { type QueryOptions, SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { identity, type Mode, VERSION } from './schema.ts'
import type Unlisted from 'left-pad'

export { type Mode, VERSION } from './schema.ts'
export * from './schema.js'

export const marker = { kind: 'query' } satisfies Record<string, string>
export const asNumber = (value: unknown) => value as number
export const generic = <T,>(value: T) => identity<T>(value)
export type Unused = Unlisted | QueryOptions

export function fail(message: string): never {
  throw new SessionQueryError(message)
}

export default SessionQueryEngine
export const mode: Mode = 'a'
export const version = VERSION
