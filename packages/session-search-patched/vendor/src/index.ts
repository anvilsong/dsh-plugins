/**
 * Concrete session-query service with SQLite FTS5 over the live-preferred corpus.
 *
 * @module @deepseek-ai/dsh-session-query-sqlite
 */

import { createHash, randomUUID } from 'node:crypto'
import { SESSION_FORMAT_VERSION, SessionSeq } from '@deepseek-ai/dsh-session'
import type { DatabaseSync } from 'node:sqlite'
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionPersistenceRevision,
  SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import SessionQueryEngine, {
  SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
  SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  SESSION_QUERY_READ_WINDOW_MAX,
  SessionQueryError,
  SessionSearchCursor,
  assertSessionHeadersCompatible,
  buildSessionEventSearchDocuments,
  readColdSessionLog,
} from '@deepseek-ai/dsh-session-query'
import type {
  Config as SessionQueryConfig,
  SessionEventSearchDocument,
  SessionEventSearchHit,
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchCursor as SessionSearchCursorValue,
  SessionSearchPage,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import {
  type JournalMode,
  openSearchDatabase,
} from './schema.ts'
import {
  type NormalizedEventRequest,
  type NormalizedSessionRequest,
  FTS_HIGHLIGHT_END,
  FTS_HIGHLIGHT_START,
  assertFts5OuterPredicateCount,
  assertPortableBindingCount,
  buildEventWhere,
  buildSessionWhere,
  makeSnippet,
  normalizeEventRequest,
  normalizeSessionRequest,
  quoteFtsData,
  requestFingerprint,
  sanitizeFtsText,
  SQLITE_MAX_PAGE_LIMIT,
} from './query.ts'

export {
  SESSION_QUERY_SQLITE_APPLICATION_ID,
  SESSION_QUERY_SQLITE_SCHEMA_VERSION,
  type JournalMode,
} from './schema.ts'

/** Boot-context slot for a launcher-owned absolute path to this process's derived query index. */
export const SESSION_QUERY_SQLITE_PATH_KEY = 'launcherSessionQueryPath'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Launcher-owned absolute path to this process's disposable derived query index. */
    launcherSessionQueryPath?: string
  }
}

/** Default result page size. */
export const SESSION_QUERY_SQLITE_DEFAULT_LIMIT = 20
/** Maximum accepted result page size. */
export const SESSION_QUERY_SQLITE_MAX_LIMIT = 100
/** Default maximum snippet length in Unicode code points. */
export const SESSION_QUERY_SQLITE_SNIPPET_CHARS = 240

// One transient source change gets a retry; repeated churn fails rather than monopolizing the queue.
const STABLE_OBSERVATION_ATTEMPTS = 2

/** SQLite module/handle opening phase; `never` disables full-text search entirely. */
export type OpenAt = 'startup' | 'first-search' | 'never'

/** Combined session-query configuration backed by SQLite full-text search. */
export interface Config extends SessionQueryConfig {
  /**
   * Dedicated derived-index path; `:memory:` is supported for ephemeral
   * indexes. Missing directories and database files are created owner-only on
   * POSIX filesystems; existing modes are preserved.
   */
  path: string
  /**
   * Open the SQLite module and handle at service activation or the first
   * search, or `never` to disable full-text search: the inherited exact
   * reads, filters, and traces stay available, while `searchSessions` and
   * `searchEvents` fail with `SESSION_QUERY_SEARCH_DISABLED` and SQLite is
   * never imported or opened. Defaults to `startup`.
   */
  openAt?: OpenAt
  /** SQLite journal mode. Defaults to `wal`. */
  journalMode?: JournalMode
  /** Page size when a request omits `limit`. At most `Number.MAX_SAFE_INTEGER - 1`; defaults to 20. */
  defaultLimit?: number
  /** Largest accepted page size. At most `Number.MAX_SAFE_INTEGER - 1`; defaults to 100. */
  maxLimit?: number
  /** Maximum snippet length in Unicode code points. Defaults to 240. */
  snippetChars?: number
  /** Maximum concurrent persisted-log reads in one inherited batch read. Defaults to 4. */
  persistedReadConcurrency?: number
  /** Maximum cold prepared-Session observations the inherited reader retains for reuse. Defaults to 5. */
  preparedSessionCacheSize?: number
}

interface ResolvedConfig {
  path: string
  openAt: OpenAt
  journalMode: JournalMode
  defaultLimit: number
  maxLimit: number
  snippetChars: number
  readWindowMax: number
  persistedReadConcurrency: number
  preparedSessionCacheSize: number
}

interface ObservedSession {
  header: SessionHeader
  inheritedEventCount: SessionLogOffset
  documents: SessionEventSearchDocument[]
}

interface ObservedLiveSession extends ObservedSession {
  fingerprint: string
}

/** One listed persisted session; its log is read, indexed, and committed without being retained here. */
interface ObservedPersistedSession {
  header: SessionHeader
  revision: SessionPersistenceRevision
}

interface PersistenceBinding {
  readonly identity: symbol
  readonly service?: SessionPersistence
}

interface Observation {
  persistenceBinding: PersistenceBinding
  persisted: Map<SessionId, ObservedPersistedSession>
  live: Map<SessionId, ObservedLiveSession>
}

interface IndexedPersistedRow {
  id: string
  revision: string
  generation: number
}

interface IndexedLiveRow {
  id: string
  fingerprint: string
  persisted: number
  generation: number
}

interface SessionHeaderRow {
  session_id: string
  version: number
  created_at: number
  cwd: string | null
  parent_session: string | null
  seed_length: number | null
  delegation_depth: number | null
  agent_preset: string | null
}

