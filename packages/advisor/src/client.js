window.__ModuleLoader__.load({
  id: 'dsh-plugin-advisor',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    const en = {
      'chip.on': 'Advisor',
      'chip.enable': 'Enable advisor consults for this session',
      'chip.disable': 'Disable advisor consults for this session',
      'chip.unavailable': 'The command service is unavailable.',
      'chip.failed': 'Could not update Advisor.',
      'chip.description': 'Consult the advisor at major planning, design, and review steps.',
    }
    const zh = {
      'chip.on': 'Advisor',
      'chip.enable': '为此会话启用顾问咨询',
      'chip.disable': '为此会话禁用顾问咨询',
      'chip.unavailable': '命令服务不可用。',
      'chip.failed': '无法更新顾问。',
      'chip.description': '在主要规划、设计和审查步骤咨询顾问。',
    }

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
    `

    function AdvisorOption(props) {
      const view = props.useProjection?.('advisor')
      const active = view?.active === true
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const mounted = React.useRef(true)
      React.useEffect(() => () => { mounted.current = false }, [])
      const t = props.t ?? ((key) => en[key] ?? key)

      const select = async (enabled) => {
        if (busy || props.locked) return
        setBusy(true)
        setError(null)
        try {
          const commandUi = props.ctx.get('commandUi')
          if (!commandUi?.execute) throw new Error(t('chip.unavailable'))
          const outcome = await commandUi.execute({ sessionId: props.sessionId }, enabled ? '/advisor on' : '/advisor off')
          if (outcome?.kind === 'error') throw new Error(outcome.text ?? t('chip.failed'))
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          if (mounted.current) setError(message)
          if (typeof props.reportFailure === 'function') props.reportFailure(message)
        } finally {
          if (mounted.current) setBusy(false)
        }
      }

      return h(React.Fragment, null,
        h('style', null, styles),
        h('div', { className: 'adv-row' },
          h('span', { className: 'adv-label' },
            h('span', null, t('chip.on')),
            h(primitives.Tooltip, {
              label: t('chip.description'), side: 'top', delayMs: 300,
              maxWidth: 300, portal: true, openOnClick: true,
            },
              h(primitives.Button, {
                variant: 'ghost', size: 'sm', className: 'adv-info',
                'aria-label': t('chip.enable'),
              }, h(primitives.IconInfoOutlineRegular, { size: 11, 'aria-hidden': 'true' })),
            ),
          ),
          h(primitives.Switch, {
            className: 'adv-toggle',
            checked: active,
            disabled: props.locked || busy,
            label: active ? t('chip.disable') : t('chip.enable'),
            onChange: select,
          }),
        ),
        error ? h('span', { className: 'adv-error', role: 'alert' }, error) : null,
      )
    }

    function apply(ctx) {
      const locale = ctx.get('locale')
      if (locale) {
        ctx.effect(() => locale.register('advisor', { en, zh }), 'advisor: dictionaries')
      }
      const t = locale ? locale.bind('advisor') : (key) => en[key] ?? key
      ctx.slots.inject('conversation.input.model.options', () =>
        ctx.slots.register(
          { name: 'conversation.input.model.options', id: 'advisor-option', order: 25 },
          function Option(props) {
            return h(AdvisorOption, { ...props, ctx, t })
          },
        ),
      )
    }

    return { inject: ['slots'], apply }
  },
})
