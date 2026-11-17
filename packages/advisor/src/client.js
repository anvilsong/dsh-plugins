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
      'effort.label': 'Effort',
      'effort.labelFor': 'Effort for {model}',
      'effort.default': 'Default',
      'effort.defaultNamed': 'Default ({effort})',
      'effort.recommended': 'recommended',
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
      // The host model menu's own words: 推理等级, and Default kept as is.
      'effort.label': '推理等级',
      'effort.labelFor': '{model} 的推理等级',
      'effort.default': 'Default',
      'effort.defaultNamed': 'Default（{effort}）',
      'effort.recommended': '推荐',
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
      .adv-cell-value[data-effort]{display:flex;justify-content:flex-end}
      .adv-cell-model{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .adv-cell-effort{flex:none;white-space:pre}
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
      .adv-option[data-warning] .adv-option-label{color:var(--dsw-alias-state-warn-label)}
      .adv-option-note{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
      .adv-efforts{display:flex;flex:none;flex-direction:column}
      .adv-option-effort{padding-inline-start:23px}
      .adv-option-effort .adv-option-label{color:var(--dsw-alias-label-secondary)}
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
          if (outcome?.kind === 'error') throw new Error(outcome.text || t(failureKey))
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
      useFailureWatch(view, (failure) => failure.target === 'advisor' && sent.current !== null, (failure) => {
        sent.current = null
        report(failure.text || t('chip.failed'))
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

    // A model row, or with `effort` an indented effort row (same look; an
    // optional right-aligned note such as "recommended" comes before the check).
    function ModelRow(props) {
      return h('button', {
        type: 'button',
        role: 'menuitemradio',
        className: props.effort ? 'adv-option adv-option-effort' : 'adv-option',
        'aria-checked': props.checked,
        'aria-disabled': props.disabled ? 'true' : undefined,
        'data-warning': props.warning ? '' : undefined,
        title: props.title,
        onMouseMove: (event) => { if (activeElement() !== event.currentTarget) event.currentTarget.focus() },
        onClick: () => { if (!props.disabled) props.onSelect() },
      },
        h('span', { className: 'adv-option-label' }, props.label),
        ...(props.note ? [h('span', { className: 'adv-option-note' }, props.note)] : []),
        h('span', { className: 'adv-check' }, props.checked ? checkIcon : null),
      )
    }

    const routeKey = (route) => `${route.provider}/${route.model}`
    /** The route of an authorized `provider/model` key; provider ids hold no slash. */
    const keyRoute = (key) => ({ provider: key.slice(0, key.indexOf('/')), model: key.slice(key.indexOf('/') + 1) })
    const INHERIT = 'inherit'

    /**
     * A cell setting is `{ key, effort }`: key `inherit` or an authorized
     * `provider/model`, effort an id or undefined (Default). Its text is the
     * command argument and the cell title, in the Host's routeLabel format.
     */
    const settingText = (setting) => setting.effort === undefined ? setting.key : `${setting.key} effort=${setting.effort}`
    function savedSetting(route) {
      if (route === null || route === undefined) return { key: INHERIT, effort: undefined }
      const effort = typeof route.effort === 'string' && route.effort !== '' ? route.effort : undefined
      return { key: routeKey(route), effort }
    }

    /**
     * The session's ModelDirectory store, or undefined when the service is
     * absent, the session has no directory, or anything throws. A lazy
     * `ctx.get`, never an inject entry: a missing inject would leave the whole
     * client entry pending and break web boot (the usage plugin does the same).
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
     * is usable). Ids a command token cannot carry (empty or with whitespace)
     * and repeats are skipped; a missing name shows the id.
     * `defaultEffort` is the model's own default, only when it is one of the
     * listed efforts. Never throws.
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
          if (typeof id !== 'string' || id === '' || /\s/.test(id) || efforts.some((listed) => listed.id === id)) continue
          const name = typeof effort.name === 'string' && effort.name.trim() !== '' ? effort.name : id
          efforts.push({ id, name })
        }
        // Entries that are all unusable say nothing about the model: unknown,
        // so no default is named and a saved effort shows without a warning.
        if (efforts.length === 0 && advertised.length > 0) return unknown
        const defaultId = model.reasoning.defaultEffort
        const defaultEffort = typeof defaultId === 'string' ? efforts.find((listed) => listed.id === defaultId) : undefined
        return { state: efforts.length === 0 ? 'none' : 'list', efforts, ...(defaultEffort === undefined ? {} : { defaultEffort }) }
      } catch {
        return unknown
      }
    }

    /**
     * The Advisor model's recommended effort: the highest advertised one
     * whose id is neither `max` (the planner runs under a 30-minute and
     * 150-tool-call cap) nor `off` (no reasoning at all), as the router's
     * Hard judgment level picks; undefined (Default) when there is none.
     */
    function recommendedAdvisorEffort(advertised) {
      for (let index = advertised.efforts.length - 1; index >= 0; index--) {
        const id = advertised.efforts[index].id
        if (id !== 'max' && id !== 'off') return id
      }
      return undefined
    }

    /**
     * The Effort group rows for one model: Default, the advertised efforts in
     * order, then a saved id the model does not advertise, with a warning
     * unless the list is unknown. Null (no group) without a list and without
     * a saved effort. `recommended` marks one row; undefined marks Default.
     * The Default row carries `defaultName`, the model's real default effort,
     * when the directory advertises it. When the recommended effort is that
     * default, its own row carries the mark and Default only names it.
     */
    function effortRows(advertised, savedEffort, recommended) {
      if (advertised.state !== 'list' && savedEffort === undefined) return null
      const rows = [{ effort: undefined, name: undefined, defaultName: advertised.defaultEffort?.name, warning: false }]
      for (const effort of advertised.efforts) rows.push({ effort: effort.id, name: effort.name, warning: false })
      if (savedEffort !== undefined && !advertised.efforts.some((effort) => effort.id === savedEffort)) {
        rows.push({ effort: savedEffort, name: savedEffort, warning: advertised.state !== 'unknown' })
      }
      return rows.map((row) => ({ ...row, recommended: row.effort === recommended }))
    }

    /** The Default row's text: `Default (<effort name>)` when the name is known. */
    function defaultLabel(t, name) {
      if (name === undefined) return t('effort.default')
      const pattern = t('effort.defaultNamed')
      return pattern.includes('{effort}') ? pattern.replace('{effort}', () => name) : `${t('effort.default')} (${name})`
    }

    /**
     * The Effort group's label, naming the model the group was built for (its
     * id as its model row shows it): `Effort for <model>`.
     */
    function effortLabel(t, key) {
      const model = key.slice(key.indexOf('/') + 1)
      const pattern = t('effort.labelFor')
      return pattern.includes('{model}') ? pattern.replace('{model}', () => model) : `${t('effort.label')} · ${model}`
    }

    /**
     * The model keys an open flyout shows: the authorized ones, plus `key`
     * once it has left them, where it stood in `opened` (the authorized keys
     * as the flyout opened): after the nearest earlier one still authorized,
     * else first. Its row and the Effort rows under it so keep their parent
     * and their order among the other rows, and React keeps their DOM nodes.
     */
    function keepInPlace(authorized, opened, key) {
      for (let index = opened.indexOf(key) - 1; index >= 0; index--) {
        const at = authorized.indexOf(opened[index])
        if (at >= 0) return [...authorized.slice(0, at + 1), key, ...authorized.slice(at + 1)]
      }
      return [key, ...authorized]
    }

    /**
     * Re-render when the session's model directory changes (the catalog loads
     * or refreshes). RouteOption calls it on every render path, before its
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

    /**
     * The once-marker of a cell's automatic effort, in localStorage: one key
     * per session and cell, never per model, so a choice in the cell keeps
     * every model of that session from it.
     */
    const autoEffortKey = (sessionId, field) => `dsh.autoEffort.v1:advisor:${sessionId}:${field}`

    /**
     * Claims the marker before the automatic send: true only when the key is
     * absent and then reads back as written. No storage, or any throw (a
     * blocked storage throws on access), is false, so nothing is sent; no
     * memory or cookie stands in for the storage.
     */
    function claimAutoEffort(key) {
      try {
        if (typeof localStorage === 'undefined' || localStorage.getItem(key) !== null) return false
        localStorage.setItem(key, 'auto')
        return localStorage.getItem(key) === 'auto'
      } catch {
        return false
      }
    }

    /** Writes the marker for a choice made in the cell; a failing storage is ignored. */
    function markChoice(key) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(key, 'user')
      } catch { /* the choice still ends this opening's attempt */ }
    }

    /**
     * The cell's one automatic recommended effort (`config.autoEffort`): a
     * saved model without an effort gets the effort a pick of that model
     * adds. RouteOption calls it on every render path, before its early
     * return. It sends only when all of these hold in one render: a session
     * id; the view; Advisor on; the cell not locked (props.locked, busy, or
     * pending), without an unconfirmed setting of its own, and its flyout
     * closed; a saved model, not Inherit, without an effort, whose text is
     * that of the cell's first render with a view (a change ends the
     * attempt); the route authorized; the directory listing the model's
     * efforts (unknown waits for an update and writes nothing); a
     * recommendation; the model not refused; and the marker claimed. One
     * attempt per mount, spent by the claim or by a choice in the cell; no
     * retry and no timer. Returns the attempt, for choose to end.
     */
    function useAutoEffort(config, cell) {
      // `first`: the saved text at the first render with a view.
      const attempt = React.useRef({ first: undefined, done: false })
      React.useEffect(() => {
        const state = attempt.current
        const { view, saved, sessionId } = cell
        if (config.autoEffort !== true || state.done || view === undefined || view === null) return
        if (state.first === undefined) {
          state.first = cell.savedText
        } else if (cell.savedText !== state.first) {
          state.done = true
          return
        }
        if (typeof sessionId !== 'string' || sessionId === '') return
        if (view.active !== true || cell.locked || cell.desired !== null || cell.open) return
        if (saved.key === INHERIT || saved.effort !== undefined || !cell.authorized.includes(saved.key)) return
        const advertised = effortsFor(cell.ctx, sessionId, keyRoute(saved.key))
        if (advertised.state !== 'list') return
        const effort = config.recommend(advertised)
        if (effort === undefined || cell.refused.has(saved.key)) return
        state.done = true
        if (claimAutoEffort(autoEffortKey(sessionId, config.field))) cell.send({ key: saved.key, effort, auto: true })
      })
      return attempt
    }

    // One cell plus single-choice flyout per Advisor-owned route setting:
    // Inherit, the authorized routes, then the current model's efforts. The
    // saved value is a {provider, model, effort?} field on the view, null
    // meaning Inherit. `recommend` gives the effort that a pick of another
    // model adds; undefined is Default (no token). `autoEffort` also applies
    // it once to a saved model without an effort (useAutoEffort).
    const routeCell = (field, prefix, command, recommend, autoEffort = false) => ({
      labelKey: `${prefix}.label`,
      failedKey: `${prefix}.failed`,
      staleKey: `${prefix}.stale`,
      failureTarget: field,
      field,
      command,
      recommend,
      autoEffort,
      saved: (view) => savedSetting(view?.[field]),
    })
    const ADVISOR_MODEL_CELL = routeCell('advisorModel', 'advisorModel', '/advisor model', recommendedAdvisorEffort, true)
    // Its recommendation is Default, so it has nothing to apply by itself.
    const VERIFIER_CELL = routeCell('verifierModel', 'model', '/advisor verifier-model', () => undefined)

    function RouteOption(props) {
      const config = props.config
      const view = props.useProjection?.('advisor')
      const routes = props.useProjection?.('advisorModelRoutes')
      const anchor = useAnchorName()
      const cellRef = React.useRef(null)
      const [open, setOpen] = React.useState(false)
      // The setting this cell sent that the session does not show yet.
      const [desired, setDesired] = React.useState(null)
      const { busy, run, report } = useCommand(props)
      useDirectoryUpdates(props.ctx, props.sessionId)
      // The Effort group as built when the flyout opened (null: no group),
      // undefined while it is closed: a row that comes or goes while it is
      // open can drop focus to the document, which closes the host menu.
      const openEfforts = React.useRef(undefined)
      // Models whose automatically added effort met a refusal (any failure of
      // this setting while that pick was unconfirmed, whatever its cause):
      // their next picks go without it. No retry, no matching of the Host's
      // text. Only an effort for that model in the saved setting lifts it.
      const refused = React.useRef(null)
      if (refused.current === null) refused.current = new Set()
      const t = props.t ?? ((key) => en[key] ?? key)
      const pending = freshPending(view)
      const saved = config.saved(view)
      if (saved.effort !== undefined) refused.current.delete(saved.key)
      const savedText = settingText(saved)
      const desiredText = desired === null ? null : settingText(desired)
      React.useEffect(() => { if (desiredText !== null && desiredText === savedText) setDesired(null) }, [savedText, desiredText])
      useFailureWatch(view, (failure) => failure.target === config.failureTarget && desired !== null, (failure) => {
        if (desired?.auto === true) refused.current.add(desired.key)
        setDesired(null)
        report(failure.text || t(config.failedKey))
      })
      const missing = view === undefined || view === null
      // A connection reset briefly clears the view; do not reopen the flyout.
      React.useEffect(() => { if (missing && open) setOpen(false) }, [missing, open])
      const authorized = Array.isArray(routes) ? routes.map(routeKey) : []
      const locked = props.locked === true || busy || pending
      // Sends one setting of this cell; `auto` marks an effort the menu
      // added, whose refusal drops it from that model's next picks.
      const send = (next) => {
        setDesired(next)
        void run(`${config.command} ${settingText(next)}`, config.failedKey).then((ok) => {
          if (ok) return
          if (next.auto === true) refused.current.add(next.key)
          setDesired(null)
        })
      }
      const automatic = useAutoEffort(config, {
        ctx: props.ctx, sessionId: props.sessionId, view, saved, savedText, authorized,
        locked, desired, open, refused: refused.current, send,
      })
      if (missing) return null
      const stale = saved.key !== INHERIT && !authorized.includes(saved.key)
      const current = desired ?? saved
      const currentText = settingText(current)
      const saving = desired !== null && desiredText !== savedText
      const choose = (next, close) => {
        close.current(cellRef.current ?? undefined)
        if (locked || settingText(next) === currentText) return
        // A choice that sends ends the automatic effort: for this opening,
        // and through the session's marker, written first, for later ones.
        if (config.autoEffort === true) {
          automatic.current.done = true
          if (typeof props.sessionId === 'string' && props.sessionId !== '') markChoice(autoEffortKey(props.sessionId, config.field))
        }
        send(next)
      }
      // The current model's row sends nothing, so an effort set by command
      // survives, and the saved model's row restores the saved setting as it
      // is: a row never applies a default to a saved route (only
      // useAutoEffort does, once). Another model gets the cell's recommended
      // effort, read from the directory at the pick.
      const chooseModel = (key, close) => {
        // A row kept after its route left the list sends nothing either.
        if (key === current.key || !authorized.includes(key)) {
          close.current(cellRef.current ?? undefined)
          return
        }
        if (key === saved.key) {
          choose(saved, close)
          return
        }
        const effort = refused.current.has(key) ? undefined : config.recommend(effortsFor(props.ctx, props.sessionId, keyRoute(key)))
        choose({ key, effort, auto: effort !== undefined }, close)
      }
      const showStale = stale && desired === null
      if (!open) {
        openEfforts.current = undefined
      } else if (openEfforts.current === undefined) {
        // Built once per opening, for the current model; none for Inherit or
        // a stale route. `keys`: the authorized keys as it opened.
        const advertised = current.key === INHERIT || !authorized.includes(current.key)
          ? null
          : effortsFor(props.ctx, props.sessionId, keyRoute(current.key))
        const rows = advertised === null ? null : effortRows(advertised, current.effort, config.recommend(advertised))
        openEfforts.current = rows === null ? null : { key: current.key, rows, keys: authorized }
      }
      const efforts = open ? openEfforts.current : null
      // The group keeps the model it was built for and is labelled with it. If
      // the cell's model changes while the flyout is open (a pending pick
      // refused, another tab's save, the route no longer authorized), its
      // rows stay mounted, in place under that model's row, but disabled,
      // and send nothing: a pick there would switch the setting to the
      // group's model. That row stays too, disabled, if its route leaves the
      // list (keepInPlace). The next opening shows the new model's group.
      const effortsLive = efforts !== null && current.key === efforts.key && authorized.includes(efforts.key)
      const shown = efforts === null || authorized.includes(efforts.key) ? authorized : keepInPlace(authorized, efforts.keys, efforts.key)
      const groups = []
      for (const key of shown) {
        const provider = key.slice(0, key.indexOf('/'))
        let group = groups.find((candidate) => candidate.provider === provider)
        if (group === undefined) {
          group = { provider, keys: [] }
          groups.push(group)
        }
        group.keys.push(key)
      }
      const listed = routes !== null && routes !== undefined
      const chooseEffort = (effort, close) => {
        if (effortsLive) choose({ key: efforts.key, effort }, close)
        else close.current(cellRef.current ?? undefined)
      }
      const effortTitle = efforts === null ? null : effortLabel(t, efforts.key)
      const value = current.key === INHERIT
        ? t('model.inherit')
        : showStale ? t('model.staleOption') : current.key.slice(current.key.indexOf('/') + 1).split('/').pop()
      const valueEffort = current.key === INHERIT || showStale ? undefined : current.effort
      const flyoutId = `${anchor.slice(2)}-menu`
      // The current model's Effort group, right after that model's row: radio
      // rows in a group of their own, which the flyout's key handler covers.
      const effortGroup = (close) => h('div', { key: 'effort', className: 'adv-efforts', role: 'group', 'aria-label': effortTitle },
        efforts.rows.map((row) => h(ModelRow, {
          key: row.effort === undefined ? 'default' : `effort:${row.effort}`,
          effort: true,
          label: row.effort === undefined ? defaultLabel(t, row.defaultName) : row.name,
          title: row.effort,
          note: row.recommended ? t('effort.recommended') : undefined,
          warning: row.warning,
          checked: current.key === efforts.key && current.effort === row.effort,
          disabled: locked || !effortsLive,
          onSelect: () => chooseEffort(row.effort, close),
        })))
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
          title: current.key === INHERIT ? t('model.inherit') : currentText,
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
          h('span', {
            className: 'adv-cell-value',
            'data-warning': showStale ? '' : undefined,
            'data-effort': valueEffort === undefined ? undefined : '',
          }, ...(valueEffort === undefined
            ? [value]
            // The effort keeps its own span, so the model name truncates first.
            : [h('span', { className: 'adv-cell-model' }, value), h('span', { className: 'adv-cell-effort' }, ` · ${valueEffort}`)])),
          h('span', { className: 'adv-chevron' }, saving ? spinnerIcon : chevronIcon),
        ),
        open ? h(ModelFlyout, { id: flyoutId, anchor, label: t(config.labelKey), cellRef, onClose: () => setOpen(false) }, (close) => [
          showStale ? h('div', { key: 'stale', className: 'adv-note', role: 'status' }, t(config.staleKey)) : null,
          h(ModelRow, {
            key: 'inherit', label: t('model.inherit'), checked: current.key === INHERIT, disabled: locked,
            onSelect: () => choose({ key: INHERIT, effort: undefined }, close),
          }),
          listed || groups.length > 0 ? h('div', { key: 'separator', className: 'adv-separator', role: 'separator' }) : null,
          ...groups.map((group) => h('div', { key: group.provider, className: 'adv-group', role: 'group', 'aria-label': group.provider },
            h('div', { className: 'adv-heading', 'aria-hidden': 'true' }, group.provider),
            group.keys.flatMap((key) => {
              // Only the group's model can be shown without being authorized
              // (keepInPlace): disabled and in the warning colour.
              const gone = !authorized.includes(key)
              return [
                h(ModelRow, {
                  key, label: key.slice(key.indexOf('/') + 1), title: key, checked: current.key === key,
                  disabled: locked || gone, warning: gone,
                  onSelect: () => chooseModel(key, close),
                }),
                // Right after the model it belongs to; none for any other.
                efforts !== null && efforts.key === key ? effortGroup(close) : null,
              ]
            }))),
          listed ? null : h('div', { key: 'none', className: 'adv-note' }, t('model.unavailable')),
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