interface SearchRow extends SessionHeaderRow {
  live: number
  persisted: number
  seq: number
  type: string
  time: number
  surface: string
  marked_text: string
  match_count: number
  document_length: number
}

interface CursorPayload {
  version: 1
  instance: string
  scope: 'sessions' | 'events'
  fingerprint: string
  generation: string
  offset: number
}

/** Concrete SQLite owner of the combined `ctx.sessionQuery` service. */
export class SqliteSessionQueryEngine extends SessionQueryEngine {
  static override inject = ['sessions']

  static Config: z<Config> = z.object({
    path: z.string().required(),
    openAt: z.union(['startup', 'first-search', 'never'] as const).default('startup'),
    journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
    defaultLimit: z.number().step(1).min(1).max(SQLITE_MAX_PAGE_LIMIT).default(SESSION_QUERY_SQLITE_DEFAULT_LIMIT),
    maxLimit: z.number().step(1).min(1).max(SQLITE_MAX_PAGE_LIMIT).default(SESSION_QUERY_SQLITE_MAX_LIMIT),
    snippetChars: z.number().step(1).min(1).default(SESSION_QUERY_SQLITE_SNIPPET_CHARS),
    readWindowMax: z.number().step(1).min(0).default(SESSION_QUERY_READ_WINDOW_MAX),
    persistedReadConcurrency: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY),
    preparedSessionCacheSize: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE),
  })

  /** Validated and defaulted backend configuration. */
  readonly config: ResolvedConfig

  private readonly _instance = randomUUID()
  private _ready: Promise<void> | undefined
  private _db: DatabaseSync | undefined
  private _persistenceBinding: PersistenceBinding = { identity: Symbol() }
  private _lastPersistenceIdentity: symbol | undefined
  // Only this binding may reuse `persisted_sessions` rows by revision. It is
  // undefined until this connection's first commit or completed pass, so
  // revisions written by an earlier connection stay reusable.
  private _persistedRowsBinding: symbol | undefined
  private _persistenceEpoch = 0
  private _globalGeneration = 0
  private _localGeneration = 0
  private _tail: Promise<void> = Promise.resolve()
  private _closed = false
  private _closePromise: Promise<void> | undefined
  private readonly _optionalPersistenceFiber: Fiber

  constructor(ctx: Context, config: Config) {
    // The assignment expression resolves before the base constructor can
    // register `ctx.sessionQuery`; keep that same validated value afterward.
    super(ctx, config = resolveConfig(config))
    this.config = config as ResolvedConfig
    this._optionalPersistenceFiber = ctx.inject(['sessionPersistence'], (childCtx: Context) => {
      const service = childCtx.sessionPersistence
      const binding = { identity: Symbol(), service }
      this._persistenceBinding = binding
      childCtx.effect(() => () => {
        /* v8 ignore next -- a stale optional-service disposer cannot clear a replacement */
        if (this._persistenceBinding !== binding) return
        this._persistenceBinding = { identity: Symbol() }
      }, 'sessionQuerySqlite.persistenceBinding')
    })
    ctx.effect(() => {
      return () => this._optionalPersistenceFiber.dispose()
    }, 'sessionQuerySqlite.optionalPersistence')
    ctx.effect(() => async () => this.close(), 'sessionQuerySqlite.close')
  }

  /** Open eagerly only when activation owns the configured readiness boundary. */
  protected async [Service.init](): Promise<void> {
    if (this.config.openAt === 'startup') await this._ensureReady(undefined)
  }

  override async searchSessions(
    request: SessionSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    this._assertSearchEnabled()
    const normalized = normalizeSessionRequest(request, this.config)
    const signal = exec?.signal
    return this._serialized(signal, async () => {
      await this._ensureReady(signal)
      const persistenceBinding = await this._reconcile(signal)
      assertNotAborted(signal)
      const generation = String(this._globalGeneration)
      const fingerprint = requestFingerprint(normalized)
      const offset = normalized.cursor === undefined
        ? 0
        : decodeCursor(normalized.cursor, this._instance, 'sessions', fingerprint, generation)
      const rows = this._querySessions(normalized, offset, persistenceBinding)
      return page(rows, normalized.limit, row => this._sessionHit(row), cursorOffset => encodeCursor({
        version: 1,
        instance: this._instance,
        scope: 'sessions',
        fingerprint,
        generation,
        offset: cursorOffset,
      }), offset)
    })
  }

  override async searchEvents(
    request: SessionEventSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    this._assertSearchEnabled()
    const normalized = normalizeEventRequest(request, this.config)
    const signal = exec?.signal
    return this._serialized(signal, async () => {
      await this._ensureReady(signal)
      const persistenceBinding = await this._reconcile(signal)
      assertNotAborted(signal)
      const target = this._targetObservation(normalized.sessionId, persistenceBinding)
      const fingerprint = requestFingerprint(normalized)
      const offset = normalized.cursor === undefined
        ? 0
        : decodeCursor(normalized.cursor, this._instance, 'events', fingerprint, target.generation)
      const rows = this._queryEvents(normalized, offset, persistenceBinding)
      return {
        session: target.header,
        ...page(rows, normalized.limit, row => this._eventHit(row), cursorOffset => encodeCursor({
          version: 1,
          instance: this._instance,
          scope: 'events',
          fingerprint,
          generation: target.generation,
          offset: cursorOffset,
        }), offset),
      }
    })
  }

  /** Close the database after every accepted operation reaches quiescence. */
  close(): Promise<void> {
    this._closePromise ??= this._close()
    return this._closePromise
  }

  /**
   * Refuse full-text calls under `openAt: 'never'` before any request
   * normalization or SQLite work, so a disabled deployment never imports
   * node:sqlite, opens the index, or observes sources.
   */
  private _assertSearchEnabled(): void {
    if (this.config.openAt !== 'never') return
    throw new SessionQueryError(
      'session search is disabled: this deployment configures the session-query index with openAt "never"',
      'SESSION_QUERY_SEARCH_DISABLED',
    )
  }

  private async _close(): Promise<void> {
    this._closed = true
    await this._tail
    if (this._ready !== undefined) {
      try {
        await this._ready
      } catch {
        // Opening already closed a partially-created handle; disposal only waits.
      }
    }
    this._db?.close()
    this._db = undefined
  }

  private async _open(): Promise<void> {
    this._db = await openSearchDatabase(this.config.path, this.config.journalMode)
    const state = this._db.prepare(
      'SELECT global_generation FROM search_state WHERE singleton = 1',
    ).get() as { global_generation: number }
    this._globalGeneration = state.global_generation
    this._localGeneration = state.global_generation
  }

  private async _ensureReady(signal: AbortSignal | undefined): Promise<void> {
    this._ready ??= this._open()
    try {
      await waitWithAbort(this._ready, signal)
    } catch (error: unknown) {
      if (isAbort(error)) throw error
      throw new SessionQueryError(
        `session-search SQLite index failed to open: ${errorMessage(error)}`,
        'SESSION_QUERY_INDEX_FAILED',
        { cause: error },
      )
    }
  }

  private async _serialized<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    if (this._isClosed()) throw indexClosed()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const prior = this._tail
    this._tail = prior.then(() => gate)
    try {
      await waitWithAbort(prior, signal)
    } catch (error: unknown) {
      release()
      throw error
    }
    if (this._isClosed()) {
      release()
      throw indexClosed()
    }
    try {
      assertNotAborted(signal)
      return await operation()
    } finally {
      release()
    }
  }

  /**
   * Bring the index to one stable source observation before a query runs.
   * Persisted sessions commit one at a time during {@link _observeStable}; after
   * it returns, one final transaction deletes the rows of persisted sessions that
   * are no longer listed, or every row another binding issued, and applies every
   * live TEMP-table change. A failure keeps the sessions already committed, and
   * the next search resumes from them.
   * @param signal - optional cancellation, checked between asynchronous steps.
   * @returns the persistence binding whose rows the query may expose.
   * @throws SessionQueryError with the failures of {@link _observeStable}, or
   *   `SESSION_QUERY_INDEX_FAILED` after the final transaction rolls back.
   */
  private async _reconcile(signal: AbortSignal | undefined): Promise<PersistenceBinding> {
    assertNotAborted(signal)
    const observation = await this._observeStable(signal)
    assertNotAborted(signal)
    const { persistenceBinding } = observation
    const db = this._requireDb()
    const liveRows = db.prepare(
      'SELECT id, fingerprint, persisted, generation FROM temp.live_sessions',
    ).all() as unknown as IndexedLiveRow[]
    const liveById = new Map(liveRows.map(row => [row.id as SessionId, row]))
    const foreignRows = !this._persistedRowsReusable(persistenceBinding)
    const persistentDeletes = persistenceBinding.service === undefined
      ? []
      : this._indexedPersistedRows().filter(row => foreignRows || !observation.persisted.has(row.id as SessionId))
    const liveChanges = [...observation.live.values()].filter((entry) => {
      const indexed = liveById.get(entry.header.id)
      const persisted = observation.persisted.has(entry.header.id) ? 1 : 0
      return indexed?.fingerprint !== entry.fingerprint || indexed.persisted !== persisted
    })
    const liveDeletes = liveRows.filter(row => !observation.live.has(row.id as SessionId))
    const pointerChanged = this._lastPersistenceIdentity !== undefined
      && this._lastPersistenceIdentity !== persistenceBinding.identity
    const hasWrites = persistentDeletes.length > 0
      || liveChanges.length > 0
      || liveDeletes.length > 0

    let nextMainGeneration = this._mainGeneration()
    let nextLocalGeneration = this._localGeneration
    if (persistentDeletes.length > 0) nextMainGeneration += 1
    const liveReplacements = liveChanges.map((entry) => {
      nextLocalGeneration = Math.max(nextLocalGeneration, nextMainGeneration) + 1
      return {
        entry,
        generation: nextLocalGeneration,
        persisted: observation.persisted.has(entry.header.id),
      }
    })

    if (hasWrites) {
      this._writeTransaction('session-search reconciliation failed', () => {
        for (const row of persistentDeletes) this._deleteSession('persisted', row.id as SessionId)
        if (persistentDeletes.length > 0) this._setMainGeneration(nextMainGeneration)
        for (const row of liveDeletes) this._deleteSession('live', row.id as SessionId)
        for (const { entry, generation, persisted } of liveReplacements) {
          this._replaceLiveSession(entry, generation, persisted)
        }
      })
    }

    if (hasWrites || pointerChanged) this._globalGeneration += 1
    if (pointerChanged) this._persistenceEpoch += 1
    this._localGeneration = nextLocalGeneration
    this._lastPersistenceIdentity = persistenceBinding.identity
    this._persistedRowsBinding = persistenceBinding.identity
    return persistenceBinding
  }

  /**
   * Observe sources until one attempt sees matching before and after listings
   * under an unchanged persistence binding and an unchanged set of live
   * sessions; at most {@link STABLE_OBSERVATION_ATTEMPTS} attempts run. Each
   * attempt re-reads the indexed revisions, then reads, indexes, and commits
   * each listed session whose revision differs and that has no live owner, one
   * session at a time through {@link _indexPersistedSession}, so indexing
   * keeps no decoded log of its own after a commit; the persistence backend
   * may still memoize recent logs. An attempt stops reading once the
   * persistence binding changes. A committed row carries the revision listed
   * before its read, so a retry re-reads only the revisions that moved. Live
   * sessions are observed here and written by {@link _reconcile}.
   * @param signal - optional cancellation, checked between asynchronous steps.
   * @returns the stable attempt's binding, listing, and live observations.
   * @throws SessionQueryError `SESSION_QUERY_ABORTED` on cancellation;
   *   `SESSION_QUERY_PERSISTENCE_FAILED` on a source failure or when no attempt
   *   is stable; `SESSION_QUERY_INDEX_FAILED` when a session transaction rolls
   *   back; typed source errors such as `SESSION_QUERY_SOURCE_CONFLICT` as thrown.
   */
  private async _observeStable(signal: AbortSignal | undefined): Promise<Observation> {
    for (let attempt = 0; attempt < STABLE_OBSERVATION_ATTEMPTS; attempt += 1) {
      assertNotAborted(signal)
      const persistenceBinding = this._persistenceBinding
      const persistence = persistenceBinding.service
      const initiallyLive = new Set(this.ctx.sessions.list().map(session => session.id))
      let persisted = new Map<SessionId, ObservedPersistedSession>()
      if (persistence !== undefined) {
        const indexed = new Map<SessionId, string>()
        if (this._persistedRowsReusable(persistenceBinding)) {
          for (const row of this._indexedPersistedRows()) indexed.set(row.id as SessionId, row.revision)
        }
        try {
          const listOptions = signal === undefined ? undefined : { signal }
          const before = await persistence.list(listOptions)
          assertNotAborted(signal)
          persisted = materializePersistenceSnapshots(before)
          for (const entry of persisted.values()) {
            if (indexed.get(entry.header.id) === entry.revision) continue
            // Skip work already shadowed by a live owner. The cold read is
            // non-mutating (interrupted turns are balanced in memory only), so
            // an owner attaching after this check cannot cause side effects;
            // the live-membership retry below makes the returned observation
            // live-preferred.
            if (initiallyLive.has(entry.header.id) || this.ctx.sessions.get(entry.header.id) !== undefined) continue
            // A replaced service voids this attempt; the binding check after the second listing retries it.
            if (this._persistenceBinding !== persistenceBinding) break
            assertNotAborted(signal)
            await this._indexPersistedSession(persistence, entry, persistenceBinding, signal)
          }
          assertNotAborted(signal)
          const afterSnapshots = await persistence.list(listOptions)
          assertNotAborted(signal)
          const after = materializePersistenceSnapshots(afterSnapshots)
          if (!samePersistenceSnapshots(persisted, after)) continue
          if (this._persistenceBinding !== persistenceBinding) continue
        } catch (error: unknown) {
          if (isIndexFailure(error)) throw error
          if (isAbort(error) || signal?.aborted) {
            throw new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED', {
              cause: error,
            })
          }
          if (this._persistenceBinding !== persistenceBinding) continue
          if (error instanceof SessionQueryError) throw error
          throw new SessionQueryError(
            `session-search persistence observation failed: ${errorMessage(error)}`,
            'SESSION_QUERY_PERSISTENCE_FAILED',
            { cause: error },
          )
        }
      }
      const live = new Map<SessionId, ObservedLiveSession>()
      for (const session of this.ctx.sessions.list()) {
        const observed = observeLive(session)
        const durable = persisted.get(session.id)
        if (durable !== undefined) assertSessionHeadersCompatible(observed.header, durable.header)
        live.set(session.id, observed)
      }
      if (!sameSessionIds(initiallyLive, live)) continue
      return { persistenceBinding, persisted, live }
    }
    throw new SessionQueryError(
      'session-search persistence observation did not stabilize after one retry',
      'SESSION_QUERY_PERSISTENCE_FAILED',
    )
  }

  /**
   * Read one listed session's complete log, check its header against the
   * listing, and commit its documents. The decoded log lives only in this
   * call's frame, so it is unreachable before the caller awaits the next read.
   * @param persistence - the service of `binding`.
   * @param entry - the listed session and the revision listed before the read.
   * @param binding - the binding the observation attempt runs under.
   * @param signal - optional cancellation, checked after the read.
   * @throws the read's failure unmapped; SessionQueryError `SESSION_QUERY_ABORTED`
   *   after cancellation, `SESSION_QUERY_SOURCE_CONFLICT` for a conflicting
   *   header, or the failures of {@link _commitPersistedSession}.
   */
  private async _indexPersistedSession(
    persistence: SessionPersistence,
    entry: ObservedPersistedSession,
    binding: PersistenceBinding,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const loaded = await readColdSessionLog(persistence, entry.header.id, signal)
    assertNotAborted(signal)
    assertSessionHeadersCompatible(entry.header, loaded.header)
    this._commitPersistedSession(
      observeSession(loaded.header, loaded.inheritedEventCount, loaded.events),
      entry.revision,
      binding,
    )
  }

  /**
   * Replace one persisted session's rows in its own transaction at generation
   * `search_state.global_generation + 1`, which the same transaction records in
   * `search_state`. A commit under a binding that may not reuse the existing
   * rows deletes all of them in that transaction. The in-memory cross-session
   * generation advances after every COMMIT, so cursors issued before it are
   * stale even when the surrounding pass later fails.
   * @param observed - documents of the complete stored log.
   * @param revision - the revision listed before the log was read.
   * @param binding - the binding whose service supplied the log.
   * @throws SessionQueryError `SESSION_QUERY_INDEX_FAILED` after rolling back only this session's transaction.
   */
  private _commitPersistedSession(
    observed: ObservedSession,
    revision: SessionPersistenceRevision,
    binding: PersistenceBinding,
  ): void {
    const db = this._requireDb()
    const replacesForeignRows = !this._persistedRowsReusable(binding)
    this._writeTransaction(`session-search reconciliation failed for session "${observed.header.id}"`, () => {
      if (replacesForeignRows) {
        db.exec('DELETE FROM persisted_docs')
        db.exec('DELETE FROM persisted_sessions')
      }
      const generation = this._mainGeneration() + 1
      this._replacePersistedSession(observed, revision, generation)
      this._setMainGeneration(generation)
    })
    this._persistedRowsBinding = binding.identity
    this._globalGeneration += 1
  }

  /**
   * Run synchronous index writes in one `BEGIN IMMEDIATE` transaction.
   * @param failure - diagnostic prefix that names the failed write.
   * @param write - statements that commit together; it must not await.
   * @throws SessionQueryError `SESSION_QUERY_INDEX_FAILED` after rolling back every statement of `write`.
   */
  private _writeTransaction(failure: string, write: () => void): void {
    const db = this._requireDb()
    let began = false
    try {
      db.exec('BEGIN IMMEDIATE')
      began = true
      write()
      db.exec('COMMIT')
    } catch (error: unknown) {
      if (began) {
        /* v8 ignore next 5 -- ROLLBACK failure requires a SQLite double fault; the original failure remains actionable. */
        try {
          db.exec('ROLLBACK')
        } catch {
          // The original SQLite failure remains the actionable cause.
        }
      }
      throw new SessionQueryError(
        `${failure}: ${errorMessage(error)}`,
        'SESSION_QUERY_INDEX_FAILED',
        { cause: error },
      )
    }
  }

  private _persistedRowsReusable(binding: PersistenceBinding): boolean {
    return this._persistedRowsBinding === undefined || this._persistedRowsBinding === binding.identity
  }

  private _indexedPersistedRows(): IndexedPersistedRow[] {
    const db = this._requireDb()
    return db.prepare(
      'SELECT id, revision, generation FROM persisted_sessions',
    ).all() as unknown as IndexedPersistedRow[]
  }

  private _mainGeneration(): number {
    const row = this._requireDb().prepare(
      'SELECT global_generation FROM search_state WHERE singleton = 1',
    ).get() as { global_generation: number }
    return row.global_generation
  }

  private _setMainGeneration(generation: number): void {
    this._requireDb().prepare('UPDATE search_state SET global_generation = ? WHERE singleton = 1').run(generation)
  }

  private _deleteSession(source: 'persisted' | 'live', id: SessionId): void {
    const db = this._requireDb()
    if (source === 'persisted') {
      db.prepare('DELETE FROM persisted_docs WHERE session_id = ?').run(id)
      db.prepare('DELETE FROM persisted_sessions WHERE id = ?').run(id)
    } else {
      db.prepare('DELETE FROM temp.live_docs WHERE session_id = ?').run(id)
      db.prepare('DELETE FROM temp.live_sessions WHERE id = ?').run(id)
    }
  }

  private _replacePersistedSession(
    entry: ObservedSession,
    revision: SessionPersistenceRevision,
    generation: number,
  ): void {
    this._deleteSession('persisted', entry.header.id)
    const db = this._requireDb()
    db.prepare(`
      INSERT INTO persisted_sessions
        (id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, revision, generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ...headerBindings(entry.header, entry.inheritedEventCount),
      revision,
      generation,
    )
    const insert = db.prepare(`
      INSERT INTO persisted_docs (text, session_id, seq, type, time, surface, codepoint_length)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const document of entry.documents) {
      const text = sanitizeFtsText(document.text)
      insert.run(
        text,
        document.sessionId,
        document.seq,
        document.type,
        document.time,
        document.surface,
        Array.from(text).length,
      )
    }
  }

  private _replaceLiveSession(entry: ObservedLiveSession, generation: number, persisted: boolean): void {
    this._deleteSession('live', entry.header.id)
    const db = this._requireDb()
    db.prepare(`
      INSERT INTO temp.live_sessions
        (id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, fingerprint, persisted, generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ...headerBindings(entry.header, entry.inheritedEventCount),
      entry.fingerprint,
      persisted ? 1 : 0,
      generation,
    )
    const insert = db.prepare(`
      INSERT INTO temp.live_docs (text, session_id, seq, type, time, surface, codepoint_length)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const document of entry.documents) {
      const text = sanitizeFtsText(document.text)
      insert.run(
        text,
        document.sessionId,
        document.seq,
        document.type,
        document.time,
        document.surface,
        Array.from(text).length,
      )
    }
  }

  private _querySessions(
    request: NormalizedSessionRequest,
    offset: number,
    persistenceBinding: PersistenceBinding,
  ): SearchRow[] {
    const selected = selectedDocumentsSql()
    const sessionWhere = buildSessionWhere(request.sessionFilters)
    const eventWhere = buildEventWhere(request.eventFilters)
    assertFts5OuterPredicateCount(sessionWhere.predicateCount + eventWhere.predicateCount)
    const where = [sessionWhere.sql, eventWhere.sql].filter(Boolean).join(' AND ')
    const bindings = [
      ...selectedDocumentsParams(request.query, persistenceBinding.service !== undefined),
      ...sessionWhere.params,
      ...eventWhere.params,
      request.limit + 1,
      offset,
    ]
    assertPortableBindingCount(bindings.length)
    return this._requireDb().prepare(`
      ${selected.sql},
      filtered AS (
        SELECT * FROM matched ${where.length === 0 ? '' : `WHERE ${where}`}
      ),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY session_id
          ORDER BY match_count DESC, document_length ASC, time DESC, seq DESC
        ) AS event_rank
        FROM filtered
      )
      SELECT * FROM ranked
      WHERE event_rank = 1
      ORDER BY match_count DESC, document_length ASC, time DESC, session_id ASC, seq DESC
      LIMIT ? OFFSET ?
    `).all(...bindings) as unknown as SearchRow[]
  }

  private _queryEvents(
    request: NormalizedEventRequest,
    offset: number,
    persistenceBinding: PersistenceBinding,
  ): SearchRow[] {
    const selected = selectedDocumentsSql()
    const eventWhere = buildEventWhere(request.filters)
    assertFts5OuterPredicateCount(1 + eventWhere.predicateCount)
    const where = ['session_id = ?', eventWhere.sql].filter(Boolean).join(' AND ')
    const bindings = [
      ...selectedDocumentsParams(request.query, persistenceBinding.service !== undefined),
      request.sessionId,
      ...eventWhere.params,
      request.limit + 1,
      offset,
    ]
    assertPortableBindingCount(bindings.length)
    return this._requireDb().prepare(`
      ${selected.sql}
      SELECT * FROM matched
      WHERE ${where}
      ORDER BY match_count DESC, document_length ASC, time DESC, seq DESC
      LIMIT ? OFFSET ?
    `).all(...bindings) as unknown as SearchRow[]
  }

  private _targetObservation(
    sessionId: SessionId,
    persistenceBinding: PersistenceBinding,
  ): { header: SessionHeader; generation: string } {
    const db = this._requireDb()
    const live = db.prepare(
      `SELECT
        id AS session_id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, generation
      FROM temp.live_sessions
      WHERE id = ?`,
    ).get(sessionId) as (SessionHeaderRow & { generation: number }) | undefined
    if (live !== undefined) {
      return { header: rowHeader(live), generation: `live:${live.generation}` }
    }
    if (persistenceBinding.service !== undefined) {
      const persisted = db.prepare(
        `SELECT
          id AS session_id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, generation
        FROM persisted_sessions
        WHERE id = ?`,
      ).get(sessionId) as (SessionHeaderRow & { generation: number }) | undefined
      if (persisted !== undefined) {
        return {
          header: rowHeader(persisted),
          generation: `persisted:${this._persistenceEpoch}:${persisted.generation}`,
        }
      }
    }
    throw new SessionQueryError(
      `session "${sessionId}" not found`,
      'SESSION_QUERY_SESSION_NOT_FOUND',
    )
  }

  private _sessionHit(row: SearchRow): SessionSearchHit {
    return {
      header: rowHeader(row),
      live: row.live === 1,
      persisted: row.persisted === 1,
      bestMatch: this._eventHit(row),
    }
  }

  private _eventHit(row: SearchRow): SessionEventSearchHit {
    return {
      sessionId: row.session_id as SessionId,
      seq: SessionSeq(row.seq),
      type: row.type as SessionEventSearchHit['type'],
      time: row.time,
      surface: row.surface as SessionEventSearchHit['surface'],
      snippet: makeSnippet(row.marked_text, this.config.snippetChars),
    }
  }

  private _requireDb(): DatabaseSync {
    /* v8 ignore next -- callers await `_ready`; this guards lifecycle misuse */
    if (this._db === undefined) throw indexClosed()
    return this._db
  }

  private _isClosed(): boolean {
    return this._closed
  }
}

