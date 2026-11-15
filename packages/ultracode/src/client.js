window.__ModuleLoader__.load({
  id: 'dsh-plugin-ultracode',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    const en = {
      'chip.on': 'Ultracode',
      'chip.off': 'Ultracode',
      'chip.pending': 'Updating…',
      'chip.enable': 'Enable exhaustive orchestration for this session',
      'chip.disable': 'Disable exhaustive orchestration for this session',
      'chip.unavailable': 'The command service is unavailable.',
      'chip.failed': 'Could not update Ultracode.',
      'chip.description': 'Use exhaustive multi-agent orchestration and verification for complex tasks.',
    }
    const zh = {
      'chip.on': 'Ultracode',
      'chip.off': 'Ultracode',
      'chip.pending': '正在更新…',
      'chip.enable': '为此会话启用穷尽式编排',
      'chip.disable': '为此会话禁用穷尽式编排',
      'chip.unavailable': '命令服务不可用。',
      'chip.failed': '无法更新 Ultracode。',
      'chip.description': '为复杂任务启用穷尽式多智能体编排与验证。',
    }

    const styles = `
      .uc-row{border-radius:var(--dsw-radius-md);min-height:34px;color:var(--dsw-alias-label-primary);
        justify-content:space-between;align-items:center;gap:16px;padding:0 8px;
        font-size:13px;line-height:20px;display:flex;position:relative}
      .uc-label{align-items:center;gap:4px;min-width:0;display:inline-flex}
      .uc-info{z-index:1;width:20px;height:20px;color:var(--dsw-alias-label-caption);flex:none;padding:0;position:relative}
      .uc-row .uc-toggle{position:static}
      .uc-toggle:after{content:"";border-radius:var(--dsw-radius-md);position:absolute;inset:0}
      .uc-row:has(.uc-toggle:focus-visible){background:var(--dsw-alias-interactive-bg-hover)}
      @media (hover:hover){.uc-row:has(.uc-toggle:not(:disabled)):hover{background:var(--dsw-alias-interactive-bg-hover)}}
      .uc-error{color:var(--dsw-alias-state-error-primary);font-size:11px;margin-inline-start:6px}
    `

    function UltracodeOption(props) {
      const view = props.useProjection?.('ultracode')
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
          const line = enabled ? '/ultracode on' : '/ultracode off'
          const outcome = await commandUi.execute({ sessionId: props.sessionId }, line)
          if (outcome?.kind === 'error') throw new Error(outcome.text ?? t('chip.failed'))
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          if (mounted.current) setError(message)
          if (typeof props.reportFailure === 'function') {
            props.reportFailure(message)
          }
        } finally {
          if (mounted.current) setBusy(false)
        }
      }

      return h(React.Fragment, null,
        h('style', null, styles),
        h('div', { className: 'uc-row' },
          h('span', { className: 'uc-label' },
            h('span', null, t('chip.on')),
            h(primitives.Tooltip, {
              label: t('chip.description'), side: 'top', delayMs: 300,
              maxWidth: 300, portal: true, openOnClick: true,
            },
              h(primitives.Button, {
                variant: 'ghost', size: 'sm', className: 'uc-info',
                'aria-label': t('chip.enable'),
              }, h(primitives.IconInfoOutlineRegular, { size: 11, 'aria-hidden': 'true' })),
            ),
          ),
          h(primitives.Switch, {
            className: 'uc-toggle',
            checked: active,
            disabled: props.locked || busy,
            label: active ? t('chip.disable') : t('chip.enable'),
            onChange: select,
          }),
        ),
        error ? h('span', { className: 'uc-error', role: 'alert' }, error) : null,
      )
    }

    function apply(ctx) {
      const locale = ctx.get('locale')
      if (locale) {
        ctx.effect(() => locale.register('ultracode', { en, zh }), 'ultracode: dictionaries')
      }
      const t = locale ? locale.bind('ultracode') : (key) => en[key] ?? key
      ctx.slots.inject('conversation.input.model.options', () =>
        ctx.slots.register(
          { name: 'conversation.input.model.options', id: 'ultracode-option', order: 20 },
          function Option(props) {
            return h(UltracodeOption, { ...props, ctx, t })
          },
        ),
      )
    }

    return { inject: ['slots'], apply }
  },
})
