window.__ModuleLoader__.load({
  id: 'dsh-plugin-router',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const useLayoutEffect = React.useLayoutEffect ?? React.useEffect
    const LEVELS = ['mechanical', 'ordinary', 'hard']
    const MAX_MODELS = 4
    const STALE_PENDING_MS = 5 * 60_000
    // The effort ids a `/router level` token can carry (the Host's rule).
    const EFFORT_ID = /^[A-Za-z0-9._-]{1,32}$/

    const en = {
      'chip.on': 'Model router',
      'chip.unavailable': 'The command service is unavailable.',
      'chip.failed': 'Could not update Model router.',
      'chip.about': 'About Model router',
      'chip.description': 'Chooses models for subagents, not for this chat. When on, each subagent task uses one of up to four models you allow for its level, or Inherits the session default.',
      'level.mechanical': 'Mechanical',
      'level.ordinary': 'Ordinary',
      'level.hard': 'Hard judgment',
      'level.mechanical.hint': 'Fully specified, no judgment, checkable result.',
      'level.ordinary.hint': 'The default level for subagent work.',
      'level.hard.hint': 'Verification, or ambiguous work that is costly to undo.',
      'level.menu': '%LEVEL% models',
      'level.inherit': 'Inherit (session default)',
      'level.inheritShort': 'Inherit',
      'level.more': '%COUNT% more',
      'level.unavailableShort': 'unavailable',
      'level.unavailableGroup': 'Unavailable — removed on next change',
      'level.cap': 'Up to 4 models per level',
      'level.count': '%COUNT% of 4 selected',
      'level.noRoutes': 'No explicit subagent routes are authorized in this session; Inherit only.',
      'level.failed': 'Could not update this level.',
      'effort.labelFor': 'Effort for %MODEL%',
      'effort.default': 'Default',
      'effort.defaultNamed': 'Default (%EFFORT%)',
      'effort.recommended': 'recommended',
      'effort.cell': 'effort %EFFORT%',
    }
    const zh = {
      'chip.on': '模型路由器',
      'chip.unavailable': '命令服务不可用。',
      'chip.failed': '无法更新模型路由器。',
      'chip.about': '关于模型路由器',
      'chip.description': '为子代理选择模型，而不是为当前对话。启用后，每个子代理任务会使用你为其级别允许的最多四个模型之一，或继承会话默认模型。',
      'level.mechanical': '机械任务',
      'level.ordinary': '普通任务',
      'level.hard': '高难度判断',
      'level.mechanical.hint': '要求完全明确、无需判断、结果可检验。',
      'level.ordinary.hint': '子代理工作的默认级别。',
      'level.hard.hint': '验证类工作，或含糊且难以撤销的工作。',
      'level.menu': '%LEVEL%模型',
      'level.inherit': '继承（会话默认）',
      'level.inheritShort': '继承',
      'level.more': '另 %COUNT% 个',
      'level.unavailableShort': '不可用',
      'level.unavailableGroup': '不可用——下次更改时移除',
      'level.cap': '每个级别最多 4 个模型',
      'level.count': '已选 %COUNT%/4',
      'level.noRoutes': '此会话没有已授权的显式子代理路由；只能继承。',
      'level.failed': '无法更新此级别。',
      // The host model menu's own words: 推理等级, and Default kept as is.
      'effort.labelFor': '%MODEL% 的推理等级',
      'effort.default': 'Default',
      'effort.defaultNamed': 'Default（%EFFORT%）',
      'effort.recommended': '推荐',
      'effort.cell': '推理等级 %EFFORT%',
    }

    // Row, cell, and flyout rules copy the host model menu (root cells, option
    // rows, separators, menu material, submenu placement); theme tokens only.
    const styles = `
      .router-row{border-radius:var(--dsw-radius-md);min-height:34px;color:var(--dsw-alias-label-primary);
        justify-content:space-between;align-items:center;gap:16px;padding:0 8px;
        font-size:13px;line-height:20px;display:flex;position:relative}
      .router-label{align-items:center;gap:4px;min-width:0;display:inline-flex}
      .router-info{z-index:1;width:20px;height:20px;color:var(--dsw-alias-label-caption);flex:none;padding:0;position:relative}
      .router-row .router-toggle{position:static}
      .router-toggle:after{content:"";border-radius:var(--dsw-radius-md);position:absolute;inset:0}
      .router-row:has(.router-toggle:focus-visible){background:var(--dsw-alias-interactive-bg-hover)}
      @media (hover:hover){.router-row:has(.router-toggle:not(:disabled)):hover{background:var(--dsw-alias-interactive-bg-hover)}}
      .router-error{color:var(--dsw-alias-state-error-primary);font-size:11px;margin-inline-start:6px}
      .router-cell{box-sizing:border-box;display:flex;align-items:center;gap:6px;width:auto;min-width:100%;height:34px;
        padding:0 8px 0 20px;border:none;border-radius:var(--dsw-radius-md);background:transparent;
        color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;
        text-align:left;outline:none;anchor-name:var(--router-anchor)}
      .router-cell[data-inactive] .router-cell-label{color:var(--dsw-alias-label-tertiary)}
      .router-cell:focus-visible,.router-cell[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}
      @media (hover:hover){.router-cell:hover{background:var(--dsw-alias-interactive-bg-hover)}}
      .router-cell-label{flex:0 0 auto;white-space:nowrap}
      .router-cell-value{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        text-align:right;color:var(--dsw-alias-label-tertiary)}
      .router-cell-value[data-warning]{color:var(--dsw-alias-state-warn-label)}
      .router-cell-effort{flex:0 0 auto;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
      .router-cell-more{flex:0 0 auto;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
      .router-chevron{display:grid;place-items:center;flex:0 0 12px;width:12px;height:12px;color:var(--dsw-alias-menu-icon)}
      .router-chevron svg,.router-check svg{display:block}
      .router-spinner{color:var(--dsw-alias-label-tertiary)}
      .router-spinner-motion{transform-origin:center;animation:router-spin 1.5s linear infinite}
      .router-spinner-track,.router-spinner-arc{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
      .router-spinner-track{opacity:.25}
      .router-spinner-arc{stroke-dasharray:12 150;animation:router-dash 1.5s ease-in-out infinite}
      @keyframes router-spin{to{transform:rotate(360deg)}}
      @keyframes router-dash{0%{stroke-dasharray:12 150;stroke-dashoffset:0}50%{stroke-dasharray:24 150;stroke-dashoffset:-6}to{stroke-dasharray:12 150;stroke-dashoffset:0}}
      @media (prefers-reduced-motion:reduce){.router-spinner-motion,.router-spinner-arc{animation:none}.router-spinner-arc{stroke-dasharray:18 150;stroke-dashoffset:-3}}
      .router-flyout{--router-window-top:max(12px,var(--dsh-frame-overlay-top,12px));
        position:fixed;position-anchor:var(--router-anchor);position-visibility:always;inset:auto;margin:0;
        top:max(var(--router-window-top),min(anchor(top),calc(100dvh - 12px - var(--router-flyout-height,0px))));
        left:calc(anchor(right) + 8px);position-try-fallbacks:--router-flyout-left;
        z-index:1101;box-sizing:border-box;display:flex;flex-direction:column;
        width:max-content;min-width:min(220px,calc(100vw - 24px));max-width:min(340px,calc(100vw - 24px));
        max-height:min(360px,calc(100dvh - 12px - var(--router-window-top)));overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;
        padding:4px;border:0;border-radius:var(--dsw-radius-lg);
        background:var(--dsw-menu-surface-fill);-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter);
        backdrop-filter:var(--dsw-menu-backdrop-filter);
        --dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);
        color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;-webkit-app-region:no-drag;
        --dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
      html[data-platform=darwin] .router-flyout{background:linear-gradient(var(--dsw-menu-surface-fill),var(--dsw-menu-surface-fill)),var(--dsw-alias-bg-base)}
      @position-try --router-flyout-left{left:auto;right:calc(anchor(left) + 8px)}
      .router-option{box-sizing:border-box;display:flex;flex:none;align-items:center;gap:6px;width:auto;min-width:100%;
        min-height:34px;padding:5px 7px;border:none;border-radius:var(--dsw-radius-md);outline:none;
        background:transparent;color:inherit;font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer}
      .router-option:focus-visible,.router-option:focus{background:var(--dsw-alias-interactive-bg-hover)}
      .router-option[aria-disabled=true]{opacity:.4;cursor:not-allowed}
      .router-option-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .router-check{display:grid;place-items:center;flex:0 0 14px;color:var(--dsw-alias-label-primary)}
      .router-option[data-warning] .router-option-label{color:var(--dsw-alias-state-warn-label)}
      .router-option-note{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
      .router-efforts{display:flex;flex:none;flex-direction:column}
      .router-efforts[hidden]{display:none}
      .router-option-effort{padding-inline-start:23px}
      .router-option-effort .router-option-label{color:var(--dsw-alias-label-secondary)}
      .router-group+.router-group{margin-top:3px}
      .router-heading{padding:4px 7px 2px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-weight:500}
      .router-separator{flex:none;height:.5px;margin:3px 8px;background:var(--dsw-alias-border-l2)}
      .router-note{flex:none;padding:4px 7px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:normal}
    `

    // Host icon geometry (16-unit grid, 1-unit stroke).
    const chevronIcon = h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
      h('path', { d: 'M6 12L9.29289 8.70711C9.68342 8.31658 9.68342 7.68342 9.29289 7.29289L6 4', stroke: 'currentColor', strokeWidth: 1 }))
    const checkIcon = h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
      h('path', { d: 'M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4', stroke: 'currentColor', strokeWidth: 1 }))
    const spinnerIcon = h('svg', { className: 'router-spinner', width: 12, height: 12, viewBox: '0 0 24 24', 'aria-hidden': 'true' },
      h('g', { className: 'router-spinner-motion' },
        h('circle', { className: 'router-spinner-track', cx: 12, cy: 12, r: 9 }),
        h('circle', { className: 'router-spinner-arc', cx: 12, cy: 12, r: 9 })))

    const routeKey = (route) => `${route.provider}/${route.model}`
    const keysOf = (routes) => Array.isArray(routes) ? routes.map(routeKey) : []
    const providerOf = (key) => key.slice(0, key.indexOf('/'))
    const modelOf = (key) => key.slice(key.indexOf('/') + 1)
    const shortModel = (key) => modelOf(key).split('/').pop()
    /** The route of an authorized `provider/model` key; provider ids hold no slash. */
    const keyRoute = (key) => ({ provider: providerOf(key), model: modelOf(key) })
    // The efforts of saved entries by route key; an entry without one (no
    // key) runs at its model's own default.
    const entryEfforts = (routes) => {
      const efforts = {}
      if (Array.isArray(routes)) {
        for (const route of routes) {
          if (typeof route?.effort === 'string' && route.effort !== '') efforts[routeKey(route)] = route.effort
        }
      }
      return efforts
    }
    const effortFor = (efforts, key) => Object.hasOwn(efforts, key) ? efforts[key] : undefined
    // A copy of efforts with key's effort set, or removed for Default.
    const withEffort = (efforts, key, effort) => {
      const next = { ...efforts }
      if (effort === undefined) delete next[key]
      else next[key] = effort
      return next
    }
    const entryText = (key, effort) => effort === undefined ? key : `${key} effort=${effort}`
    // A level value as a command states it, the whole level: `inherit`, or
    // every entry with its own effort token. It also identifies a value in
    // the draft bookkeeping.
    const valueText = (keys, efforts) => keys.length === 0 ? 'inherit' : keys.map((key) => entryText(key, effortFor(efforts, key))).join(',')
    // Model rows are checkboxes and effort rows single-choice radios; focus
    // and the arrow keys cover both, in document order, except the rows of a
    // hidden effort group.
    const ROW_SELECTOR = '[role="menuitemcheckbox"],[role="menuitemradio"]'
    const CHECKED_ROW_SELECTOR = '[role="menuitemcheckbox"][aria-checked="true"],[role="menuitemradio"][aria-checked="true"]'
    const shown = (element) => typeof element?.closest !== 'function' || element.closest('[hidden]') === null
    const rowsIn = (element, selector) => Array.from(element?.querySelectorAll?.(selector) ?? []).filter(shown)
    const supportsPopover = () => typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype
    const activeElement = () => typeof document === 'undefined' ? null : document.activeElement
    let anchorCounter = 0
    // One router command at a time per session from this page: the switch,
    // the three level cells, and a closed menu's commit share one queue, so
    // they never collide with each other. lock.current is the entry queued
    // last; lock.running is the entry whose turn it is.
    const sessionLocks = new Map()
    const LOCK_EXPIRY_MS = 30_000
    const endTurn = (lock, entry) => {
      if (entry.ended) return
      entry.ended = true
      if (lock.running === entry) lock.running = null
      if (lock.current === entry) lock.current = null
      entry.release()
    }
    // A call that never settles must not block the queue forever: its turn
    // ends LOCK_EXPIRY_MS after it started; time spent queued does not count.
    // There is no timer: the lock is checked whenever it is used or rendered.
    const expireLock = (lock) => {
      const entry = lock.running
      if (entry !== null && Date.now() - entry.startedAt > LOCK_EXPIRY_MS) endTurn(lock, entry)
    }
    const lockFor = (sessionId) => {
      const key = sessionId ?? ''
      if (!sessionLocks.has(key)) sessionLocks.set(key, { current: null, running: null, listeners: new Set() })
      const lock = sessionLocks.get(key)
      expireLock(lock)
      return lock
    }
    // Whether the switch or another level has a command queued or running.
    const heldByOther = (lock, level) => {
      expireLock(lock)
      return lock.current !== null && lock.current.level !== level
    }
    // Run one command under the session lock, after every command queued before it.
    const withLock = (lock, level, start) => {
      expireLock(lock)
      const entry = { level, startedAt: null, ended: false, release: null, promise: null }
      // Settles when this entry's turn ends: its call settled, or it expired.
      entry.promise = new Promise((resolve) => { entry.release = resolve })
      // The lock announces every turn that ends to whoever waits on it, so no
      // caller needs to know who is waiting.
      void entry.promise.then(() => { for (const listener of [...lock.listeners]) listener() })
      const before = lock.current?.promise ?? Promise.resolve()
      lock.current = entry
      return before.then(() => undefined, () => undefined).then(() => {
        entry.startedAt = Date.now()
        lock.running = entry
        return start()
      }).then((ok) => {
        endTurn(lock, entry)
        return ok
      }, (error) => {
        endTurn(lock, entry)
        throw error
      })
    }

    // The view is pure; age the pending marker against this clock so a
    // command interrupted by a crash cannot block the controls forever.
    function freshPending(view) {
      if (view?.pending !== true) return false
      const since = view.pendingSince
      return typeof since !== 'number' || Date.now() - since < STALE_PENDING_MS
    }

    // The model directory helpers below are copied from the advisor client
    // (packages do not import each other); the router's id rule is stricter.

    /**
     * The session's ModelDirectory store, or undefined when the service is
     * absent, the session has no directory, or anything throws. A lazy
     * `ctx.get`, never an inject entry: a missing inject would leave the whole
     * client entry pending and break web boot.
     */
    function directoryStore(ctx, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      try {
        const directories = ctx?.get?.('modelDirectories')
        if (typeof directories?.directoryFor !== 'function') return undefined
        const store = directories.directoryFor(sessionId)?.store
        return typeof store?.getSnapshot === 'function' ? store : undefined
      } catch {
        return undefined
      }
    }

    /**
     * What the directory advertises for one route, efforts least to greatest:
     * `list` (at least one effort), `none` (listed without efforts, or with
     * an empty list), or `unknown` (service absent or throwing, no groups yet,
     * route not listed, malformed snapshot, or a list none of whose entries
     * is usable). Ids a command token cannot carry and repeats are skipped; a
     * missing name shows the id. `defaultEffort` is the model's own default,
     * only when it is one of the listed efforts. Never throws.
     * @returns {{ state: 'unknown' | 'none' | 'list', efforts: { id: string, name: string }[], defaultEffort?: { id: string, name: string } }}
     */
    function effortsFor(ctx, sessionId, route) {
      const unknown = { state: 'unknown', efforts: [] }
      try {
        const groups = directoryStore(ctx, sessionId)?.getSnapshot()?.groups
        if (!Array.isArray(groups)) return unknown
        const models = groups.find((group) => group?.id === route.provider)?.models
        if (!Array.isArray(models)) return unknown
        const model = models.find((candidate) => candidate?.id === route.model)
        if (model === null || typeof model !== 'object') return unknown
        if (model.reasoning === undefined) return { state: 'none', efforts: [] }
        const advertised = model.reasoning?.efforts
        if (!Array.isArray(advertised)) return unknown
        const efforts = []
        for (const effort of advertised) {
          const id = effort?.id
          if (typeof id !== 'string' || !EFFORT_ID.test(id) || efforts.some((listed) => listed.id === id)) continue
          const name = typeof effort.name === 'string' && effort.name.trim() !== '' ? effort.name : id
          efforts.push({ id, name })
        }
        // Entries that are all unusable say nothing about the model: unknown.
        if (efforts.length === 0 && advertised.length > 0) return unknown
        const defaultId = model.reasoning.defaultEffort
        const defaultEffort = typeof defaultId === 'string' ? efforts.find((listed) => listed.id === defaultId) : undefined
        return { state: efforts.length === 0 ? 'none' : 'list', efforts, ...(defaultEffort === undefined ? {} : { defaultEffort }) }
      } catch {
        return unknown
      }
    }

    /**
     * The effort a level recommends for a model, applied when a model that
     * is not saved is checked in the flyout, and once, automatically, to the
     * saved entries without an effort (see LevelCell); undefined is Default
     * (no effort token, the model's own default). Mechanical and Ordinary
     * keep Default. Hard judgment takes the highest advertised effort other
     * than `max` (a deliberate pick) and `off`. Unknown or absent efforts
     * recommend nothing.
     */
    function recommendedEffort(level, advertised) {
      if (advertised.state !== 'list' || level !== 'hard') return undefined
      const ids = advertised.efforts.map((effort) => effort.id)
      for (let index = ids.length - 1; index >= 0; index--) {
        if (ids[index] !== 'max' && ids[index] !== 'off') return ids[index]
      }
      return undefined
    }

    // The marker of the automatic recommended effort: one localStorage key
    // per session and level, never per model. It is kept per browser origin
    // and never removed.
    const hasSessionId = (sessionId) => typeof sessionId === 'string' && sessionId !== ''
    const autoEffortKey = (sessionId, level) => `dsh.autoEffort.v1:router:${sessionId}:${level}`
    /**
     * Claim the marker: true only when the key was absent and reads back as
     * written. Missing storage or any throw (reading the global included)
     * claims nothing, and nothing in memory stands in for it, so the
     * automatic effort is not sent.
     */
    function claimAutoEffort(key) {
      try {
        if (typeof localStorage === 'undefined') return false
        if (localStorage.getItem(key) !== null) return false
        localStorage.setItem(key, 'auto')
        return localStorage.getItem(key) === 'auto'
      } catch {
        return false
      }
    }
    /** Set the marker for a choice made in a level cell, so the automatic effort never undoes it. */
    function markAutoEffortChoice(key) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(key, 'user')
      } catch {
        // Without storage nothing is sent automatically either.
      }
    }

    /**
     * One model's effort rows: Default (carrying the name of the model's real
     * default when advertised), the advertised efforts in order, then the
     * entry's own ids the model does not advertise, with a warning unless the
     * efforts are unknown. Unknown efforts give Default and those ids only,
     * unmarked. The recommended row is marked only for a listed model. Null
     * (no effort rows) for a model listed without efforts and without an id.
     */
    function effortRowsFor(advertised, own, recommended) {
      const extra = []
      for (const id of own) {
        if (id !== undefined && !extra.includes(id) && !advertised.efforts.some((effort) => effort.id === id)) extra.push(id)
      }
      if (advertised.state === 'none' && extra.length === 0) return null
      const marked = advertised.state === 'list'
      const rows = [{ effort: undefined, name: advertised.defaultEffort?.name, warning: false, recommended: marked && recommended === undefined }]
      for (const effort of advertised.efforts) {
        rows.push({ effort: effort.id, name: effort.name, warning: false, recommended: marked && effort.id === recommended })
      }
      for (const id of extra) rows.push({ effort: id, name: id, warning: advertised.state !== 'unknown', recommended: false })
      return rows
    }

    /** The Default row's text: `Default (<effort name>)` when the name is known. */
    function defaultLabel(t, name) {
      if (name === undefined) return t('effort.default')
      const pattern = t('effort.defaultNamed')
      return pattern.includes('%EFFORT%') ? pattern.replace('%EFFORT%', () => name) : `${t('effort.default')} (${name})`
    }

    /** An effort group's label, naming its model as its row shows it. */
    function effortLabel(t, key) {
      const pattern = t('effort.labelFor')
      return pattern.includes('%MODEL%') ? pattern.replace('%MODEL%', () => modelOf(key)) : `${pattern} ${modelOf(key)}`
    }

    /**
     * Re-render when the session's model directory changes (the catalog loads
     * or refreshes). RouterLevels calls it on every render path, before its
     * early return, so its hook order never changes.
     */
    function useDirectoryUpdates(ctx, sessionId) {
      const [, setVersion] = React.useState(0)
      const store = directoryStore(ctx, sessionId)
      let seen
      try { seen = store?.getSnapshot() } catch { seen = undefined }
      React.useEffect(() => {
        if (typeof store?.subscribe !== 'function') return undefined
        const changed = () => setVersion((version) => version + 1)
        let unsubscribe
        try {
          unsubscribe = store.subscribe(changed)
          // A change between that render and this subscription is not lost.
          if (store.getSnapshot() !== seen) changed()
        } catch {
          // A broken store leaves the efforts unknown.
        }
        return () => {
          try {
            if (typeof unsubscribe === 'function') unsubscribe()
          } catch { /* already gone */ }
        }
      }, [store])
    }

    function useAnchorName() {
      const fallback = React.useRef(null)
      const reactId = typeof React.useId === 'function' ? React.useId() : null
      if (reactId !== null) return `--router-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`
      if (fallback.current === null) fallback.current = `--router-a${++anchorCounter}`
      return fallback.current
    }

    // Run a router command line. Host handler outcomes arrive through the
    // projection's failure record; an error outcome here means the line itself
    // was not admitted.
    function useCommand(props) {
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const mounted = React.useRef(true)
      React.useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
      }, [])
      const t = props.t ?? ((key) => en[key] ?? key)
      const report = (message) => {
        if (typeof props.reportFailure === 'function') props.reportFailure(message)
        else if (mounted.current) setError(message)
      }
      // shouldReport, when given, is asked when the call fails: a caller whose
      // failure was already reported another way returns false.
      const run = async (line, failureKey, shouldReport) => {
        if (mounted.current) {
          setBusy(true)
          setError(null)
        }
        try {
          const commandUi = props.ctx.get('commandUi')
          if (!commandUi?.execute) throw new Error(t('chip.unavailable'))
          const outcome = await commandUi.execute({ sessionId: props.sessionId }, line)
          if (outcome?.kind === 'error') throw new Error(outcome.text || t(failureKey))
          return true
        } catch (cause) {
          if (shouldReport === undefined || shouldReport()) report(cause instanceof Error ? cause.message : t(failureKey))
          return false
        } finally {
          if (mounted.current) setBusy(false)
        }
      }
      return { busy, error, run, report, mounted }
    }

    // Report a projection failure once, and only to the control that sent it.
    function useFailureWatch(view, matches, onFailure) {
      const seen = React.useRef(view?.failure?.count ?? 0)
      const count = view?.failure?.count ?? 0
      React.useEffect(() => {
        if (count <= seen.current) return
        seen.current = count
        if (matches(view.failure)) onFailure(view.failure)
      }, [count])
    }

    function RouterSwitch(props) {
      if (primitives?.Switch != null) return h(primitives.Switch, props)
      return h('button', {
        type: 'button', role: 'switch', className: props.className, 'aria-checked': props.checked,
        'aria-label': props.label, disabled: props.disabled, onClick: () => props.onChange(!props.checked),
      })
    }

    function RouterOption(props) {
      const view = props.useProjection?.('router')
      const active = view?.mode === 'manual'
      const pending = freshPending(view)
      const { busy, error, run, report } = useCommand(props)
      // The requested mode while our command is unresolved; cleared once the
      // session reflects it, so later failures from other tabs are not ours.
      const sentMode = React.useRef(null)
      const t = props.t ?? ((key) => en[key] ?? key)
      if (sentMode.current !== null && view?.mode === sentMode.current && !pending) sentMode.current = null
      useFailureWatch(view, (failure) => failure.target === 'mode' && sentMode.current !== null, (failure) => {
        sentMode.current = null
        report(failure.text || t('chip.failed'))
      })
      const info = primitives?.Tooltip && primitives?.Button
        ? h(primitives.Tooltip, {
          label: t('chip.description'), side: 'top', delayMs: 300,
          maxWidth: 300, portal: true, openOnClick: true,
        },
          h(primitives.Button, {
            variant: 'ghost', size: 'sm', className: 'router-info',
            'aria-label': t('chip.about'),
          }, primitives.IconInfoOutlineRegular ? h(primitives.IconInfoOutlineRegular, { size: 11, 'aria-hidden': 'true' }) : 'i'),
        )
        : null
      return h(React.Fragment, null,
        h('style', null, styles),
        h('div', { className: 'router-row', 'aria-busy': pending || busy },
          h('span', { className: 'router-label' }, h('span', null, t('chip.on')), info),
          h(RouterSwitch, {
            className: 'router-toggle',
            checked: active,
            // Disabling a focused switch blurs it and the host menu closes on
            // that blur, so in-flight states are guarded in onChange instead.
            disabled: props.locked,
            label: t('chip.on'),
            onChange: (enabled) => {
              // sentMode also covers a press still queued behind another
              // command, when neither busy nor pending is set yet.
              if (busy || pending || sentMode.current !== null) return
              sentMode.current = enabled ? 'manual' : 'off'
              // Queued behind a level commit that a flyout close just started.
              void withLock(lockFor(props.sessionId), 'mode', () => run(enabled ? '/router manual' : '/router off', 'chip.failed')).then((ok) => {
                if (!ok) sentMode.current = null
              })
            },
          }),
        ),
        error ? h('span', { className: 'router-error', role: 'alert' }, error) : null,
      )
    }

    // A model row (a checkbox with a trailing check), or with `effort` an
    // indented effort row (a radio, same look; an optional right-aligned
    // note such as "recommended" comes before the check).
    function OptionRow(props) {
      return h('button', {
        type: 'button',
        role: props.role ?? 'menuitemcheckbox',
        className: props.effort ? 'router-option router-option-effort' : 'router-option',
        'aria-checked': props.checked,
        'aria-disabled': props.disabled ? 'true' : undefined,
        'data-warning': props.warning ? '' : undefined,
        title: props.title,
        ref: props.elementRef,
        onMouseMove: (event) => { if (activeElement() !== event.currentTarget) event.currentTarget.focus() },
        onClick: () => { if (!props.disabled) props.onSelect() },
      },
        h('span', { className: 'router-option-label' }, props.label),
        props.note ? h('span', { className: 'router-option-note' }, props.note) : null,
        h('span', { className: 'router-check' }, props.checked ? checkIcon : null),
      )
    }

    function LevelFlyout(props) {
      const ref = React.useRef(null)
      const closeRef = React.useRef(null)
      // Hand focus to a surviving control before the focused row unmounts, so
      // the host menu never sees focus fall to the document and close itself.
      closeRef.current = (target) => {
        const active = activeElement()
        if (target !== undefined || (active !== null && ref.current?.contains(active))) {
          ;(target ?? props.cellRef.current)?.focus()
        }
        props.onClose()
      }
      useLayoutEffect(() => {
        const element = ref.current
        if (!element) return undefined
        if (typeof element.showPopover === 'function') {
          try { element.showPopover() } catch { /* already open or detached */ }
        }
        const measure = () => { element.style.setProperty('--router-flyout-height', `${element.offsetHeight}px`) }
        measure()
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
        observer?.observe(element)
        const focusTarget = rowsIn(element, CHECKED_ROW_SELECTOR)[0] ?? rowsIn(element, ROW_SELECTOR)[0]
        focusTarget?.focus()
        return () => {
          observer?.disconnect()
          if (typeof element.hidePopover === 'function') {
            try { element.hidePopover() } catch { /* already hidden */ }
          }
        }
      }, [])
      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const onDown = (event) => {
          if (ref.current?.contains(event.target) || props.cellRef.current?.contains(event.target)) return
          const button = event.target instanceof Element ? event.target.closest('button') : null
          closeRef.current(button ?? undefined)
        }
        document.addEventListener('mousedown', onDown, true)
        return () => { document.removeEventListener('mousedown', onDown, true) }
      }, [])
      const onKeyDown = (event) => {
        if (event.nativeEvent?.isComposing) return
        // Every effort row is a stop of its own; a hidden group is skipped.
        const items = rowsIn(ref.current, ROW_SELECTOR)
        const index = items.indexOf(activeElement())
        const focusAt = (at) => { items[(at + items.length) % items.length]?.focus() }
        switch (event.key) {
          case 'ArrowDown': focusAt(index + 1); break
          case 'ArrowUp': focusAt(index < 0 ? -1 : index - 1); break
          case 'Home': focusAt(0); break
          case 'End': focusAt(-1); break
          case 'Tab':
          case 'Escape':
          case 'ArrowLeft': closeRef.current(props.cellRef.current ?? undefined); break
          default: return
        }
        event.preventDefault()
        event.stopPropagation()
      }
      return h('div', {
        ref,
        id: props.id,
        className: 'router-flyout',
        role: 'menu',
        'aria-label': props.label,
        'aria-describedby': props.describedBy,
        'data-menu-material': 'translucent',
        popover: supportsPopover() ? 'manual' : undefined,
        style: { '--router-anchor': props.anchor },
        onKeyDown,
        // Presses on headings, notes, or padding must not move focus out of
        // the host menu; buttons keep their normal behavior.
        onMouseDown: (event) => {
          const surface = event.currentTarget
          // Leave presses on the flyout's own scrollbar to the browser.
          if (event.target === surface && event.nativeEvent?.offsetX >= surface.clientWidth) return
          if (!(event.target instanceof Element) || event.target.closest('button') === null) event.preventDefault()
        },
      }, props.children)
    }

    function LevelCell(props) {
      const { level, view, routes, t, lock } = props
      const anchor = useAnchorName()
      const cellRef = React.useRef(null)
      const { busy, run, report, mounted } = useCommand(props)
      // The draft, { keys, efforts }: the entries the open flyout shows and
      // their efforts by route key (no key: the model's own default). Its
      // valueText is the command text, so texts compare both parts.
      const [desired, setDesired] = React.useState(null)
      const [awaiting, setAwaiting] = React.useState(null)
      const saved = view?.selections?.[level]
      const confirmed = keysOf(saved)
      const confirmedEfforts = entryEfforts(saved)
      const confirmedText = valueText(confirmed, confirmedEfforts)
      const authorizedSet = new Set(keysOf(routes))
      const current = desired?.keys ?? confirmed
      const currentEfforts = desired?.efforts ?? confirmedEfforts
      const desiredText = desired === null ? null : valueText(desired.keys, desired.efforts)
      const pending = freshPending(view)
      const open = props.open === true
      const locked = props.locked === true

      // Edits are a draft while the flyout is open and are committed as one
      // command when it closes; levels share one lock so only one router
      // command is in flight from this menu at a time.
      // The command this cell sent, until it resolves: the value it replaced,
      // whether its call succeeded, and when it started.
      const sentFrom = React.useRef(null)
      // The draft already sent, written at send time so an unmount before the
      // next render never sends it again; a new edit makes a new draft.
      const sentDraft = React.useRef(null)
      // The latest call this cell started. The deadline leaves it set: a call
      // still running LOCK_EXPIRY_MS after it started has lost its turn in the
      // lock, so it no longer holds back this cell's next draft.
      const started = React.useRef(null)
      // The automatic effort of this mount (see its effect below): the saved
      // level at the first render with a view, whether its one attempt was
      // made, and the automatic draft until a choice replaces it, as its text
      // and the saved level it was made from.
      const auto = React.useRef({ baseline: null, done: false, draft: null })
      const isAuto = (text) => auto.current.draft !== null && text === auto.current.draft.text
      // An automatic draft is sent only while what it was made for still
      // holds: the same saved level, Router on, the menu not locked.
      // Otherwise it is dropped and never sent (the one attempt is spent).
      const staleAuto = (text, from, mode, isLocked) => isAuto(text) && (from !== auto.current.draft.from || mode !== 'manual' || isLocked)
      const stalled = busy && started.current !== null && Date.now() - started.current.startedAt > LOCK_EXPIRY_MS
      // A sent draft that the session neither confirms nor rejects within
      // LOCK_EXPIRY_MS of the command's start (a call that never returns, or
      // a command the session never recorded) is overdue: the deadline effect
      // below snaps it back and reports it like a rejection.
      const inFlight = sentFrom.current
      const overdue = awaiting !== null && awaiting !== confirmedText && inFlight !== null
        && inFlight.startedAt !== null && Date.now() - inFlight.startedAt > LOCK_EXPIRY_MS
      const clearAwaiting = () => {
        sentFrom.current = null
        setAwaiting(null)
      }
      // Only the draft that was sent snaps back: a newer draft the user made
      // since (even on the render that runs this) survives and is committed.
      const snapBack = (sentText) => {
        setDesired((draft) => draft !== null && valueText(draft.keys, draft.efforts) === sentText ? null : draft)
        clearAwaiting()
      }
      const fail = (text) => {
        snapBack(awaiting)
        report(text)
      }

      useFailureWatch(view, (failure) => failure.target === 'level' && failure.level === level && awaiting !== null,
        (failure) => fail(failure.text || t('level.failed')))

      // One command line per draft, stating the whole level: every entry with
      // its own effort token, or inherit. Nothing is kept from the saved
      // level, so a line never depends on what the session shows meanwhile.
      const lineFor = (draft) => `/router level ${level} ${valueText(draft.keys, draft.efforts)}`
      // One toast per failed commit: a call that the deadline, a recorded
      // rejection or a confirmation has superseded stays silent. A commit
      // sent on unmount (detached) has no later render to supersede it.
      const send = (draft, detached = false) => {
        const line = lineFor(draft)
        const record = { from: confirmedText, text: valueText(draft.keys, draft.efforts), settled: false, startedAt: null, result: null }
        const shouldReport = () => detached || sentFrom.current === record
        record.result = withLock(lock, level, () => {
          record.startedAt = Date.now()
          started.current = record
          return run(line, 'level.failed', shouldReport).then((ok) => {
            // Set before the lock announces its release, so woken cells see it.
            if (ok) record.settled = true
            return ok
          })
        })
        return record
      }
      React.useEffect(() => {
        if (desired === null) return
        if (desiredText === confirmedText && (awaiting === null || awaiting === desiredText)) {
          setDesired(null)
          clearAwaiting()
          return
        }
        if (awaiting !== null && awaiting === desiredText) {
          // Sent and resolved, but the session moved to a third value (another
          // tab wrote this level): show the session's value without a toast.
          const record = sentFrom.current
          if (record !== null && record.settled && confirmedText !== record.from) {
            setDesired(null)
            clearAwaiting()
          }
          return
        }
        if (staleAuto(desiredText, confirmedText, view?.mode, locked)) {
          setDesired(null)
          return
        }
        // A draft that the unmount commit sent while the cell stayed mounted
        // (its effects cleaned up and run again) is not sent a second time.
        if (desiredText === sentDraft.current && awaiting === null) return
        // An overdue call is settled by the deadline first; the render that
        // follows sends, so the deadline never clears a send it did not see.
        if (open || (busy && !stalled) || pending || overdue) return
        if (heldByOther(lock, level)) return
        sentDraft.current = desiredText
        const record = send(desired)
        sentFrom.current = record
        setAwaiting(desiredText)
        void record.result.then((ok) => {
          // Ignore a call that a later send, a confirmation or the deadline
          // has already superseded.
          if (ok || sentFrom.current !== record || !mounted.current) return
          snapBack(desiredText)
        })
      }, [desiredText, confirmedText, busy, stalled, pending, awaiting, open, overdue, props.lockTick, view?.mode, locked])
      React.useEffect(() => {
        if (desired === null && awaiting !== null && awaiting === confirmedText) clearAwaiting()
      }, [confirmedText, desired, awaiting])

      // The deadline. There is no timer: overdue is checked whenever the cell
      // renders, which includes every lock release.
      React.useEffect(() => {
        if (overdue) fail(t('level.failed'))
      }, [overdue])

      // A draft still open when the host menu closes is committed on unmount,
      // after any command this menu already has in flight, with this cell's
      // own session and lock: cells are keyed by session, so a session switch
      // unmounts the old cell rather than handing it the new session.
      const latest = React.useRef(null)
      latest.current = { desired, desiredText, confirmedText, mode: view?.mode, locked, send }
      React.useEffect(() => () => {
        const state = latest.current
        if (state === null || state.desired === null) return
        // The commit in flight is read from its ref, not from the last
        // render: it may have failed or been cleared since. Nothing to commit
        // when the session already shows the draft and no earlier commit is
        // still in flight to replace it.
        const inFlightNow = sentFrom.current
        if (state.desiredText === state.confirmedText && (inFlightNow === null || inFlightNow.text === state.desiredText)) return
        // Nor when this draft was sent already, or is the commit in flight,
        // or is an automatic draft whose conditions no longer hold.
        if (state.desiredText === sentDraft.current || (inFlightNow !== null && inFlightNow.text === state.desiredText)) return
        if (staleAuto(state.desiredText, state.confirmedText, state.mode, state.locked)) return
        const commit = () => {
          void state.send(state.desired, true)
          // A cell that stays mounted (its effects cleaned up and run again)
          // counts the draft as sent, so its send effect does not send it again.
          sentDraft.current = state.desiredText
        }
        // The automatic draft is made by the mount's own effects, and
        // StrictMode's practice unmount follows them at once: commit it here
        // only if the cell really unmounted. A cell mounted again sends it
        // through its send effect, which checks it first.
        if (isAuto(state.desiredText)) void Promise.resolve().then(() => { if (!mounted.current) commit() })
        else commit()
      }, [])

      const live = current.filter((key) => authorizedSet.has(key))
      const stale = confirmed.filter((key) => !authorizedSet.has(key))
      const atCap = live.length >= MAX_MODELS

      // The recommended effort, applied once and automatically: a saved level
      // whose entries lack an effort gets this level's recommendation (only
      // Hard judgment recommends one) as one whole-level draft, which the send
      // effect, the lock, the deadline, the snap-back and the unmount commit
      // handle like any other. Fail-closed: every condition holds in one
      // render, the marker is claimed, a mount makes one attempt at most, and
      // the draft is dropped if its conditions stop holding before it is sent.
      React.useEffect(() => {
        const state = auto.current
        const sessionId = props.sessionId
        if (state.done || !hasSessionId(sessionId) || view === undefined || view === null) return
        // The saved level at the cell's first render with a view; a change
        // (another tab, a typed command) stops the cell for this mount.
        if (state.baseline === null) state.baseline = confirmedText
        if (confirmedText !== state.baseline) {
          state.done = true
          return
        }
        if (view.mode !== 'manual' || locked || busy || pending || overdue || open) return
        // No draft or command of its own, and no router command queued or
        // running from this page, so the draft never waits behind one and
        // then overwrites a newer value.
        if (desired !== null || awaiting !== null || lock == null) return
        expireLock(lock)
        if (lock.current !== null) return
        if (confirmed.length === 0 || stale.length > 0) return
        const added = {}
        for (const key of confirmed) {
          if (effortFor(confirmedEfforts, key) !== undefined) continue
          const advertised = effortsFor(props.ctx, sessionId, keyRoute(key))
          // Efforts still unknown: wait for the directory, writing nothing.
          if (advertised.state === 'unknown') return
          const recommended = recommendedEffort(level, advertised)
          if (recommended !== undefined) added[key] = recommended
        }
        if (Object.keys(added).length === 0) return
        state.done = true
        if (!claimAutoEffort(autoEffortKey(sessionId, level))) return
        // The saved entries in order, their efforts kept, the recommendations added.
        const draft = { keys: confirmed, efforts: { ...confirmedEfforts, ...added } }
        const text = valueText(draft.keys, draft.efforts)
        state.draft = { text, from: confirmedText }
        sentDraft.current = null
        // A menu that closes before the next render still commits the draft.
        latest.current = { ...latest.current, desired: draft, desiredText: text }
        setDesired(draft)
      })

      // The effort rows are built once per opening, for every authorized model,
      // from the directory snapshot of that moment (null: no effort rows), with
      // the effort this level recommends; groups and rows are never added or
      // removed while the flyout is open, only shown or hidden.
      const openEfforts = React.useRef(null)
      // Per opening: the effort each model had when it was unchecked, which a
      // check in the same opening restores.
      const picks = React.useRef(null)
      if (!open) {
        openEfforts.current = null
        picks.current = null
      } else if (openEfforts.current === null) {
        const frozenRows = new Map()
        for (const key of authorizedSet) {
          const advertised = effortsFor(props.ctx, props.sessionId, keyRoute(key))
          const recommended = recommendedEffort(level, advertised)
          const own = [effortFor(currentEfforts, key), effortFor(confirmedEfforts, key)]
          frozenRows.set(key, { recommended, rows: effortRowsFor(advertised, own, recommended) })
        }
        openEfforts.current = frozenRows
        picks.current = new Map()
      }
      // Every edit makes a new draft from the one shown; it keeps efforts only
      // for its own entries, so an unchecked model drops its effort. Each one
      // is a choice and sets the marker first, so the automatic effort never
      // undoes it (such as a Default picked after it was applied).
      const edit = (change) => {
        if (hasSessionId(props.sessionId)) markAutoEffortChoice(autoEffortKey(props.sessionId, level))
        // The new draft is the user's, never the automatic one, whatever its text.
        auto.current.draft = null
        sentDraft.current = null
        const keys = change.keys ?? live
        const source = change.efforts ?? currentEfforts
        const efforts = {}
        for (const key of keys) {
          const effort = effortFor(source, key)
          if (effort !== undefined) efforts[key] = effort
        }
        setDesired({ keys, efforts })
      }
      // The effort of a model being checked: its pick from earlier in this
      // opening, else its saved effort when the level holds it, else (a model
      // that is not saved) the level's recommendation. Apart from the one
      // automatic draft above, nothing else applies a default.
      const checkedEffort = (key) => {
        if (picks.current?.has(key)) return picks.current.get(key)
        if (confirmed.includes(key)) return effortFor(confirmedEfforts, key)
        return openEfforts.current?.get(key)?.recommended
      }
      const remember = (keys) => {
        for (const key of keys) picks.current?.set(key, effortFor(currentEfforts, key))
      }
      const toggle = (key) => {
        if (locked) return
        if (live.includes(key)) {
          remember([key])
          edit({ keys: live.filter((item) => item !== key) })
        } else if (!authorizedSet.has(key)) edit({ keys: live })
        else if (!atCap) edit({ keys: [...live, key], efforts: withEffort(currentEfforts, key, checkedEffort(key)) })
      }
      const inherit = () => {
        if (locked) return
        remember(live)
        edit({ keys: [] })
      }
      // An effort row of a model that is not checked is disabled and sends nothing.
      const chooseEffort = (key, effort) => {
        if (locked || !live.includes(key)) return
        edit({ efforts: withEffort(currentEfforts, key, effort) })
      }
      const saving = awaiting !== null || (desired !== null && !open && desiredText !== confirmedText)

      // The elements of the model rows and effort groups, for the focus hand-off.
      const elements = React.useRef(null)
      if (elements.current === null) elements.current = { nodes: new Map(), refs: new Map() }
      const elementRef = (id) => {
        const { nodes, refs } = elements.current
        if (!refs.has(id)) refs.set(id, (node) => { if (node) nodes.set(id, node); else nodes.delete(id) })
        return refs.get(id)
      }
      // An effort group that holds focus when its model stops being checked (a
      // snap-back, another tab's change) stays shown for one render: the
      // effect below first moves focus to its model row, then hides it, so
      // focus never falls to the document, which would close the host menu.
      // A row whose model row cannot take focus is hidden on the next render.
      const handedOff = React.useRef(null)
      const [, setHandOff] = React.useState(0)
      const focused = open ? activeElement() : null
      let holding = null
      if (focused !== null && focused !== undefined) {
        for (const [id, node] of elements.current.nodes) {
          if (id.startsWith('efforts:') && typeof node?.contains === 'function' && node.contains(focused)) {
            holding = id.slice('efforts:'.length)
            break
          }
        }
      }
      if (holding === null) handedOff.current = null
      const keep = holding !== null && !live.includes(holding) && handedOff.current !== holding ? holding : null
      useLayoutEffect(() => {
        if (keep === null) return
        handedOff.current = keep
        elements.current.nodes.get(`model:${keep}`)?.focus?.()
        setHandOff((count) => count + 1)
      })

      const shownStale = current.filter((key) => !authorizedSet.has(key))
      const label = t(`level.${level}`)
      const first = live[0]
      const firstEffort = first === undefined ? undefined : effortFor(currentEfforts, first)
      const value = live.length === 0
        ? shownStale.length > 0
          ? `${t('level.inheritShort')} · ${shownStale.length} ${t('level.unavailableShort')}`
          : t('level.inheritShort')
        : shortModel(first)
      // The first entry's effort and the count of the others have spans of
      // their own, so the model name truncates first.
      const effortValue = firstEffort === undefined ? null : `· ${firstEffort}`
      const moreValue = live.length > 1 ? `+${live.length - 1}` : null
      const ariaLabel = live.length === 0 ? `${label}: ${value}` : [
        `${label}: ${live.length > 1 ? modelOf(first) : value}`,
        ...(firstEffort === undefined ? [] : [t('effort.cell').replace('%EFFORT%', () => firstEffort)]),
        ...(live.length > 1 ? [t('level.more').replace('%COUNT%', String(live.length - 1))] : []),
      ].join(', ')
      const title = `${t(`level.${level}.hint`)}\n${live.length === 0
        ? t('level.inherit')
        : live.map((key) => entryText(key, effortFor(currentEfforts, key))).join(', ')}`
      const flyoutId = `${anchor.slice(2)}-menu`

      // One model's effort group, right after its model row; hidden until the
      // model is checked.
      const effortGroup = (key) => {
        const frozen = openEfforts.current?.get(key)
        if (frozen === undefined || frozen.rows === null) return null
        const checked = live.includes(key)
        const effort = effortFor(currentEfforts, key)
        return h('div', {
          key: `efforts:${key}`,
          ref: elementRef(`efforts:${key}`),
          className: 'router-efforts',
          role: 'group',
          'aria-label': effortLabel(t, key),
          hidden: !checked && key !== keep,
        }, frozen.rows.map((row) => h(OptionRow, {
          key: row.effort === undefined ? 'default' : `effort:${row.effort}`,
          effort: true,
          role: 'menuitemradio',
          label: row.effort === undefined ? defaultLabel(t, row.name) : row.name,
          note: row.recommended ? t('effort.recommended') : undefined,
          warning: row.warning,
          title: row.effort,
          checked: checked && effort === row.effort,
          disabled: locked || !checked,
          onSelect: () => chooseEffort(key, row.effort),
        })))
      }

      const groups = []
      for (const key of keysOf(routes)) {
        const provider = providerOf(key)
        let group = groups.find((candidate) => candidate.provider === provider)
        if (group === undefined) {
          group = { provider, keys: [] }
          groups.push(group)
        }
        group.keys.push(key)
      }
      const noRoutes = !Array.isArray(routes)

      const flyout = open
        ? h(LevelFlyout, {
          id: flyoutId,
          anchor,
          label: t('level.menu').replace('%LEVEL%', label),
          describedBy: `${flyoutId}-hint`,
          cellRef,
          onClose: props.onClose,
        },
          h('div', { className: 'router-note', id: `${flyoutId}-hint` },
            live.length > 0 ? `${t(`level.${level}.hint`)} · ${t('level.count').replace('%COUNT%', String(live.length))}` : t(`level.${level}.hint`)),
          h(OptionRow, {
            label: t('level.inherit'),
            checked: live.length === 0,
            disabled: locked,
            onSelect: inherit,
          }),
          noRoutes && stale.length === 0 ? null : h('div', { className: 'router-separator', role: 'separator' }),
          noRoutes
            ? h('div', { className: 'router-note' }, t('level.noRoutes'))
            : groups.map((group) => h('div', { className: 'router-group', role: 'group', 'aria-label': group.provider, key: group.provider },
              h('div', { className: 'router-heading', 'aria-hidden': 'true' }, group.provider),
              group.keys.flatMap((key) => [
                h(OptionRow, {
                  key,
                  label: modelOf(key),
                  title: key,
                  checked: live.includes(key),
                  disabled: locked || (atCap && !live.includes(key)),
                  elementRef: elementRef(`model:${key}`),
                  onSelect: () => toggle(key),
                }),
                effortGroup(key),
              ]),
            )),
          stale.length > 0
            ? h('div', { className: 'router-group', role: 'group', 'aria-label': t('level.unavailableGroup') },
              h('div', { className: 'router-heading', 'aria-hidden': 'true' }, t('level.unavailableGroup')),
              // Rows stay mounted after removal so keyboard focus survives.
              stale.map((key) => h(OptionRow, {
                key, label: key, title: key, checked: current.includes(key), disabled: locked || !current.includes(key),
                onSelect: () => toggle(key),
              })))
            : null,
          atCap ? h('div', { className: 'router-note', role: 'status' }, t('level.cap')) : null,
        )
        : null

      return h(React.Fragment, null,
        h('button', {
          ref: cellRef,
          type: 'button',
          role: 'menuitem',
          className: 'router-cell',
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          'aria-controls': open ? flyoutId : undefined,
          'aria-busy': saving,
          'aria-label': ariaLabel,
          'data-inactive': view?.mode === 'manual' ? undefined : '',
          style: { '--router-anchor': anchor },
          title,
          onClick: () => {
            if (open) {
              cellRef.current?.focus()
              props.onClose()
            } else {
              props.onOpen()
            }
          },
          onKeyDown: (event) => {
            if (event.key === 'ArrowRight' && !open) {
              event.preventDefault()
              props.onOpen()
            }
          },
        },
          h('span', { className: 'router-cell-label' }, label),
          h('span', {
            className: 'router-cell-value',
            'data-warning': live.length === 0 && shownStale.length > 0 ? '' : undefined,
          }, value),
          effortValue === null ? null : h('span', { className: 'router-cell-effort' }, effortValue),
          moreValue === null ? null : h('span', { className: 'router-cell-more' }, moreValue),
          h('span', { className: 'router-chevron' }, saving ? spinnerIcon : chevronIcon),
        ),
        flyout,
      )
    }

    function RouterLevels(props) {
      const view = props.useProjection?.('router')
      const routes = props.useProjection?.('routerModelRoutes')
      const [openLevel, setOpenLevel] = React.useState(null)
      const lock = lockFor(props.sessionId)
      const [lockTick, setLockTick] = React.useState(0)
      // Cells that deferred to another command re-check the lock whenever a
      // turn ends, whoever queued it: the switch, a cell, or a closed menu.
      React.useEffect(() => {
        const wake = () => setLockTick((count) => count + 1)
        lock.listeners.add(wake)
        return () => { lock.listeners.delete(wake) }
      }, [lock])
      const t = props.t ?? ((key) => en[key] ?? key)
      const missing = view === undefined || view === null
      // A connection reset briefly clears the view; do not reopen a flyout
      // that the user did not reopen.
      React.useEffect(() => { if (missing && openLevel !== null) setOpenLevel(null) }, [missing, openLevel])
      // Called on every render path, before the early return, so the hook
      // order never changes; a cell reads the snapshot when its flyout opens.
      useDirectoryUpdates(props.ctx, props.sessionId)
      if (missing) return null
      return h(React.Fragment, null,
        h('style', null, styles),
        LEVELS.map((level) => h(LevelCell, {
          ...props,
          // A cell, with its draft, belongs to one session.
          key: `${props.sessionId ?? ''}:${level}`,
          t,
          level,
          view,
          routes,
          lock,
          lockTick,
          open: openLevel === level,
          onOpen: () => setOpenLevel(level),
          onClose: () => setOpenLevel((currentLevel) => currentLevel === level ? null : currentLevel),
        })),
      )
    }

    function apply(ctx) {
      const locale = ctx.get('locale')
      if (locale) ctx.effect(() => locale.register('router', { en, zh }), 'router: dictionaries')
      const t = locale ? locale.bind('router') : (key) => en[key] ?? key
      ctx.slots.inject('conversation.input.model.options', () => {
        ctx.slots.register(
          { name: 'conversation.input.model.options', id: 'router-option', order: 22 },
          function Option(props) { return h(RouterOption, { ...props, ctx, t }) },
        )
        ctx.slots.register(
          { name: 'conversation.input.model.options', id: 'router-levels', order: 23 },
          function Levels(props) { return h(RouterLevels, { ...props, ctx, t }) },
        )
      })
    }

    return { inject: ['slots'], apply }
  },
})