/**
 * The header columns both session upserts bind, in the order their INSERT
 * lists them. The two statements differ only in what they append after these.
 * @param header - the session header being written.
 * @returns one bound value per header column.
 */
function headerBindings(
  header: SessionHeader,
  inheritedEventCount: SessionLogOffset,
): (string | number | null)[] {
  return [
    header.id,
    header.version,
    header.createdAt,
    header.cwd ?? null,
    header.parentSession ?? null,
    header.isSeeded ? inheritedEventCount : null,
    header.delegationDepth ?? null,
    header.agentPreset ?? null,
  ]
}

function selectedDocumentsSql(): { sql: string } {
  return {
    sql: `WITH candidates AS (
      SELECT
        pd.session_id AS session_id,
        ps.version AS version,
        ps.created_at AS created_at,
        ps.cwd AS cwd,
        ps.parent_session AS parent_session,
        ps.seed_length AS seed_length,
        ps.delegation_depth AS delegation_depth,
        ps.agent_preset AS agent_preset,
        0 AS live,
        1 AS persisted,
        CAST(pd.seq AS INTEGER) AS seq,
        pd.type AS type,
        CAST(pd.time AS INTEGER) AS time,
        pd.surface AS surface,
        highlight(persisted_docs, 0, ?, ?) AS marked_text,
        CAST(pd.codepoint_length AS INTEGER) AS document_length
      FROM persisted_docs AS pd
      JOIN persisted_sessions AS ps ON ps.id = pd.session_id
      WHERE persisted_docs MATCH ?
        AND ? = 1
        AND NOT EXISTS (SELECT 1 FROM temp.live_sessions AS ls WHERE ls.id = pd.session_id)
      UNION ALL
      SELECT
        ld.session_id AS session_id,
        ls.version AS version,
        ls.created_at AS created_at,
        ls.cwd AS cwd,
        ls.parent_session AS parent_session,
        ls.seed_length AS seed_length,
        ls.delegation_depth AS delegation_depth,
        ls.agent_preset AS agent_preset,
        1 AS live,
        CASE WHEN ? = 1 THEN ls.persisted ELSE 0 END AS persisted,
        CAST(ld.seq AS INTEGER) AS seq,
        ld.type AS type,
        CAST(ld.time AS INTEGER) AS time,
        ld.surface AS surface,
        highlight(live_docs, 0, ?, ?) AS marked_text,
        CAST(ld.codepoint_length AS INTEGER) AS document_length
      FROM temp.live_docs AS ld
      JOIN temp.live_sessions AS ls ON ls.id = ld.session_id
      WHERE live_docs MATCH ?
    ), matched AS (
      SELECT *,
        (
          length(CAST(marked_text AS BLOB))
          - length(CAST(replace(marked_text, ?, '') AS BLOB))
        ) / ? AS match_count
      FROM candidates
    )`,
  }
}

