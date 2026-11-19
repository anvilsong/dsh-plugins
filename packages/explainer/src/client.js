window.__ModuleLoader__.load({
  id: 'dsh-plugin-explainer',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const STALE_PENDING_MS = 5 * 60_000
    // A command that never settles stops holding the switch after this long.
    const COMMAND_DEADLINE_MS = 30_000

    const en = {
      'chip.label': 'Explainer style',
      'chip.hint': 'Plain explanations: short prose, text diagrams, offered pages.',
      'chip.pending': 'Updating…',
      'chip.unavailable': 'The command service is unavailable.',
      'chip.failed': 'Could not update Explainer style.',
    }
    const zh = {
      'chip.label': '讲解风格',
      'chip.hint': '通俗讲解：简短文字、文本图示、可选页面。',
      'chip.pending': '正在更新…',
      'chip.unavailable': '命令服务不可用。',
      'chip.failed': '无法更新讲解风格。',
    }

    // The row copies the host model menu's switch rows (the same rules as the
    // Ultracode and Router rows); theme tokens only.
    const styles = `
      .ex-row{border-radius:var(--dsw-radius-md);min-height:34px;color:var(--dsw-alias-label-primary);
        justify-content:space-between;align-items:center;gap:16px;padding:0 8px;
        font-size:13px;line-height:20px;display:flex;position:relative}
      .ex-label{align-items:center;min-width:0;display:inline-flex}
      .ex-end{align-items:center;gap:8px;flex:none;display:inline-flex}
      .ex-row .ex-toggle{position:static}
      .ex-toggle:after{content:"";border-radius:var(--dsw-radius-md);position:absolute;inset:0}
      .ex-row:has(.ex-toggle:focus-visible){background:var(--dsw-alias-interactive-bg-hover)}
      @media (hover:hover){.ex-row:has(.ex-toggle:not(:disabled)):hover{background:var(--dsw-alias-interactive-bg-hover)}}
      .ex-error{color:var(--dsw-alias-state-error-primary);font-size:11px;margin-inline-start:6px}
      .ex-spinner{color:var(--dsw-alias-label-tertiary);display:grid;place-items:center;pointer-events:none}
      .ex-spinner-motion{transform-origin:center;animation:ex-spin 1.5s linear infinite}
      .ex-spinner-track,.ex-spinner-arc{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
      .ex-spinner-track{opacity:.25}
      .ex-spinner-arc{stroke-dasharray:12 150;animation:ex-dash 1.5s ease-in-out infinite}
      @keyframes ex-spin{to{transform:rotate(360deg)}}
      @keyframes ex-dash{0%{stroke-dasharray:12 150;stroke-dashoffset:0}50%{stroke-dasharray:24 150;stroke-dashoffset:-6}to{stroke-dasharray:12 150;stroke-dashoffset:0}}
      @media (prefers-reduced-motion:reduce){.ex-spinner-motion,.ex-spinner-arc{animation:none}.ex-spinner-arc{stroke-dasharray:18 150;stroke-dashoffset:-3}}
    `

    const spinnerIcon = h('svg', { className: 'ex-spinner', width: 12, height: 12, viewBox: '0 0 24 24', 'aria-hidden': 'true' },
      h('g', { className: 'ex-spinner-motion' },
        h('circle', { className: 'ex-spinner-track', cx: 12, cy: 12, r: 9 }),
        h('circle', { className: 'ex-spinner-arc', cx: 12, cy: 12, r: 9 })))

    // The view is pure; age the pending marker against this clock so a
    // command interrupted by a crash cannot block the switch forever.
    function freshPending(view) {
      if (view?.pending !== true) return false
      const since = view.pendingSince
      return typeof since !== 'number' || Date.now() - since < STALE_PENDING_MS
    }

    // One explainer command at a time per session from this page, also across
    // a menu that closes and opens again. There is no timer: the entry is
    // judged against the clock whenever it is used or rendered.
    const inFlight = new Map()
    const flightKey = (sessionId) => sessionId ?? ''
    const inFlightNow = (sessionId) => {
      const call = inFlight.get(flightKey(sessionId))
      return call !== undefined && Date.now() - call.startedAt < COMMAND_DEADLINE_MS
    }

    // Handler rejections arrive through the projection's failure record; an
    // error outcome here means the command line itself was not admitted.
    function useCommand(props) {
      // Only a trigger to render again when a call starts or settles.
      const [, setBusy] = React.useState(false)
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
      const run = async (line, record) => {
        const key = flightKey(props.sessionId)
        const call = { startedAt: Date.now() }
        inFlight.set(key, call)
        // A report once per press, whether the outcome or the projection tells it first.
        const fail = (message) => {
          if (record.reported) return
          record.reported = true
          report(message)
        }
        record.fail = fail
        if (mounted.current) {
          setBusy(true)
          setError(null)
        }
        try {
          const commandUi = props.ctx.get('commandUi')
          if (!commandUi?.execute) throw new Error(t('chip.unavailable'))
          const outcome = await commandUi.execute({ sessionId: props.sessionId }, line)
          if (outcome?.kind === 'error') throw new Error(outcome.text || t('chip.failed'))
          return true
        } catch (cause) {
          fail(typeof cause?.message === 'string' && cause.message !== '' ? cause.message : t('chip.failed'))
          return false
        } finally {
          // A newer call may have started once this one passed the deadline;
          // then this late settle leaves the newer call's state alone.
          if (inFlight.get(key) === call) {
            inFlight.delete(key)
            if (mounted.current) setBusy(false)
          }
        }
      }
      return { error, run }
    }

    // Report a projection failure once, and only for the press that sent it.
    function useFailureWatch(view, matches, onFailure) {
      const seen = React.useRef(view?.failure?.count ?? 0)
      const count = view?.failure?.count ?? 0
      React.useEffect(() => {
        if (count <= seen.current) return
        seen.current = count
        if (matches(view.failure)) onFailure(view.failure)
      }, [count])
    }

    function ExplainerOption(props) {
      const view = props.useProjection?.('explainer')
      const active = view?.on === true
      const pending = freshPending(view)
      const { error, run } = useCommand(props)
      // The press while our command is unresolved: the state it asked for, when
      // it started, and whether its failure was reported. Cleared once the
      // session shows that state, so failures from other tabs are not ours.
      const sent = React.useRef(null)
      // What the last render saw. A press judges these against the clock when
      // it happens, not against the render that made its handler.
      const latest = React.useRef(null)
      latest.current = { view, locked: props.locked }
      const t = props.t ?? ((key) => en[key] ?? key)
      if (sent.current !== null && view?.on === sent.current.on && !pending) sent.current = null
      // Only a failure that names the target of the press still unresolved is its own.
      useFailureWatch(view, (failure) => sent.current !== null && failure.arg === (sent.current.on ? 'on' : 'off'), (failure) => {
        const record = sent.current
        sent.current = null
        record.fail?.(failure.text || t('chip.failed'))
      })
      // A projection that has not arrived yet shows nothing. Every hook above
      // runs on every render, so the hook order never changes.
      if (view === undefined || view === null) return null
      const working = pending || inFlightNow(props.sessionId)
      const label = working ? `${t('chip.label')} — ${t('chip.pending')}` : t('chip.label')
      const onChange = () => {
        const seen = latest.current
        if (seen.locked) return
        // Disabling a focused switch blurs it and the host menu closes on that
        // blur, so in-flight states are guarded here instead. `sent` also
        // covers a press whose command has not been logged yet.
        const now = Date.now()
        if (freshPending(seen.view)) return
        if (sent.current !== null && now - sent.current.at < COMMAND_DEADLINE_MS) return
        if (inFlightNow(props.sessionId)) return
        // The opposite of what the session shows.
        const record = { on: seen.view?.on !== true, at: now, reported: false, fail: null }
        sent.current = record
        void run(record.on ? '/explain-style on' : '/explain-style off', record).then((ok) => {
          if (!ok && sent.current === record) sent.current = null
        })
      }
      return h(React.Fragment, null,
        h('style', null, styles),
        // The hint is the row's tooltip: a visible line widened the menu.
        h('div', { className: 'ex-row', title: t('chip.hint'), 'aria-busy': working },
          h('span', { className: 'ex-label' }, t('chip.label')),
          h('span', { className: 'ex-end' },
            working ? spinnerIcon : null,
            primitives?.Switch != null
              ? h(primitives.Switch, { className: 'ex-toggle', checked: active, disabled: props.locked, label, onChange })
              : h('button', {
                type: 'button', role: 'switch', className: 'ex-toggle', 'aria-checked': active, 'aria-label': label,
                disabled: props.locked, onClick: onChange,
              }),
          ),
        ),
        error ? h('span', { className: 'ex-error', role: 'alert' }, error) : null,
      )
    }

    function apply(ctx) {
      const locale = ctx.get('locale')
      if (locale) ctx.effect(() => locale.register('explainer', { en, zh }), 'explainer: dictionaries')
      const t = locale ? locale.bind('explainer') : (key) => en[key] ?? key
      ctx.slots.inject('conversation.input.model.options', () =>
        ctx.slots.register(
          { name: 'conversation.input.model.options', id: 'explainer-option', order: 28 },
          function Option(props) { return h(ExplainerOption, { ...props, ctx, t }) },
        ),
      )
    }

    return { inject: ['slots'], apply }
  },
})
