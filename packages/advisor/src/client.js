window.__ModuleLoader__.load({
  id: 'dsh-plugin-advisor',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const useLayoutEffect = React.useLayoutEffect ?? React.useEffect
    const STALE_PENDING_MS = 5 * 60_000

    const en = {
      'chip.on': 'Advisor',
      'chip.enable': 'Enable advisor and verification for this session',
      'chip.disable': 'Disable advisor and verification for this session',
      'chip.pending': 'Updating…',
      'chip.about': 'About Advisor',
      'chip.unavailable': 'The command service is unavailable.',
      'chip.failed': 'Could not update Advisor.',
      'model.label': 'Verifier model',
      'model.inherit': 'Inherit',
      'model.unavailable': 'No explicit subagent routes are authorized in this session; Inherit only.',
      'model.staleOption': 'Saved route unavailable',
      'model.stale': 'The saved verifier route is unavailable. Select Inherit to reset it.',
      'model.failed': 'Could not update Verifier model.',
      'advisorModel.label': 'Advisor model',
      'advisorModel.failed': 'Could not update Advisor model.',
      'advisorModel.stale': 'The saved advisor route is unavailable. Select Inherit to reset it.',
      'chip.tooltip': 'A read-only advisor on the Advisor model plans and advises at major steps; a read-only verifier on the Verifier model checks its claims against the repository. Both are Advisor-owned and unaffected by Model router; Inherit uses normal subagent defaults. Session only.',
    }
    const zh = {
      'chip.on': 'Advisor',
      'chip.enable': '为此会话启用顾问和验证',
      'chip.disable': '为此会话禁用顾问和验证',
      'chip.pending': '正在更新…',
      'chip.about': '关于顾问',
      'chip.unavailable': '命令服务不可用。',
      'chip.failed': '无法更新顾问。',
      'model.label': '验证器模型',
      'model.inherit': '继承',
      'model.unavailable': '此会话没有已授权的显式子代理路由；只能继承。',
      'model.staleOption': '保存的路由不可用',
      'model.stale': '保存的验证器路由不可用。请选择“继承”以重置。',
      'model.failed': '无法更新验证器模型。',
      'advisorModel.label': '顾问模型',
      'advisorModel.failed': '无法更新顾问模型。',
      'advisorModel.stale': '保存的顾问路由不可用。请选择“继承”以重置。',
      'chip.tooltip': '只读顾问使用“顾问模型”在主要步骤进行规划和建议；只读验证器使用“验证器模型”对照代码库核实其声明。两者均由顾问独立管理，不受模型路由器影响；“继承”使用普通子代理默认值。仅此会话。',
    }

    // Rows, cell, and flyout copy the host model menu; theme tokens only.
    const styles = `
      .adv-row{border-radius:var(--dsw-radius-md);min-height:34px;color:var(--dsw-alias-label-primary);
        justify-content:space-between;align-items:center;gap:16px;padding:0 8px;
        font-size:13px;line-height:20px;display:flex;position:relative}
      .adv-label{align-items:center;gap:4px;min-width:0;display:inline-flex}
      .adv-info{z-index:1;width:20px;height:20px;color:var(--dsw-alias-label-caption);flex:none;padding:0;position:relative}
      .adv-row .adv-toggle{position:static}
      .adv-toggle:after{content:"";border-radius:var(--dsw-radius-md);position:absolute;inset:0}
      .adv-row:has(.adv-toggle:focus-visible){background:var(--dsw-alias-interactive-bg-hover)}
      @media (hover:hover){.adv-row:has(.adv-toggle:not(:disabled)):hover{background:var(--dsw-alias-interactive-bg-hover)}}
      .adv-error{color:var(--dsw-alias-state-error-primary);font-size:11px;margin-inline-start:6px}
      .adv-cell{box-sizing:border-box;display:flex;align-items:center;gap:6px;width:auto;min-width:100%;height:34px;
        padding:0 8px 0 20px;border:none;border-radius:var(--dsw-radius-md);background:transparent;
        color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;
        text-align:left;outline:none;anchor-name:var(--adv-anchor)}
      .adv-cell[data-inactive] .adv-cell-label{color:var(--dsw-alias-label-tertiary)}
      .adv-cell:focus-visible,.adv-cell[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}
      @media (hover:hover){.adv-cell:hover{background:var(--dsw-alias-interactive-bg-hover)}}
      .adv-cell-label{flex:0 0 auto;white-space:nowrap}
      .adv-cell-value{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        text-align:right;color:var(--dsw-alias-label-tertiary)}
      .adv-cell-value[data-warning]{color:var(--dsw-alias-state-warn-label)}
      .adv-chevron{display:grid;place-items:center;flex:0 0 12px;width:12px;height:12px;color:var(--dsw-alias-menu-icon)}
      .adv-chevron svg,.adv-check svg{display:block}
      .adv-spinner{color:var(--dsw-alias-label-tertiary)}
      .adv-spinner-motion{transform-origin:center;animation:adv-spin 1.5s linear infinite}
      .adv-spinner-track,.adv-spinner-arc{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
      .adv-spinner-track{opacity:.25}
      .adv-spinner-arc{stroke-dasharray:12 150;animation:adv-dash 1.5s ease-in-out infinite}
      @keyframes adv-spin{to{transform:rotate(360deg)}}
      @keyframes adv-dash{0%{stroke-dasharray:12 150;stroke-dashoffset:0}50%{stroke-dasharray:24 150;stroke-dashoffset:-6}to{stroke-dasharray:12 150;stroke-dashoffset:0}}
      @media (prefers-reduced-motion:reduce){.adv-spinner-motion,.adv-spinner-arc{animation:none}.adv-spinner-arc{stroke-dasharray:18 150;stroke-dashoffset:-3}}
      .adv-flyout{--adv-window-top:max(12px,var(--dsh-frame-overlay-top,12px));
        position:fixed;position-anchor:var(--adv-anchor);position-visibility:always;inset:auto;margin:0;
        top:max(var(--adv-window-top),min(anchor(top),calc(100dvh - 12px - var(--adv-flyout-height,0px))));
        left:calc(anchor(right) + 8px);position-try-fallbacks:--adv-flyout-left;
        z-index:1101;box-sizing:border-box;display:flex;flex-direction:column;
        width:max-content;min-width:min(220px,calc(100vw - 24px));max-width:min(340px,calc(100vw - 24px));
        max-height:min(360px,calc(100dvh - 12px - var(--adv-window-top)));overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;
        padding:4px;border:0;border-radius:var(--dsw-radius-lg);
        background:var(--dsw-menu-surface-fill);-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter);
        backdrop-filter:var(--dsw-menu-backdrop-filter);
        --dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);
        color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;-webkit-app-region:no-drag;
        --dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
      html[data-platform=darwin] .adv-flyout{background:linear-gradient(var(--dsw-menu-surface-fill),var(--dsw-menu-surface-fill)),var(--dsw-alias-bg-base)}
      @position-try --adv-flyout-left{left:auto;right:calc(anchor(left) + 8px)}
      .adv-option{box-sizing:border-box;display:flex;flex:none;align-items:center;gap:6px;width:auto;min-width:100%;
        min-height:34px;padding:5px 7px;border:none;border-radius:var(--dsw-radius-md);outline:none;
        background:transparent;color:inherit;font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer}
      .adv-option:focus-visible,.adv-option:focus{background:var(--dsw-alias-interactive-bg-hover)}
      .adv-option[aria-disabled=true]{opacity:.4;cursor:not-allowed}
      .adv-option-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .adv-check{display:grid;place-items:center;flex:0 0 14px;color:var(--dsw-alias-label-primary)}
      .adv-group+.adv-group{margin-top:3px}
      .adv-heading{padding:4px 7px 2px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-weight:500}
      .adv-separator{flex:none;height:.5px;margin:3px 8px;background:var(--dsw-alias-border-l2)}
      .adv-note{flex:none;padding:4px 7px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:normal}
    `

    const chevronIcon = h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
      h('path', { d: 'M6 12L9.29289 8.70711C9.68342 8.31658 9.68342 7.68342 9.29289 7.29289L6 4', stroke: 'currentColor', strokeWidth: 1 }))
    const checkIcon = h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
      h('path', { d: 'M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4', stroke: 'currentColor', strokeWidth: 1 }))
    const spinnerIcon = h('svg', { className: 'adv-spinner', width: 12, height: 12, viewBox: '0 0 24 24', 'aria-hidden': 'true' },
      h('g', { className: 'adv-spinner-motion' },
        h('circle', { className: 'adv-spinner-track', cx: 12, cy: 12, r: 9 }),
        h('circle', { className: 'adv-spinner-arc', cx: 12, cy: 12, r: 9 })))
    const supportsPopover = () => typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype
    const activeElement = () => typeof document === 'undefined' ? null : document.activeElement
    let anchorCounter = 0

    function freshPending(view) {
      if (view?.pending !== true) return false
      const since = view.pendingSince
      return typeof since !== 'number' || Date.now() - since < STALE_PENDING_MS
    }

    function useAnchorName() {
      const fallback = React.useRef(null)
      const reactId = typeof React.useId === 'function' ? React.useId() : null
      if (reactId !== null) return `--adv-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`
      if (fallback.current === null) fallback.current = `--adv-a${++anchorCounter}`
      return fallback.current
    }

    // Handler rejections arrive through the projection's failure record; an
    // error outcome here means the command line itself was not admitted.
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
        // The host menu announces failures in its composer toast; render
        // inline only when the slot supplies no such channel.
        if (typeof props.reportFailure === 'function') props.reportFailure(message)
        else if (mounted.current) setError(message)
      }
      const run = async (line, failureKey) => {
        setBusy(true)
        setError(null)
        try {
          const commandUi = props.ctx.get('commandUi')
          if (!commandUi?.execute) throw new Error(t('chip.unavailable'))
          const outcome = await commandUi.execute({ sessionId: props.sessionId }, line)
          if (outcome?.kind === 'error') throw new Error(t(failureKey))
          return true
        } catch (cause) {
          report(cause instanceof Error ? cause.message : String(cause))
          return false
        } finally {
          if (mounted.current) setBusy(false)
        }
      }
      return { busy, error, run, report }
    }

    function useFailureWatch(view, matches, onFailure) {
      const seen = React.useRef(view?.failure?.count ?? 0)
      const count = view?.failure?.count ?? 0
      React.useEffect(() => {
        if (count <= seen.current) return
        seen.current = count
        if (matches(view.failure)) onFailure(view.failure)
      }, [count])
    }

    function AdvisorOption(props) {
      const view = props.useProjection?.('advisor')
      const active = view?.active === true
      const pending = freshPending(view)
      const pendingHere = pending && view?.pendingTarget === 'advisor'
      const { busy, error, run, report } = useCommand(props)
      // The requested state while our command is unresolved; cleared once the
      // session reflects it so other tabs' failures are not reported here.
      const sent = React.useRef(null)
      const t = props.t ?? ((key) => en[key] ?? key)
      if (sent.current !== null && view?.active === sent.current && !pending) sent.current = null
      useFailureWatch(view, (failure) => failure.target === 'advisor' && sent.current !== null, () => {
        sent.current = null
        report(t('chip.failed'))
      })
      const info = primitives?.Tooltip && primitives?.Button
        ? h(primitives.Tooltip, {
          label: t('chip.tooltip'), side: 'top', delayMs: 300,
          maxWidth: 300, portal: true, openOnClick: true,
        },
          h(primitives.Button, {
            variant: 'ghost', size: 'sm', className: 'adv-info',
            'aria-label': t('chip.about'),
          }, primitives.IconInfoOutlineRegular ? h(primitives.IconInfoOutlineRegular, { size: 11, 'aria-hidden': 'true' }) : 'i'),
        )
        : null
      const switchProps = {
        className: 'adv-toggle',
        checked: active,
        // Disabling a focused switch blurs it and the host menu closes on that
        // blur, so in-flight states are guarded in onChange instead.
        disabled: props.locked,
        label: pendingHere ? `${t('chip.on')} — ${t('chip.pending')}` : active ? t('chip.disable') : t('chip.enable'),
        onChange: (enabled) => {
          if (busy || pending) return
          sent.current = enabled
          void run(enabled ? '/advisor on' : '/advisor off', 'chip.failed').then((ok) => { if (!ok) sent.current = null })
        },
      }
      return h(React.Fragment, null,
        h('style', null, styles),
        h('div', { className: 'adv-row', 'aria-busy': pending || busy },
          h('span', { className: 'adv-label' }, h('span', null, t('chip.on')), info),
          primitives?.Switch != null
            ? h(primitives.Switch, switchProps)
            : h('button', {
              type: 'button', role: 'switch', className: 'adv-toggle', 'aria-checked': active, 'aria-label': switchProps.label,
              disabled: switchProps.disabled, onClick: () => switchProps.onChange(!active),
            }),
        ),
        error ? h('span', { className: 'adv-error', role: 'alert' }, error) : null,
      )
    }

    function ModelFlyout(props) {
      const ref = React.useRef(null)
      const closeRef = React.useRef(null)
      // Hand focus to a surviving control before the focused row unmounts so
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
        const measure = () => { element.style.setProperty('--adv-flyout-height', `${element.offsetHeight}px`) }
        measure()
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
        observer?.observe(element)
        const target = element.querySelector('[role="menuitemradio"][aria-checked="true"]')
          ?? element.querySelector('[role="menuitemradio"]')
        target?.focus()
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
        const items = Array.from(ref.current?.querySelectorAll('[role="menuitemradio"]') ?? [])
        const index = items.indexOf(activeElement())
        const focusAt = (at) => { items[(at + items.length) % items.length]?.focus() }
        switch (event.key) {
          case 'ArrowDown': focusAt(index + 1); break
          case 'ArrowUp': focusAt(index < 0 ? -1 : index - 1); break
          case 'Home': focusAt(0); break
          case 'End': focusAt(-1); break
          // Tab settles on the focused choice, as in the host menu.
          case 'Tab':
            if (!event.shiftKey && index >= 0) items[index].click()
            else closeRef.current(props.cellRef.current ?? undefined)
            break
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
        className: 'adv-flyout',
        role: 'menu',
        'aria-label': props.label,
        'data-menu-material': 'translucent',
        popover: supportsPopover() ? 'manual' : undefined,
        style: { '--adv-anchor': props.anchor },
        onKeyDown,
        onMouseDown: (event) => {
          const surface = event.currentTarget
          // Leave presses on the flyout's own scrollbar to the browser.
          if (event.target === surface && event.nativeEvent?.offsetX >= surface.clientWidth) return
          if (!(event.target instanceof Element) || event.target.closest('button') === null) event.preventDefault()
        },
      }, props.children(closeRef))
    }

    function ModelRow(props) {
      return h('button', {
        type: 'button',
        role: 'menuitemradio',
        className: 'adv-option',
        'aria-checked': props.checked,
        'aria-disabled': props.disabled ? 'true' : undefined,
        title: props.title,
        onMouseMove: (event) => { if (activeElement() !== event.currentTarget) event.currentTarget.focus() },
        onClick: () => { if (!props.disabled) props.onSelect() },
      },
        h('span', { className: 'adv-option-label' }, props.label),
        h('span', { className: 'adv-check' }, props.checked ? checkIcon : null),
      )
    }

    const routeKey = (route) => `${route.provider}/${route.model}`

    // One cell plus single-choice flyout per Advisor-owned route setting:
    // Inherit, then the authorized routes; the saved value is a {provider, model}
    // field on the view, null meaning Inherit.
    const routeCell = (field, prefix, command) => ({
      labelKey: `${prefix}.label`,
      failedKey: `${prefix}.failed`,
      staleKey: `${prefix}.stale`,
      failureTarget: field,
      command,
      saved: (view) => view?.[field] ? routeKey(view[field]) : 'inherit',
    })
    const ADVISOR_MODEL_CELL = routeCell('advisorModel', 'advisorModel', '/advisor model')
    const VERIFIER_CELL = routeCell('verifierModel', 'model', '/advisor verifier-model')

    function RouteOption(props) {
      const config = props.config
      const view = props.useProjection?.('advisor')
      const routes = props.useProjection?.('advisorModelRoutes')
      const anchor = useAnchorName()
      const cellRef = React.useRef(null)
      const [open, setOpen] = React.useState(false)
      const [desired, setDesired] = React.useState(null)
      const { busy, run, report } = useCommand(props)
      const t = props.t ?? ((key) => en[key] ?? key)
      const pending = freshPending(view)
      const saved = config.saved(view)
      React.useEffect(() => { if (desired !== null && desired === saved) setDesired(null) }, [saved, desired])
      useFailureWatch(view, (failure) => failure.target === config.failureTarget && desired !== null, () => {
        setDesired(null)
        report(t(config.failedKey))
      })
      const missing = view === undefined || view === null
      // A connection reset briefly clears the view; do not reopen the flyout.
      React.useEffect(() => { if (missing && open) setOpen(false) }, [missing, open])
      if (missing) return null
      const authorized = Array.isArray(routes) ? routes.map(routeKey) : []
      const stale = saved !== 'inherit' && !authorized.includes(saved)
      const current = desired ?? saved
      const saving = desired !== null && desired !== saved
      const locked = props.locked === true || busy || pending
      const choose = (value, close) => {
        close.current(cellRef.current ?? undefined)
        if (locked || value === current) return
        setDesired(value)
        void run(`${config.command} ${value}`, config.failedKey).then((ok) => { if (!ok) setDesired(null) })
      }
      const groups = []
      for (const key of authorized) {
        const provider = key.slice(0, key.indexOf('/'))
        let group = groups.find((candidate) => candidate.provider === provider)
        if (group === undefined) {
          group = { provider, keys: [] }
          groups.push(group)
        }
        group.keys.push(key)
      }
      const showStale = stale && desired === null
      const value = current === 'inherit'
        ? t('model.inherit')
        : showStale ? t('model.staleOption') : current.slice(current.indexOf('/') + 1).split('/').pop()
      const flyoutId = `${anchor.slice(2)}-menu`
      return h(React.Fragment, null,
        h('style', null, styles),
        h('button', {
          ref: cellRef,
          type: 'button',
          role: 'menuitem',
          className: 'adv-cell',
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          'aria-controls': open ? flyoutId : undefined,
          'aria-busy': saving,
          'data-inactive': view.active === true ? undefined : '',
          style: { '--adv-anchor': anchor },
          title: current === 'inherit' ? t('model.inherit') : current,
          onClick: () => {
            if (open) {
              cellRef.current?.focus()
              setOpen(false)
            } else {
              setOpen(true)
            }
          },
          onKeyDown: (event) => {
            if (event.key === 'ArrowRight' && !open) {
              event.preventDefault()
              setOpen(true)
            }
          },
        },
          h('span', { className: 'adv-cell-label' }, t(config.labelKey)),
          h('span', { className: 'adv-cell-value', 'data-warning': showStale ? '' : undefined }, value),
          h('span', { className: 'adv-chevron' }, saving ? spinnerIcon : chevronIcon),
        ),
        open ? h(ModelFlyout, { id: flyoutId, anchor, label: t(config.labelKey), cellRef, onClose: () => setOpen(false) }, (close) => [
          showStale ? h('div', { key: 'stale', className: 'adv-note', role: 'status' }, t(config.staleKey)) : null,
          h(ModelRow, { key: 'inherit', label: t('model.inherit'), checked: current === 'inherit', disabled: locked, onSelect: () => choose('inherit', close) }),
          routes === null || routes === undefined ? null : h('div', { key: 'separator', className: 'adv-separator', role: 'separator' }),
          ...(routes === null || routes === undefined
            ? [h('div', { key: 'none', className: 'adv-note' }, t('model.unavailable'))]
            : groups.map((group) => h('div', { key: group.provider, className: 'adv-group', role: 'group', 'aria-label': group.provider },
              h('div', { className: 'adv-heading', 'aria-hidden': 'true' }, group.provider),
              group.keys.map((key) => h(ModelRow, {
                key, label: key.slice(key.indexOf('/') + 1), title: key, checked: current === key, disabled: locked,
                onSelect: () => choose(key, close),
              }))))),
        ]) : null,
      )
    }

    function apply(ctx) {
      const locale = ctx.get('locale')
      if (locale) ctx.effect(() => locale.register('advisor', { en, zh }), 'advisor: dictionaries')
      const t = locale ? locale.bind('advisor') : (key) => en[key] ?? key
      ctx.slots.inject('conversation.input.model.options', () => {
        ctx.slots.register(
          { name: 'conversation.input.model.options', id: 'advisor-option', order: 25 },
          function Option(props) { return h(AdvisorOption, { ...props, ctx, t }) },
        )
        ctx.slots.register(
          { name: 'conversation.input.model.options', id: 'advisor-model-option', order: 26 },
          function AdvisorModel(props) { return h(RouteOption, { ...props, ctx, t, config: ADVISOR_MODEL_CELL }) },
        )
        ctx.slots.register(
          { name: 'conversation.input.model.options', id: 'advisor-verifier-model-option', order: 27 },
          function VerifierModel(props) { return h(RouteOption, { ...props, ctx, t, config: VERIFIER_CELL }) },
        )
      })
    }

    return { inject: ['slots'], apply }
  },
})