function selectedDocumentsParams(query: string, persistenceVisible: boolean): Array<string | number> {
  const expression = quoteFtsData(query)
  const visible = persistenceVisible ? 1 : 0
  return [
    FTS_HIGHLIGHT_START,
    FTS_HIGHLIGHT_END,
    expression,
    visible,
    visible,
    FTS_HIGHLIGHT_START,
    FTS_HIGHLIGHT_END,
    expression,
    FTS_HIGHLIGHT_START,
    Buffer.byteLength(FTS_HIGHLIGHT_START, 'utf8'),
  ]
}

function observeLive(session: Session): ObservedLiveSession {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  const events = session.snapshotEvents()
  const observed = observeSession(session.header, session.inheritedEventCount, events)
  return { ...observed, fingerprint: liveFingerprint(observed.header, observed.inheritedEventCount, events) }
}

/**
 * Build the search documents of one complete log without copying its events:
 * the documents hold only copied primitive values, and observation finishes
 * synchronously, so a later mutation of `events` cannot reach them.
 * @param header - the session header, copied into the result.
 * @param inheritedEventCount - the exact fork-inherited event count.
 * @param events - the complete contiguous raw event log.
 * @returns the detached header, the inherited cut, and the searchable documents.
 */
function observeSession(
  header: SessionHeader,
  inheritedEventCount: SessionLogOffset,
  events: readonly SessionEvent[],
): ObservedSession {
  const detachedHeader = structuredClone(header)
  return {
    header: detachedHeader,
    inheritedEventCount,
    documents: buildSessionEventSearchDocuments(detachedHeader.id, events),
  }
}

