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
    const supportsPopover = () => typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype
    const activeElement = () => typeof document === 'undefined' ? null : document.activeElement
    let anchorCounter = 0
    // One in-flight router command per session from this page: the switch and
    // the three level cells share it, so they never collide with each other.
    const sessionLocks = new Map()
    const LOCK_EXPIRY_MS = 30_000
    const lockFor = (sessionId) => {
      const key = sessionId ?? ''
      if (!sessionLocks.has(key)) sessionLocks.set(key, { current: null })
      const lock = sessionLocks.get(key)
      // A command call that never settles must not block the controls forever.
      if (lock.current !== null && Date.now() - (lock.current.startedAt ?? 0) > LOCK_EXPIRY_MS) lock.current = null
      return lock
    }
    // Run one command under the session lock, after any command already in flight.
    const withLock = (lock, level, start) => {
      const entry = { level, startedAt: Date.now(), promise: null }
      const before = lock.current?.promise
      entry.promise = (before ? before.then(() => undefined, () => undefined) : Promise.resolve()).then(start).then((ok) => {
        if (lock.current === entry) lock.current = null
        return ok
      })
      lock.current = entry
      return entry.promise
    }

    // The view is pure; age the pending marker against this clock so a
    // command interrupted by a crash cannot block the controls forever.
    function freshPending(view) {
      if (view?.pending !== true) return false
      const since = view.pendingSince
      return typeof since !== 'number' || Date.now() - since < STALE_PENDING_MS
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
      const run = async (line, failureKey) => {
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
          report(cause instanceof Error ? cause.message : t(failureKey))
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
              if (busy || pending) return
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

    function OptionRow(props) {
      return h('button', {
        type: 'button',
        role: 'menuitemcheckbox',
        className: 'router-option',
        'aria-checked': props.checked,
        'aria-disabled': props.disabled ? 'true' : undefined,
        title: props.title,
        onMouseMove: (event) => { if (activeElement() !== event.currentTarget) event.currentTarget.focus() },
        onClick: () => { if (!props.disabled) props.onSelect() },
      },
        h('span', { className: 'router-option-label' }, props.label),
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
        const focusTarget = element.querySelector('[role="menuitemcheckbox"][aria-checked="true"]')
          ?? element.querySelector('[role="menuitemcheckbox"]')
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
        const items = Array.from(ref.current?.querySelectorAll('[role="menuitemcheckbox"]') ?? [])
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
      const [desired, setDesired] = React.useState(null)
      const [awaiting, setAwaiting] = React.useState(null)
      const confirmed = keysOf(view?.selections?.[level])
      const confirmedText = confirmed.join(',')
      const authorizedSet = new Set(keysOf(routes))
      const current = desired ?? confirmed
      const desiredText = desired === null ? null : desired.join(',')
      const pending = freshPending(view)
      const open = props.open === true

      useFailureWatch(view, (failure) => failure.target === 'level' && failure.level === level && awaiting !== null, (failure) => {
        setDesired(null)
        setAwaiting(null)
        report(failure.text || t('level.failed'))
      })

      // Edits are a draft while the flyout is open and are committed as one
      // command when it closes; levels share one lock so only one router
      // command is in flight from this menu at a time.
      const sentFrom = React.useRef({ from: null, settled: false })
      const send = (text) => withLock(lock, level, () => run(`/router level ${level} ${text === '' ? 'inherit' : text}`, 'level.failed'))
        .then((ok) => {
          props.onUnlock()
          return ok
        })
      React.useEffect(() => {
        if (desired === null) return
        if (desiredText === confirmedText && (awaiting === null || awaiting === desiredText)) {
          setDesired(null)
          setAwaiting(null)
          return
        }
        if (awaiting !== null && awaiting === desiredText) {
          // Sent and resolved, but the session moved to a third value (another
          // tab wrote this level): show the session's value without a toast.
          if (sentFrom.current.settled && confirmedText !== sentFrom.current.from) {
            setDesired(null)
            setAwaiting(null)
          }
          return
        }
        if (open || busy || pending) return
        if (lock.current !== null && lock.current.level !== level) return
        sentFrom.current = { from: confirmedText, settled: false }
        setAwaiting(desiredText)
        void send(desiredText).then((ok) => {
          if (ok) sentFrom.current.settled = true
          if (!mounted.current) return
          if (!ok) {
            setDesired(null)
            setAwaiting(null)
          }
        })
      }, [desiredText, confirmedText, busy, pending, awaiting, open, props.lockTick])
      React.useEffect(() => {
        if (desired === null && awaiting !== null && awaiting === confirmedText) setAwaiting(null)
      }, [confirmedText, desired, awaiting])

      // A draft still open when the host menu closes is committed on unmount,
      // after any command this menu already has in flight.
      const latest = React.useRef(null)
      latest.current = { desiredText, confirmedText, awaiting }
      React.useEffect(() => () => {
        const state = latest.current
        if (state === null || state.desiredText === null || state.desiredText === state.confirmedText) return
        if (state.awaiting === state.desiredText) return
        void send(state.desiredText)
      }, [])

      const locked = props.locked === true
      const live = current.filter((key) => authorizedSet.has(key))
      const stale = confirmed.filter((key) => !authorizedSet.has(key))
      const atCap = live.length >= MAX_MODELS
      const toggle = (key) => {
        if (locked) return
        if (live.includes(key)) setDesired(live.filter((item) => item !== key))
        else if (!authorizedSet.has(key)) setDesired(live)
        else if (!atCap) setDesired([...live, key])
      }
      const inherit = () => { if (!locked) setDesired([]) }
      const saving = awaiting !== null || (desired !== null && !open && desiredText !== confirmedText)

      const shownStale = current.filter((key) => !authorizedSet.has(key))
      const label = t(`level.${level}`)
      const value = live.length === 0
        ? shownStale.length > 0
          ? `${t('level.inheritShort')} · ${shownStale.length} ${t('level.unavailableShort')}`
          : t('level.inheritShort')
        : `${shortModel(live[0])}${live.length > 1 ? ` +${live.length - 1}` : ''}`
      const valueLabel = live.length > 1
        ? `${modelOf(live[0])}, ${t('level.more').replace('%COUNT%', String(live.length - 1))}`
        : undefined
      const title = `${t(`level.${level}.hint`)}\n${live.length === 0 ? t('level.inherit') : live.join(', ')}`
      const flyoutId = `${anchor.slice(2)}-menu`

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
              group.keys.map((key) => h(OptionRow, {
                key,
                label: modelOf(key),
                title: key,
                checked: live.includes(key),
                disabled: locked || (atCap && !live.includes(key)),
                onSelect: () => toggle(key),
              })),
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
          'aria-label': `${label}: ${valueLabel ?? value}`,
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
      const t = props.t ?? ((key) => en[key] ?? key)
      const missing = view === undefined || view === null
      // A connection reset briefly clears the view; do not reopen a flyout
      // that the user did not reopen.
      React.useEffect(() => { if (missing && openLevel !== null) setOpenLevel(null) }, [missing, openLevel])
      if (missing) return null
      return h(React.Fragment, null,
        h('style', null, styles),
        LEVELS.map((level) => h(LevelCell, {
          ...props,
          key: level,
          t,
          level,
          view,
          routes,
          lock,
          lockTick,
          onUnlock: () => setLockTick((count) => count + 1),
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