/**
 * Digest a live session one event at a time. Equal headers, cuts, and event
 * sequences give equal digests; any changed, added, or removed event changes
 * the digest. JSON text contains no raw newline, so the newline before each event keeps
 * event boundaries unambiguous. The digest is stored only in connection-local
 * TEMP rows.
 * @param header - the session header.
 * @param inheritedEventCount - the exact fork-inherited event count.
 * @param events - the complete contiguous raw event log.
 * @returns a base64url SHA-256 digest.
 */
function liveFingerprint(
  header: SessionHeader,
  inheritedEventCount: SessionLogOffset,
  events: readonly SessionEvent[],
): string {
  const hash = createHash('sha256').update(JSON.stringify({ header, inheritedEventCount }))
  for (const event of events) hash.update(`\n${JSON.stringify(event)}`)
  return hash.digest('base64url')
}

function materializePersistenceSnapshots(
  snapshots: readonly SessionPersistenceSnapshot[],
): Map<SessionId, ObservedPersistedSession> {
  if (!isRuntimeArray(snapshots)) throw new Error('persistence snapshots must be an array')
  const result = new Map<SessionId, ObservedPersistedSession>()
  for (const snapshot of snapshots) {
    if (typeof snapshot.revision !== 'string') {
      throw new Error('persistence snapshot revision must be a string')
    }
    const header = structuredClone(snapshot.header)
    if (result.has(header.id)) {
      throw new Error(`persistence listed duplicate session "${header.id}"`)
    }
    result.set(header.id, { header, revision: snapshot.revision })
  }
  return result
}

function samePersistenceSnapshots(
  before: ReadonlyMap<SessionId, ObservedPersistedSession>,
  after: ReadonlyMap<SessionId, ObservedPersistedSession>,
): boolean {
  if (before.size !== after.size) return false
  for (const [id, first] of before) {
    const second = after.get(id)
    if (
      second === undefined
      || first.revision !== second.revision
      || !sameHeader(first.header, second.header)
    ) return false
  }
  return true
}

function sameSessionIds(
  before: ReadonlySet<SessionId>,
  after: ReadonlyMap<SessionId, ObservedSession>,
): boolean {
  if (before.size !== after.size) return false
  for (const id of before) {
    if (!after.has(id)) return false
  }
  return true
}

function sameHeader(a: SessionHeader, b: SessionHeader): boolean {
  return a.id === b.id
    && a.createdAt === b.createdAt
    && a.cwd === b.cwd
    && a.parentSession === b.parentSession
    && a.isSeeded === b.isSeeded
    && (a.delegationDepth ?? 0) === (b.delegationDepth ?? 0)
    && a.agentPreset === b.agentPreset
}

function rowHeader(row: SessionHeaderRow): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: row.session_id as SessionId,
    createdAt: row.created_at,
    ...row.cwd === null ? {} : { cwd: row.cwd },
    ...row.parent_session === null ? {} : { parentSession: row.parent_session as SessionId },
    isSeeded: row.seed_length !== null,
    ...row.delegation_depth === null ? {} : { delegationDepth: row.delegation_depth },
    ...row.agent_preset === null ? {} : { agentPreset: row.agent_preset },
  }
}

function page<Row, Item>(
  rows: readonly Row[],
  limit: number,
  convert: (row: Row) => Item,
  nextCursor: (offset: number) => SessionSearchCursorValue,
  offset: number,
): SessionSearchPage<Item> {
  const hasMore = rows.length > limit
  return {
    items: rows.slice(0, limit).map(convert),
    ...hasMore ? { nextCursor: nextCursor(offset + limit) } : {},
  }
}

function encodeCursor(payload: CursorPayload): SessionSearchCursorValue {
  return SessionSearchCursor(Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'))
}

function decodeCursor(
  cursor: SessionSearchCursorValue,
  instance: string,
  scope: CursorPayload['scope'],
  fingerprint: string,
  generation: string,
): number {
  let decoded: Partial<CursorPayload>
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorPayload>
  } catch (error: unknown) {
    throw invalidCursor(error)
  }
  if (
    decoded.version !== 1
    || decoded.instance !== instance
    || decoded.scope !== scope
    || decoded.fingerprint !== fingerprint
    || !Number.isSafeInteger(decoded.offset)
    || decoded.offset === undefined
    || decoded.offset < 0
  ) {
    throw invalidCursor(new Error('cursor does not belong to this normalized request'))
  }
  if (decoded.generation !== generation) {
    throw new SessionQueryError(
      'session-search cursor is stale because its relevant corpus changed',
      'SESSION_QUERY_STALE_CURSOR',
    )
  }
  return decoded.offset
}

function invalidCursor(cause: unknown): SessionQueryError {
  return new SessionQueryError(
    'session-search cursor is invalid',
    'SESSION_QUERY_INVALID_CURSOR',
    { cause },
  )
}

function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    path: config.path,
    openAt: config.openAt ?? 'startup',
    journalMode: config.journalMode ?? 'wal',
    defaultLimit: config.defaultLimit ?? SESSION_QUERY_SQLITE_DEFAULT_LIMIT,
    maxLimit: config.maxLimit ?? SESSION_QUERY_SQLITE_MAX_LIMIT,
    snippetChars: config.snippetChars ?? SESSION_QUERY_SQLITE_SNIPPET_CHARS,
    readWindowMax: config.readWindowMax ?? SESSION_QUERY_READ_WINDOW_MAX,
    persistedReadConcurrency: config.persistedReadConcurrency
      ?? SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
    preparedSessionCacheSize: config.preparedSessionCacheSize
      ?? SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  }
  if (typeof resolved.path !== 'string' || resolved.path.trim().length === 0) {
    throw invalidConfig('path must not be blank')
  }
  const openPhases: readonly string[] = ['startup', 'first-search', 'never']
  if (!openPhases.includes(resolved.openAt)) throw invalidConfig('openAt is not supported')
  assertPageLimit('defaultLimit', resolved.defaultLimit)
  assertPageLimit('maxLimit', resolved.maxLimit)
  assertPositiveInteger('snippetChars', resolved.snippetChars)
  if (!Number.isInteger(resolved.readWindowMax) || resolved.readWindowMax < 0) {
    throw invalidConfig('readWindowMax must be a non-negative integer')
  }
  if (
    !Number.isSafeInteger(resolved.persistedReadConcurrency)
    || resolved.persistedReadConcurrency < 1
  ) {
    throw invalidConfig('persistedReadConcurrency must be a positive safe integer')
  }
  if (
    !Number.isSafeInteger(resolved.preparedSessionCacheSize)
    || resolved.preparedSessionCacheSize < 1
  ) {
    throw invalidConfig('preparedSessionCacheSize must be a positive safe integer')
  }
  if (resolved.defaultLimit > resolved.maxLimit) {
    throw invalidConfig('defaultLimit must be less than or equal to maxLimit')
  }
  const journalModes: readonly string[] = ['wal', 'delete', 'truncate', 'persist']
  if (!journalModes.includes(resolved.journalMode)) throw invalidConfig('journalMode is not supported')
  return resolved
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw invalidConfig(`${name} must be a positive integer`)
}

function assertPageLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > SQLITE_MAX_PAGE_LIMIT) {
    throw invalidConfig(`${name} must be an integer between 1 and ${SQLITE_MAX_PAGE_LIMIT}`)
  }
}

function invalidConfig(detail: string): SessionQueryError {
  return new SessionQueryError(
    `session-search SQLite config: ${detail}`,
    'SESSION_QUERY_INVALID_CONFIG',
  )
}

function indexClosed(): SessionQueryError {
  return new SessionQueryError('session-search SQLite index is closed', 'SESSION_QUERY_INDEX_FAILED')
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED')
  }
}

function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(asError(error))
      },
    )
  })
}

function isAbort(error: unknown): boolean {
  return error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED'
}

function isIndexFailure(error: unknown): boolean {
  return error instanceof SessionQueryError && error.code === 'SESSION_QUERY_INDEX_FAILED'
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('session-search dependency rejected with a non-Error value', { cause: error })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value)
}

export default SqliteSessionQueryEngine
