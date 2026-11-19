/**
 * Usage plugin — browser half. One client module, eight usage providers
 * plus the sign-in service.
 *
 * Providers: OpenRouter (credits + key meters), Kimi Code (subscription
 * quota + Extra Usage wallet), DeepSeek and NewAPI (balance), GLM and
 * MiniMax (coding-plan quota), OpenAI Codex (plan quota + credits) and
 * Claude (subscription quota + extra usage). Each provider owns:
 *   - one Typert Remote namespace (`openrouterUsage` / `kimiUsage` /
 *     `deepseekUsage` / `zhipuUsage` / `minimaxUsage` / `newapiUsage` /
 *     `codexUsage` / `anthropicUsage`),
 *   - one store, one poll loop, one Settings → Models footer panel,
 *   - one composer chip, gated on the session's active provider.
 * The OAuth sign-in service (`providerLogin`) is shared: it adds the Codex
 * and Claude sign-in controls to their Settings → Models cards.
 *
 * Built as an installed Client module: a CommonJS-wrapped bundle registered
 * through `window.__ModuleLoader__`. React arrives through `require("react")`;
 * the client sandbox denies network, so all HTTP happens in the Host half.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-provider-usage',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    // react-dom is a platform seed word of the web shell's module table, like
    // react. Only its createPortal is used (the chip popover); without it the
    // popover renders inline.
    const createPortal = (() => {
      try {
        const dom = require('react-dom')
        return dom && typeof dom.createPortal === 'function' ? dom.createPortal : null
      } catch {
        return null
      }
    })()
    // Placement must run before paint; a renderer without layout effects falls back to effects.
    const useLayoutEffect = typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect

    const CARD_SLOT = 'settings.models.provider-card'
    const CHIP_SLOT = 'conversation.composer.dock'
    const POLL_MS = 5_000
    const MOUNT_RETRY_MS = 250
    const MOUNT_GRACE_MS = 10_000

    /**
     * One store per provider: ONE poll loop feeds every surface of that
     * provider (the Settings → Models panel and the composer chip), so adding
     * a surface never adds provider traffic. `state` holds the last unwrapped
     * Host state. `offline` is set when the Remote call itself failed (it was
     * rejected or answered `{ok:false}`): the last state stays, and the next
     * good reply clears the note. Its `missing` flag says the failure code
     * means "no such service on the Host" (see MISSING_SERVICE_CODES), which
     * is not a lost connection.
     */
    function makeStore() {
      return {
        state: null,
        offline: null,
        waiting: false,
        lastView: null,

        listeners: new Set(),
        /** What the surfaces render; a new object only when one of its parts changed. */
        view() {
          const last = this.lastView
          if (!last || last.state !== this.state || last.offline !== this.offline || last.waiting !== this.waiting) {
            this.lastView = { state: this.state, offline: this.offline, waiting: this.waiting }
          }
          return this.lastView
        },
        notify() {
          const view = this.view()
          for (const fn of this.listeners) {
            try {
              fn(view)
            } catch {
              // A broken subscriber must not break the others.
            }
          }
        },
        /** A good reply: the new Host state, and the Host is reachable again. */
        set(next) {
          this.state = next
          this.offline = null
          this.notify()
        },
        /** One Remote reply: a Result, or the bare state an older Remote returns. */
        accept(result) {
          if (!result || typeof result !== 'object') return
          if (result.ok === false) this.fail(result.error)
          else this.set(result.ok === true ? result.value : result)
        },
        /** The Remote call failed or was rejected: keep the last state and say why. */
        fail(error) {
          this.offline = remoteFailure(error)
          this.notify()
        },
        subscribe(fn) {
          this.listeners.add(fn)
          fn(this.view())
          return () => this.listeners.delete(fn)
        },
      }
    }

    const orStore = makeStore()
    const kimiStore = makeStore()

    const CSS = [
      // ---- OpenRouter (orup-) ----
      '.orup-root{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;',
      'background:var(--dsw-alias-bg-layer-1);padding:12px 14px;margin-top:12px;',
      'font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.orup-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}',
      '.orup-title{font-weight:600}',
      '.orup-scope{font-size:11px;color:var(--dsw-alias-label-secondary);',
      'border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 7px}',
      '.orup-spacer{flex:1}',
      '.orup-btn{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);',
      'background:transparent;border:1px solid var(--dsw-alias-border-l1);',
      'border-radius:6px;padding:2px 9px;cursor:pointer}',
      '.orup-btn:hover{border-color:var(--dsw-alias-border-l2)}',
      '.orup-btn:disabled{opacity:.5;cursor:default}',
      '.orup-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));',
      'gap:10px 14px}',
      '.orup-label{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.orup-value{font-variant-numeric:tabular-nums;font-weight:600}',
      '.orup-meter{margin-top:10px}',
      '.orup-barcap{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);margin-bottom:4px}',
      '.orup-bar{height:4px;border-radius:2px;background:var(--dsw-alias-border-l1);',
      'overflow:hidden}',
      '.orup-bar>i{display:block;height:100%}',
      '.orup-msg{color:var(--dsw-alias-label-secondary);line-height:1.5}',
      '.orup-err{color:var(--dsw-alias-state-error-primary);line-height:1.5;',
      'white-space:pre-wrap}',
      '.orup-code{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:4px}',
      '.orup-ok{color:var(--dsw-alias-state-success-primary)}',
      '.orup-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.orup-bad{color:var(--dsw-alias-state-error-primary)}',
      '.orup-stale{font-size:11px;color:var(--dsw-alias-state-warn-primary);white-space:nowrap}',
      '.orup-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-border-l2)}',
      '.orup-dot.orup-ok{background:var(--dsw-alias-state-success-primary)}',
      '.orup-dot.orup-warn{background:var(--dsw-alias-state-warn-primary)}',
      '.orup-dot.orup-bad{background:var(--dsw-alias-state-error-primary)}',
      // ---- Kimi Code (kmup-) ----
      '.kmup-root{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;',
      'background:var(--dsw-alias-bg-layer-1);padding:12px 14px;margin-top:12px;',
      'font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.kmup-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}',
      '.kmup-title{font-weight:600}',
      '.kmup-scope{font-size:11px;color:var(--dsw-alias-label-secondary);',
      'border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 7px}',
      '.kmup-spacer{flex:1}',
      '.kmup-btn{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);',
      'background:transparent;border:1px solid var(--dsw-alias-border-l1);',
      'border-radius:6px;padding:2px 9px;cursor:pointer}',
      '.kmup-btn:hover{border-color:var(--dsw-alias-border-l2)}',
      '.kmup-btn:disabled{opacity:.5;cursor:default}',
      '.kmup-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));',
      'gap:10px 14px}',
      '.kmup-label{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.kmup-value{font-variant-numeric:tabular-nums;font-weight:600}',
      '.kmup-meter{margin-top:10px}',
      '.kmup-barcap{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);margin-bottom:4px}',
      '.kmup-bar{height:4px;border-radius:2px;background:var(--dsw-alias-border-l1);',
      'overflow:hidden}',
      '.kmup-bar>i{display:block;height:100%}',
      '.kmup-msg{color:var(--dsw-alias-label-secondary);line-height:1.5}',
      '.kmup-err{color:var(--dsw-alias-state-error-primary);line-height:1.5;',
      'white-space:pre-wrap}',
      '.kmup-code{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:4px}',
      '.kmup-ok{color:var(--dsw-alias-state-success-primary)}',
      '.kmup-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.kmup-bad{color:var(--dsw-alias-state-error-primary)}',
      '.kmup-stale{font-size:11px;color:var(--dsw-alias-state-warn-primary);white-space:nowrap}',
      '.kmup-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-border-l2)}',
      '.kmup-dot.kmup-ok{background:var(--dsw-alias-state-success-primary)}',
      '.kmup-dot.kmup-warn{background:var(--dsw-alias-state-warn-primary)}',
      '.kmup-dot.kmup-bad{background:var(--dsw-alias-state-error-primary)}',
      // ---- Generic provider (pup-): DeepSeek, GLM, MiniMax, NewAPI ----
      '.pup-root{border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);',
      'background:var(--dsw-alias-settings-card-fill);padding:12px 14px;margin-top:12px;',
      'font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.pup-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}',
      '.pup-title{font-weight:600}',
      '.pup-scope{font-size:11px;color:var(--dsw-alias-label-secondary);',
      'border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 7px}',
      '.pup-spacer{flex:1}',
      '.pup-btn{font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);',
      'background:transparent;border:.5px solid var(--dsw-alias-border-l3);',
      'border-radius:var(--dsw-radius-sm);height:28px;padding:0 10px;cursor:pointer;',
      'display:inline-flex;align-items:center;justify-content:center;gap:4px}',
      '.pup-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}',
      '.pup-btn:disabled{opacity:.5;cursor:default}',
      '.pup-login-control::placeholder{color:var(--dsw-alias-label-secondary);opacity:1}',
      '.pup-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));',
      'gap:10px 14px}',
      '.pup-label{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.pup-value{font-variant-numeric:tabular-nums;font-weight:600}',
      '.pup-meter{margin-top:10px}',
      '.pup-barcap{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);margin-bottom:4px}',
      '.pup-bar{height:4px;border-radius:2px;background:var(--dsw-alias-border-l1);',
      'overflow:hidden}',
      '.pup-bar>i{display:block;height:100%}',
      '.pup-msg{color:var(--dsw-alias-label-secondary);line-height:1.5}',
      '.pup-err{color:var(--dsw-alias-state-error-primary);line-height:1.5;',
      'white-space:pre-wrap}',
      '.pup-code{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:4px}',
      '.pup-ok{color:var(--dsw-alias-state-success-primary)}',
      '.pup-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.pup-bad{color:var(--dsw-alias-state-error-primary)}',
      '.pup-stale{font-size:11px;color:var(--dsw-alias-state-warn-primary);white-space:nowrap}',
      '.pup-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-border-l2)}',
      '.pup-dot.pup-ok{background:var(--dsw-alias-state-success-primary)}',
      '.pup-dot.pup-warn{background:var(--dsw-alias-state-warn-primary)}',
      '.pup-dot.pup-bad{background:var(--dsw-alias-state-error-primary)}',
      // ---- Composer chip and its popover: one shared pill for every provider ----
      // The pill copies the host's dock pills (dsh-client-ui-chat StatsPills.module.css:
      // .anchor/.pill) and the popover its stat dialog surface (stat-dialog.module.css:
      // .panel). The popover is portaled to document.body, so this sheet reaches it.
      '.usage-chipwrap{display:inline-flex;min-width:0}',
      '.usage-chip{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;max-width:100%;',
      'padding:1px 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;',
      'color:var(--dsw-alias-label-tertiary);font:inherit;',
      'font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);',
      'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));',
      'font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer}',
      '.usage-chip[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-label-secondary)}',
      '@media (hover:hover){.usage-chip:hover{background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-label-secondary)}}',
      '.usage-chip>*{margin-top:0}',
      '.usage-chip b{font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.usage-pop{position:fixed;z-index:1100;box-sizing:border-box;margin:0;',
      'width:min(420px,calc(100vw - 24px));',
      'max-height:calc(100dvh - 12px - max(12px,var(--dsh-frame-overlay-top,12px)));',
      'overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;outline:none;',
      'border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);',
      '-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter);backdrop-filter:var(--dsw-menu-backdrop-filter);',
      '--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent)}',
      '.usage-pop>*{margin-top:0;border:0;border-radius:0;background:transparent}',
    ].join('')

    // ---------- shared formatters ----------

    /** Format a dollar amount, or an em dash when the field is absent. */
    function usd(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (value !== 0 && Math.abs(value) < 0.01) return '$' + value.toFixed(4)
      return '$' + value.toFixed(2)
    }

    /** Cents in a currency as a short string. */
    function centsMoney(cents, currency) {
      if (typeof cents !== 'number' || !Number.isFinite(cents)) return '—'
      const amount = cents / 100
      if (currency === 'CNY' || currency === 'RMB') return '¥' + amount.toFixed(2)
      if (currency === 'USD') return '$' + amount.toFixed(2)
      return amount.toFixed(2) + (currency ? ' ' + currency : '')
    }

    /** A quota ratio as a percent string. */
    function pct(ratio) {
      if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return '—'
      return (ratio * 100).toFixed(ratio > 0 && ratio < 0.001 ? 2 : 1) + '%'
    }

    /** A reset timestamp as a short local string. */
    function when(iso) {
      if (typeof iso !== 'string' || iso.length === 0) return null
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return null
      return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    }

    /**
     * Indicator level for a remaining budget (OpenRouter).
     * Null for an uncapped key, which is not a problem state.
     */
    function budgetLevel(remaining, limit) {
      if (typeof remaining !== 'number' || typeof limit !== 'number' || limit <= 0) return null
      const f = remaining / limit
      if (f <= 0.05) return 'bad'
      if (f <= 0.2) return 'warn'
      return 'ok'
    }

    /** Indicator level for one quota ratio (fraction USED). */
    function quotaLevel(ratio) {
      if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return null
      if (ratio >= 0.95) return 'bad'
      if (ratio >= 0.8) return 'warn'
      return 'ok'
    }

    /**
     * Claude's extra-usage record reports money USED (`balanceCents` holds
     * `used_credits`) and always carries an `enabled` key; a Kimi wallet or a
     * Codex credit balance never does, so key presence tells them apart.
     */
    function isExtraUsed(extra) {
      return Boolean(extra) && Object.prototype.hasOwnProperty.call(extra, 'enabled')
    }

    /**
     * Whether an extra-usage record has an amount worth showing in a chip or a
     * summary line. Claude's record shows nothing when the account turned extra
     * usage off or the reply carried no amount; a wallet or credit balance
     * (Kimi, Codex) always shows.
     */
    function hasExtraAmount(extra) {
      if (!extra) return false
      if (!isExtraUsed(extra)) return true
      return extra.enabled !== false && typeof extra.balanceCents === 'number' && Number.isFinite(extra.balanceCents)
    }

    /**
     * Indicator level of an extra-usage amount. Claude: the used ratio the
     * provider computed. Wallet: balance left against the topped-up total.
     * A balance with no total (Codex credits) has no level.
     */
    function extraLevel(extra) {
      if (!extra) return null
      if (isExtraUsed(extra)) return quotaLevel(extra.usedRatio)
      return budgetLevel(extra.balanceCents, extra.totalCents)
    }

    /** The fixed Kimi-family quota records, in panel order, with their default labels. */
    const QUOTA_LABELS = [
      ['fiveHour', '5-hour window'],
      ['sevenDay', '7-day window'],
      ['monthTotal', 'Monthly (all)'],
      ['monthCode', 'Monthly (code)'],
    ]

    /** The most used of some `{ ratio, label }` entries (the first one on a tie), or null. */
    function mostUsed(entries) {
      let worst = null
      for (const entry of entries) {
        if (typeof entry.ratio === 'number' && Number.isFinite(entry.ratio) && (worst === null || entry.ratio > worst.ratio)) worst = entry
      }
      return worst
    }

    /** The most used window of a quota provider's `windows` array: `{ ratio, label }`, or null. */
    function worstWindowEntry(windows) {
      return mostUsed((windows ?? []).filter(Boolean).map((w) => ({ ratio: w.usedRatio, label: w.label ?? w.key ?? CHIP_TEXT.window })))
    }

    /**
     * The most used window of a Kimi-family state (Kimi, Codex, Claude): the
     * fixed quota records when present, else the windows array.
     */
    function worstQuotaEntry(d) {
      if (!d) return null
      if (!d.quotas) return worstWindowEntry(d.windows)
      return mostUsed(QUOTA_LABELS.filter(([key]) => d.quotas[key]).map(([key, label]) => ({ ratio: d.quotas[key].usedRatio, label: d.quotas[key].label ?? label })))
    }

    // ---------- read health: stale, failed and offline reads ----------

    /**
     * Every visible word about the health of a read, in one place. `{name}`
     * marks a value filled in by `fill`.
     */
    const HEALTH_TEXT = {
      stale: 'stale',
      unavailable: 'unavailable',
      unavailableMark: '!',
      usageUnavailable: 'Usage unavailable',
      read: 'read {time}',
      staleRead: 'stale · read {time}',
      refreshFailedAt: 'Refresh failed at {time}: {detail}',
      refreshFailed: 'Refresh failed: {detail}',
      hostUnreachable: 'Host not reachable: {message}',
      notAvailable: 'Usage is not available for this provider',
      notAvailableWhy: 'Usage is not available for this provider: {message}',
      readFailed: 'Read failed.',
      remoteFailed: 'The Remote call failed.',
    }

    /**
     * Every visible word of the composer chip, its popover and the labelled
     * bars, in one place (`{name}` is filled by `fill`). `level` names the dot
     * colour in words for the chip's accessible name; the dot itself is hidden
     * from assistive tech.
     */
    const CHIP_TEXT = {
      usage: 'usage',
      balance: 'balance',
      left: '{amount} left',
      extra: '{amount} extra',
      extraUsed: '{amount} extra used',
      level: { ok: 'level normal', warn: 'level warning', bad: 'level critical' },
      used: '{percent} used',
      remaining: '{percent} left',
      barCaption: '{name} {value}',
      worstLabel: 'Most used window: {window}',
      keyBudget: 'Key budget',
      keyLabel: 'Key budget left',
      accountBudget: 'Account balance',
      accountLabel: 'Account balance left',
      window: 'window',
    }

    /** Put values into a HEALTH_TEXT template. */
    function fill(template, values) {
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match))
    }

    /** A read time (epoch ms, or an ISO string from an older state) as ms, or null. */
    function toTime(value) {
      if (typeof value === 'number') return Number.isFinite(value) ? value : null
      if (typeof value === 'string' && value.length > 0) {
        const ms = Date.parse(value)
        return Number.isFinite(ms) ? ms : null
      }
      return null
    }

    /**
     * Clock time as the panels and the Host reports print it: the time alone
     * for today, the date and the time for any other day (a read from two days
     * ago must not look like one from this morning). The Host's report footer
     * (providers/net.js) applies the same rule.
     */
    function clock(ms) {
      const at = new Date(ms)
      return at.toDateString() === new Date(Date.now()).toDateString() ? at.toLocaleTimeString() : at.toLocaleString()
    }

    /**
     * The Remote failure codes that mean the Host has no such service: the
     * provider row is disabled or its mount failed, so the other providers
     * still answer. The Gateway raises `gateway/invocation-unavailable` when no
     * active Remote method exports the endpoint and `gateway/service-unavailable`
     * when a declared Service is not active (dsh-api-gateway src/index.ts,
     * resolveSrcDescriptor and the receiver lookup); `gateway/method-unavailable`
     * and `gateway/definition-unavailable` are the same kind of answer for a
     * missing method or a withdrawn definition. A lost connection never uses
     * them: the client folds a carrier throw into `gateway/internal`
     * (dsh-api-gateway src/client/index.ts, carrierFailure), and a Host method
     * that threw is `gateway/internal` too.
     */
    const MISSING_SERVICE_CODES = [
      'gateway/invocation-unavailable',
      'gateway/service-unavailable',
      'gateway/method-unavailable',
      'gateway/definition-unavailable',
    ]

    /** The message and code of a failed or rejected Remote call, and whether the code says the service is missing. */
    function remoteFailure(error) {
      const message = error && typeof error.message === 'string' && error.message.length > 0
        ? error.message
        : typeof error === 'string' && error.length > 0 ? error : HEALTH_TEXT.remoteFailed
      const code = error && typeof error.code === 'string' && error.code.length > 0 ? error.code : null
      return { message, code, missing: code !== null && MISSING_SERVICE_CODES.includes(code) }
    }

    /**
     * The health of one provider read, for every surface:
     *   'idle'     nothing read yet, or the first read is still running
     *   'ok'       data from a good last attempt
     *   'stale'    data, but the last attempt failed
     *   'error'    the last attempt failed and there is no data
     *   'offline'  the Remote call itself failed; the last data, if any, stays
     * An offline read whose failure code says the service is missing is
     * `absent`: the provider is simply not mounted, which is neither a lost
     * connection nor an error, so it never counts as `unavailable` (the chip
     * hides, the card stays neutral). The last attempt failed when the Host says so (status 'error', or the
     * error it keeps while the next refresh is 'loading') or when it is newer
     * than the last good read (`attemptedAt` after `fetchedAt`).
     */
    function healthOf(view) {
      const raw = view ? view.state : null
      // A store filled by an older client holds the Remote failure envelope itself.
      const envelope = raw && raw.ok === false ? raw : null
      const state = envelope ? null : raw
      const data = state && state.data ? state.data : null
      const status = state && typeof state.status === 'string' ? state.status : 'idle'
      const fetchedAt = state ? toTime(state.fetchedAt) : null
      const attemptedAt = state ? toTime(state.attemptedAt) : null
      const failed = Boolean(state) && (
        status === 'error'
        || Boolean(state.error)
        || (attemptedAt !== null && (fetchedAt === null || attemptedAt > fetchedAt))
      )
      const offline = view && view.offline ? view.offline : envelope ? remoteFailure(envelope.error) : null
      const absent = Boolean(offline) && offline.missing === true
      let kind = 'idle'
      if (offline) kind = 'offline'
      else if (failed) kind = data ? 'stale' : 'error'
      else if (data) kind = 'ok'
      return {
        kind,
        state,
        data,
        status,
        // A refresh the Host reports as running; unknown while the Host is not reachable.
        loading: status === 'loading' && !offline,
        // Data that may be out of date: the last attempt failed, or the Host is not reachable.
        stale: data !== null && (kind === 'stale' || kind === 'offline'),
        // Nothing to show, and a failure to say why. A provider that is not mounted is not a failure.
        unavailable: data === null && (kind === 'error' || (kind === 'offline' && !absent)),
        // The Host has no such service (the row is disabled or its mount failed).
        absent,
        failed,
        fetchedAt,
        attemptedAt: failed ? attemptedAt : null,
        detail: failed ? state.detail || state.error || HEALTH_TEXT.readFailed : null,
        code: failed && state.error ? state.error : null,
        offline,
      }
    }

    /** The Host's failure, with its time when the Host sends `attemptedAt`. */
    function failureLine(health) {
      return health.attemptedAt !== null
        ? fill(HEALTH_TEXT.refreshFailedAt, { time: clock(health.attemptedAt), detail: health.detail })
        : fill(HEALTH_TEXT.refreshFailed, { detail: health.detail })
    }

    /** The sentence for a failed Remote call: a missing service is neutral, anything else a lost connection. */
    function offlineText(health) {
      return fill(health.absent ? HEALTH_TEXT.notAvailableWhy : HEALTH_TEXT.hostUnreachable, { message: health.offline.message })
    }

    /** What a collapsed surface says about a failure: the offline note, else the Host's detail. */
    function healthNote(health) {
      if (health.offline) return offlineText(health)
      return health.failed ? health.detail : null
    }

    /** 'read <fetchedAt>', marked stale when the data may be out of date; null with no read time. */
    function readNote(health) {
      if (health.fetchedAt === null) return health.stale ? HEALTH_TEXT.stale : null
      return fill(health.stale ? HEALTH_TEXT.staleRead : HEALTH_TEXT.read, { time: clock(health.fetchedAt) })
    }

    /**
     * The indicator dot of a surface: stale data is at least 'warn', a failure
     * with nothing to show is 'bad'. The numbers keep their own level.
     */
    function healthLevel(level, health) {
      if (health.unavailable) return 'bad'
      if (health.stale) return level === 'bad' ? 'bad' : 'warn'
      return level || ''
    }

    /** The failure lines of a panel: the offline note, the Host's failure, their codes. */
    function healthLines(px, health) {
      const lines = []
      if (health.offline) {
        lines.push(React.createElement('div', { className: health.absent ? `${px}-msg` : `${px}-err`, key: 'offline' }, offlineText(health)))
        if (health.offline.code) lines.push(React.createElement('div', { className: `${px}-code`, key: 'offline-code' }, health.offline.code))
      }
      if (health.failed) {
        lines.push(React.createElement('div', { className: `${px}-err`, key: 'failure' }, failureLine(health)))
        if (health.code) lines.push(React.createElement('div', { className: `${px}-code`, key: 'failure-code' }, health.code))
      }
      return lines.length ? React.createElement('div', { key: 'health', role: 'status' }, lines) : null
    }

    /**
     * The face of a composer chip, used by the one chip shell (UsageChip): the
     * values in bold, the word 'stale' beside stale values, 'unavailable' (with
     * an exclamation mark) when there is nothing to show, the dot level, and an
     * accessible name that starts with the visible words, then names the dot
     * level in words and adds the read time and the failure. The dot and the
     * mark are hidden from assistive tech, and never the only signal.
     *
     *   values  [{ key, text }]  the figures, when there is data
     *   empty   the word for a chip with nothing read yet ('usage', 'balance')
     *   level   the worst level of the figures
     */
    function chipFace({ px, title, health, values, empty, level }) {
      const parts = values.map((value) => React.createElement('b', { key: value.key }, value.text))
      if (!parts.length) {
        parts.push(React.createElement('span', { key: 'empty' }, health.unavailable ? HEALTH_TEXT.unavailable : empty))
      }
      const mark = health.stale ? HEALTH_TEXT.stale : health.unavailable ? HEALTH_TEXT.unavailableMark : ''
      parts.push(React.createElement('span', { key: 'health', className: health.stale ? `${px}-stale` : `${px}-code`, 'aria-hidden': 'true' }, mark))
      const dot = healthLevel(level, health)
      // The same words the chip shows: its figures, else 'unavailable' or the empty word.
      const shown = [title, ...(values.length ? values.map((value) => value.text) : [health.unavailable ? HEALTH_TEXT.unavailable : empty])]
      if (health.stale) shown.push(HEALTH_TEXT.stale)
      const said = [shown.join(' ')]
      if (dot) said.push(CHIP_TEXT.level[dot])
      if (health.stale && health.fetchedAt !== null) said.push(fill(HEALTH_TEXT.read, { time: clock(health.fetchedAt) }))
      const note = healthNote(health)
      if (note) said.push(note)
      return { parts, dot, label: said.join(', ') }
    }

    /** The worst of some indicator levels: 'bad', 'warn', 'ok', or '' when none has one. */
    function worstLevel(...levels) {
      for (const level of ['bad', 'warn', 'ok']) if (levels.includes(level)) return level
      return ''
    }

    // ---------- shared components / hooks ----------

    /** One label/value metric cell. `px` selects the stylesheet family. */
    function Metric({ px, label, value, cls, sub }) {
      return React.createElement(
        'div',
        null,
        React.createElement('div', { className: `${px}-label` }, label),
        React.createElement('div', { className: `${px}-value` + (cls ? ` ${px}-${cls}` : '') }, value),
        sub ? React.createElement('div', { className: `${px}-label` }, sub) : null,
      )
    }

    /**
     * A labelled meter under a panel's figures: a visible caption naming what
     * the bar measures and its value ('7-day window 74.0% used'), then the bar
     * as a progressbar with that value. Without the caption the bar right under
     * the grid read as the bar of the last metric. The fill keeps its level
     * colour.
     *
     *   name   what the bar measures ('7-day window', 'Key budget')
     *   value  the value in words ('74.0% used')
     *   label  the bar's accessible name
     *   ratio  the filled fraction, 0..1
     */
    function labelledBar(px, key, { name, value, label, ratio, level }) {
      const percent = Math.max(0, Math.min(100, ratio * 100))
      return React.createElement(
        'div',
        { className: `${px}-meter`, key },
        React.createElement('div', { className: `${px}-barcap` }, fill(CHIP_TEXT.barCaption, { name, value })),
        React.createElement(
          'div',
          {
            className: `${px}-bar`,
            role: 'progressbar',
            'aria-label': label,
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': Math.round(percent * 10) / 10,
            'aria-valuetext': value,
          },
          React.createElement('i', {
            className: level === 'bad' ? `${px}-bad` : level === 'warn' ? `${px}-warn` : `${px}-ok`,
            style: { width: percent + '%', background: 'currentColor' },
          }),
        ),
      )
    }

    /** The labelled bar of a quota panel's most used window. */
    function worstWindowBar(px, worst) {
      return labelledBar(px, 'bar', {
        name: worst.label,
        value: fill(CHIP_TEXT.used, { percent: pct(worst.ratio) }),
        label: fill(CHIP_TEXT.worstLabel, { window: worst.label }),
        ratio: worst.ratio,
        level: quotaLevel(worst.ratio),
      })
    }

    /**
     * Subscribe a component to one provider store. Returns the store's current
     * view ({ state, offline, waiting }); the hook state only schedules the
     * re-render when the view changes.
     */
    function useStore(store) {
      const [, setView] = React.useState(() => store.view())
      React.useEffect(() => store.subscribe((next) => setView(next)), [store])
      return store.view()
    }

    /** The health of one provider store (see healthOf), for every surface. */
    function useHealth(store) {
      return healthOf(useStore(store))
    }

    /**
     * The provider of the session's active model, read from the shared
     * per-session ModelDirectory (`ctx.modelDirectories`). It resolves the
     * catalog default for a blank session, so the chip matches what the
     * composer model trigger shows. `undefined` = unknown yet (the chip hides
     * until known, so it never shows under the wrong provider).
     *
     * Deliberately NOT an `inject` entry: the service name is internal, and
     * a missing inject leaves the whole client entry pending — fatal at web
     * boot. A lazy `ctx.get` degrades to "chip hidden" instead.
     */
    function useActiveProvider(getDirectory, sessionId) {
      const [provider, setProvider] = React.useState(undefined)
      React.useEffect(() => {
        const dir = sessionId ? getDirectory(sessionId) : undefined
        if (!dir) {
          setProvider(undefined)
          return undefined
        }
        const update = () => {
          const current = dir.getSnapshot().current
          setProvider(current && typeof current.provider === 'string' ? current.provider : null)
        }
        update()
        return dir.subscribe(update)
      }, [sessionId])
      return provider
    }

    /** Shared Refresh-button wiring for one provider panel. */
    function useRefresher(store, getNs) {
      const [busy, setBusy] = React.useState(false)
      const onRefresh = React.useCallback(() => {
        const ns = getNs()
        if (!ns) return
        setBusy(true)
        Promise.resolve()
          .then(() => ns.refresh())
          .then((result) => store.accept(result))
          // A rejected refresh: the Remote call failed (its code says a lost connection or a missing service); the last data stays.
          .catch((error) => store.fail(error))
          .then(() => setBusy(false))
      }, [getNs, store])
      return { busy, onRefresh }
    }

    // ---------- OpenRouter ----------

    function OpenRouterPanel({ store, getNs }) {
      const health = useHealth(store)
      const { busy, onRefresh } = useRefresher(store, getNs)

      const s = health.state
      const d = health.data
      const scope = d && d.scope === 'account' ? 'account' : 'key'
      const lv = d ? budgetLevel(d.remaining, d.limit) : null
      const status = health.status
      // The account section rides beside the key section; it has its own
      // status so a refused account call never hides the key figures.
      const acct = s && s.account ? s.account : null
      const a = acct && acct.status === 'ready' ? acct.data : null
      const alv = a ? budgetLevel(a.remaining, a.totalCredits) : null

      const rows = []
      if (d) {
        rows.push(
          React.createElement(Metric, {
            px: 'orup', key: 'used',
            label: scope === 'account' ? 'Used (account)' : 'Used (key)',
            value: usd(d.usage),
          }),
          React.createElement(Metric, {
            px: 'orup', key: 'limit',
            label: scope === 'account' ? 'Purchased' : 'Limit',
            value: scope === 'account'
              ? (d.totalCredits === null ? '—' : usd(d.totalCredits))
              : (d.limit === null ? 'uncapped' : usd(d.limit)),
          }),
          React.createElement(Metric, {
            px: 'orup', key: 'remaining',
            label: 'Remaining',
            value: d.remaining === null ? '—' : usd(d.remaining),
            cls: lv,
          }),
        )
        if (d.usageMonthly !== null) {
          rows.push(React.createElement(Metric, { px: 'orup', key: 'month', label: 'This month', value: usd(d.usageMonthly) }))
        }
        if (d.usageDaily !== null) {
          rows.push(React.createElement(Metric, { px: 'orup', key: 'day', label: 'Today', value: usd(d.usageDaily) }))
        }
        if (d.usageWeekly !== null) {
          rows.push(React.createElement(Metric, { px: 'orup', key: 'week', label: 'This week', value: usd(d.usageWeekly) }))
        }
        if (d.byokUsage) {
          rows.push(React.createElement(Metric, { px: 'orup', key: 'byok', label: 'BYOK', value: usd(d.byokUsage) }))
        }
      }

      const note = []
      if (d && d.label) note.push('key ' + d.label)
      if (d && d.isManagementKey) note.push('management key')
      if (d && d.limitReset) note.push('resets ' + d.limitReset)
      if (d && d.freeModels && typeof d.freeModels.remaining === 'number') {
        note.push('free models left today: ' + d.freeModels.remaining)
      }
      const read = readNote(health)
      if (read) note.push(read)

      // The account section: balance figures when available, a plain note when
      // the key is ordinary, nothing when the section is switched off.
      const accountBlocks = []
      if (a) {
        accountBlocks.push(
          React.createElement(
            'div',
            { className: 'orup-grid', key: 'account-grid' },
            React.createElement(Metric, {
              px: 'orup', key: 'balance', label: 'Balance (account)',
              value: a.remaining === null ? '—' : usd(a.remaining), cls: alv,
            }),
            React.createElement(Metric, {
              px: 'orup', key: 'purchased', label: 'Purchased',
              value: a.totalCredits === null ? '—' : usd(a.totalCredits),
            }),
            React.createElement(Metric, {
              px: 'orup', key: 'used', label: 'Used (account)',
              value: a.totalUsage === null ? '—' : usd(a.totalUsage),
            }),
          ),
        )
        if (alv) {
          accountBlocks.push(labelledBar('orup', 'account-bar', {
            name: CHIP_TEXT.accountBudget,
            value: fill(CHIP_TEXT.remaining, { percent: pct(a.remaining / a.totalCredits) }),
            label: CHIP_TEXT.accountLabel,
            ratio: a.remaining / a.totalCredits,
            level: alv,
          }))
        }
      } else if (acct && acct.status === 'error') {
        accountBlocks.push(
          React.createElement(
            'div',
            { className: 'orup-msg', key: 'account-note' },
            acct.error === 'management-key-required'
              ? 'Account balance needs a management key. Create one at openrouter.ai/keys and store it as this provider’s key, or leave the key view as-is.'
              : `Account balance unavailable (${acct.error}).`,
          ),
        )
      }

      const children = [
        React.createElement(
          'div',
          { className: 'orup-head', key: 'head' },
          React.createElement('span', { className: 'orup-title' }, 'OpenRouter'),
          React.createElement(
            'span',
            { className: 'orup-scope' },
            scope === 'account' ? 'account-wide' : a ? 'key + account' : 'this key',
          ),
          React.createElement('span', { className: 'orup-spacer' }),
          React.createElement(
            'button',
            {
              className: 'orup-btn', type: 'button', onClick: onRefresh,
              disabled: busy || health.loading,
            },
            busy || health.loading ? 'Refreshing…' : 'Refresh',
          ),
        ),
      ]

      if (status === 'idle' && !health.offline) {
        children.push(
          React.createElement(
            'div',
            { className: 'orup-msg', key: 'idle' },
            store.waiting
              ? 'The usage host service is not reachable yet. It appears after the Host half activates — try reloading the page, or check that the plugin row is enabled.'
              : 'Not read yet.',
          ),
        )
      }
      children.push(healthLines('orup', health))
      if (d) {
        children.push(React.createElement('div', { className: 'orup-grid', key: 'grid' }, rows))
        if (lv) {
          children.push(labelledBar('orup', 'bar', {
            name: CHIP_TEXT.keyBudget,
            value: fill(CHIP_TEXT.remaining, { percent: pct(d.remaining / d.limit) }),
            label: CHIP_TEXT.keyLabel,
            ratio: d.remaining / d.limit,
            level: lv,
          }))
        }
        if (note.length) {
          children.push(React.createElement('div', { className: 'orup-code', key: 'note' }, note.join(' · ')))
        }
      }
      if (accountBlocks.length) children.push(...accountBlocks)

      return React.createElement('div', { className: 'orup-root' }, children)
    }

    /**
     * The OpenRouter chip summary: usage and (when available) the account
     * balance left; the dot takes the worst of the two budget levels.
     */
    function openRouterSummary(health) {
      const s = health.state
      const d = health.data
      const acct = s && s.account ? s.account : null
      const a = acct && acct.status === 'ready' ? acct.data : null
      const values = []
      if (d) values.push({ key: 'used', text: usd(d.usage) })
      if (a && a.remaining !== null) values.push({ key: 'left', text: fill(CHIP_TEXT.left, { amount: usd(a.remaining) }) })
      const level = worstLevel(d ? budgetLevel(d.remaining, d.limit) : null, a ? budgetLevel(a.remaining, a.totalCredits) : null)
      return { values, level, empty: CHIP_TEXT.usage }
    }

    // ---------- Kimi Code ----------

    /** One quota metric, or null when the account does not carry that quota. */
    function quotaMetric(key, label, q) {
      if (!q) return null
      return React.createElement(Metric, {
        px: 'kmup', key, label: q.label ?? label,
        value: pct(q.usedRatio) + ' used',
        cls: quotaLevel(q.usedRatio),
        sub: q.resetAt ? 'resets ' + (when(q.resetAt) ?? q.resetAt) : null,
      })
    }

    function KimiPanel({ store, getNs, title = 'Kimi Code' }) {
      const health = useHealth(store)
      const { busy, onRefresh } = useRefresher(store, getNs)

      const s = health.state
      const d = health.data
      const status = health.status
      const worst = worstQuotaEntry(d)
      const plan = d && (d.planType || d.level)

      const rows = []
      if (d) {
        const q = d.quotas || {}
        for (const [key, label] of QUOTA_LABELS) {
          const m = quotaMetric(key, label, q[key])
          if (m) rows.push(m)
        }
        for (const limit of d.limits ?? []) {
          if (limit.kind === 'weekly_all') continue
          const model = limit.scope?.model?.displayName ?? limit.kind ?? 'Scoped'
          rows.push(React.createElement(Metric, {
            px: 'kmup', key: `limit-${limit.kind}-${model}`,
            label: `${model} limit`,
            value: pct(limit.usedRatio) + ' used',
            cls: limit.severity === 'critical' ? 'bad' : quotaLevel(limit.usedRatio),
            sub: [
              limit.resetAt ? 'resets ' + (when(limit.resetAt) ?? limit.resetAt) : null,
              limit.isActive === false ? 'inactive' : null,
            ].filter(Boolean).join(' · ') || null,
          }))
        }
        if (d.requests) {
          rows.push(
            React.createElement(Metric, {
              px: 'kmup', key: 'requests', label: 'Requests',
              value:
                d.requests.used !== null && d.requests.limit !== null
                  ? `${d.requests.used} / ${d.requests.limit}`
                  : '—',
              sub: d.requests.resetAt ? 'resets ' + (when(d.requests.resetAt) ?? d.requests.resetAt) : null,
            }),
          )
        }
        const credits = creditText(d.credits)
        if (credits !== null) {
          rows.push(React.createElement(Metric, {
            px: 'kmup', key: 'credits', label: 'Credits', value: credits,
          }))
        }
        if (d.resetCreditsAvailable !== null && d.resetCreditsAvailable !== undefined) {
          rows.push(React.createElement(Metric, {
            px: 'kmup', key: 'reset-credits', label: 'Rate-limit reset credits',
            value: d.resetCreditsAvailable, sub: 'available',
          }))
        }
        if (d.spend) {
          const spend = d.spend
          rows.push(React.createElement(Metric, {
            px: 'kmup', key: 'spend', label: 'Usage credits spent',
            value: minorFiat(spend.usedMinor, spend.currency, spend.exponent),
            cls: spend.reached ? 'bad' : null,
            sub: [
              spend.limitMinor !== null && spend.limitMinor !== undefined
                ? 'limit ' + minorFiat(spend.limitMinor, spend.currency, spend.exponent)
                : null,
              spend.reached ? 'spend limit reached' : null,
            ].filter(Boolean).join(' · ') || null,
          }))
        }
      }

      const note = []
      if (s && s.endpoint) note.push(s.endpoint.replace(/^https:\/\//, ''))
      const read = readNote(health)
      if (read) note.push(read)

      // Extra Usage: Claude reports money USED against a monthly limit; a Kimi
      // booster wallet reports a BALANCE. Only when the account has one.
      const extraBlocks = []
      const extra = d && d.extra ? d.extra : null
      if (extra && isExtraUsed(extra)) {
        extraBlocks.push(
          React.createElement(
            'div',
            { className: 'kmup-grid', key: 'extra-grid' },
            React.createElement(Metric, {
              px: 'kmup', key: 'extra', label: 'Extra usage used',
              value: centsMoney(extra.balanceCents, extra.currency),
              cls: extraLevel(extra),
              sub: [
                extra.monthlyLimitCents !== null && extra.monthlyLimitCents !== undefined
                  ? 'monthly limit ' + centsMoney(extra.monthlyLimitCents, extra.currency)
                  : null,
                extra.enabled === false ? 'disabled' : null,
                extra.disabledReason || null,
              ].filter(Boolean).join(' · ') || null,
            }),
          ),
        )
      } else if (extra) {
        extraBlocks.push(
          React.createElement(
            'div',
            { className: 'kmup-grid', key: 'extra-grid' },
            React.createElement(Metric, {
              px: 'kmup', key: 'balance', label: 'Extra Usage balance',
              value: centsMoney(extra.balanceCents, extra.currency),
              cls: extraLevel(extra),
            }),
            extra.totalCents !== null && extra.totalCents !== undefined
              ? React.createElement(Metric, {
                  px: 'kmup', key: 'topped', label: 'Topped up',
                  value: centsMoney(extra.totalCents, extra.currency),
                })
              : null,
            extra.monthlyLimitCents !== null && extra.monthlyLimitCents !== undefined
              ? React.createElement(Metric, {
                  px: 'kmup', key: 'cap', label: 'Monthly cap',
                  value: centsMoney(extra.balanceCents, extra.currency) + ' / ' + centsMoney(extra.monthlyLimitCents, extra.currency),
                })
              : null,
          ),
        )
      }

      if (d && Array.isArray(d.breakdown) && d.breakdown.length > 0) {
        extraBlocks.push(
          React.createElement(
            'div',
            { className: 'kmup-code', key: 'breakdown' },
            d.breakdown.map((row) => `${row.displayName}: ${row.percent}%`).join(' · '),
          ),
        )
      }
      if (d && d.ordinaryUsageAllowed === false) {
        extraBlocks.push(React.createElement('div', { className: 'kmup-code', key: 'ordinary-usage' }, 'Included usage is currently blocked.'))
      }
      if (d && d.spendControlReached === true) {
        extraBlocks.push(React.createElement('div', { className: 'kmup-code', key: 'spend-control' }, 'Spend control reached.'))
      }

      const children = [
        React.createElement(
          'div',
          { className: 'kmup-head', key: 'head' },
          React.createElement('span', { className: 'kmup-title' }, title),
          React.createElement('span', { className: 'kmup-scope' }, plan ?? 'subscription quota'),
          React.createElement('span', { className: 'kmup-spacer' }),
          React.createElement(
            'button',
            {
              className: 'kmup-btn', type: 'button', onClick: onRefresh,
              disabled: busy || health.loading,
            },
            busy || health.loading ? 'Refreshing…' : 'Refresh',
          ),
        ),
      ]

      if (status === 'idle' && !health.offline) {
        children.push(
          React.createElement(
            'div',
            { className: 'kmup-msg', key: 'idle' },
            store.waiting
              ? 'The usage host service is not reachable yet. It appears after the Host half activates — try reloading the page, or check that the plugin row is enabled.'
              : 'Not read yet.',
          ),
        )
      }
      children.push(healthLines('kmup', health))
      if (d && rows.length) {
        children.push(React.createElement('div', { className: 'kmup-grid', key: 'grid' }, rows))
        if (worst) children.push(worstWindowBar('kmup', worst))
        if (note.length) {
          children.push(React.createElement('div', { className: 'kmup-code', key: 'note' }, note.join(' · ')))
        }
      }
      if (extraBlocks.length) children.push(...extraBlocks)

      return React.createElement('div', { className: 'kmup-root' }, children)
    }

    /**
     * The Kimi-family chip summary (Kimi Code, Codex, Claude): the most used
     * quota percentage and, when present, the Extra Usage amount (Claude: the
     * amount used); the dot takes the worse of the two levels.
     */
    function kimiSummary(health) {
      const d = health.data
      const worst = worstQuotaEntry(d)
      const extra = d && hasExtraAmount(d.extra) ? d.extra : null
      const values = []
      if (worst) values.push({ key: 'q', text: pct(worst.ratio) })
      if (extra) {
        const amount = centsMoney(extra.balanceCents, extra.currency)
        values.push({ key: 'x', text: fill(isExtraUsed(extra) ? CHIP_TEXT.extraUsed : CHIP_TEXT.extra, { amount }) })
      }
      const level = worstLevel(worst ? quotaLevel(worst.ratio) : null, extraLevel(extra))
      return { values, level, empty: CHIP_TEXT.usage }
    }

    // ---------- generic providers (pup-) ----------

    /** The worst used-ratio across a quota provider's windows. */
    function worstWindow(windows) {
      let worst = null
      for (const w of windows ?? []) {
        if (w && typeof w.usedRatio === 'number') {
          if (worst === null || w.usedRatio > worst) worst = w.usedRatio
        }
      }
      return worst
    }

    /** Amount in a currency code: $ for USD, ¥ for CNY, else suffix. */
    function fiat(amount, currency) {
      if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—'
      if (currency === 'USD') return '$' + amount.toFixed(2)
      if (currency === 'CNY' || currency === 'RMB') return '¥' + amount.toFixed(2)
      return amount.toFixed(2) + (currency ? ' ' + currency : '')
    }

    /** A minor-unit money amount, with the exponent supplied by the API. */
    function minorFiat(amount, currency, exponent = 2) {
      if (!Number.isFinite(amount) || !Number.isFinite(exponent)) return '—'
      return fiat(amount / 10 ** exponent, currency)
    }

    /** The plan name supplied by a quota provider, without inventing one. */
    function quotaPlan(d) {
      const plan = d && (d.planType || d.level)
      return typeof plan === 'string' && plan.length > 0 ? plan + ' plan' : null
    }

    /** Codex credit state, preserving its string-valued balance. */
    function creditText(credits) {
      if (!credits) return null
      if (credits.unlimited) return 'unlimited'
      if (credits.balance !== null && credits.balance !== undefined) return String(credits.balance)
      if (credits.hasCredits === false) return 'none'
      if (credits.hasCredits === true) return 'available'
      return null
    }

    /**
     * Generic quota panel: window metrics with reset times, an optional plan
     * pill, provider-supplied credit metrics, and secondary detail text.
     */
    function QuotaPanel({ store, getNs, title }) {
      const health = useHealth(store)
      const { busy, onRefresh } = useRefresher(store, getNs)

      const s = health.state
      const d = health.data
      const status = health.status
      const worst = d ? worstWindowEntry(d.windows) : null
      const plan = d ? quotaPlan(d) : null

      const rows = []
      if (d) {
        for (const w of d.windows ?? []) {
          rows.push(React.createElement(Metric, {
            px: 'pup', key: w.key ?? w.label, label: w.label,
            value: pct(w.usedRatio) + ' used',
            cls: quotaLevel(w.usedRatio),
            sub: w.resetAt ? 'resets ' + (when(w.resetAt) ?? w.resetAt) : null,
          }))
        }
        for (const limit of d.limits ?? []) {
          if (limit.kind === 'weekly_all') continue
          const model = limit.scope?.model?.displayName ?? limit.kind ?? 'Scoped'
          rows.push(React.createElement(Metric, {
            px: 'pup', key: `limit-${limit.kind}-${model}`,
            label: `${model} limit`,
            value: pct(limit.usedRatio) + ' used',
            cls: limit.severity === 'critical' ? 'bad' : quotaLevel(limit.usedRatio),
            sub: [
              limit.resetAt ? 'resets ' + (when(limit.resetAt) ?? limit.resetAt) : null,
              limit.isActive === false ? 'inactive' : null,
            ].filter(Boolean).join(' · ') || null,
          }))
        }
        const p = d.prompts
        if (p) {
          rows.push(React.createElement(Metric, {
            px: 'pup', key: 'prompts', label: 'Tool calls',
            value: p.usedRatio !== null ? pct(p.usedRatio) + ' used' : (p.remaining !== null && p.limit !== null ? `${p.limit - p.remaining} / ${p.limit}` : '—'),
            cls: quotaLevel(p.usedRatio),
            sub: p.resetAt ? 'resets ' + (when(p.resetAt) ?? p.resetAt) : null,
          }))
        }
        const credits = creditText(d.credits)
        if (credits !== null) {
          rows.push(React.createElement(Metric, {
            px: 'pup', key: 'credits', label: 'Credits', value: credits,
          }))
        }
        if (d.resetCreditsAvailable !== null && d.resetCreditsAvailable !== undefined) {
          rows.push(React.createElement(Metric, {
            px: 'pup', key: 'reset-credits', label: 'Rate-limit reset credits',
            value: d.resetCreditsAvailable, sub: 'available',
          }))
        }
        if (d.extra && typeof d.extra.enabled === 'boolean') {
          const extra = d.extra
          rows.push(React.createElement(Metric, {
            px: 'pup', key: 'extra', label: 'Extra usage used',
            value: centsMoney(extra.balanceCents, extra.currency),
            sub: [
              extra.monthlyLimitCents !== null && extra.monthlyLimitCents !== undefined
                ? 'monthly limit ' + centsMoney(extra.monthlyLimitCents, extra.currency)
                : null,
              extra.enabled ? null : 'disabled',
              extra.disabledReason || null,
            ].filter(Boolean).join(' · ') || null,
          }))
        }
        if (d.spend) {
          const spend = d.spend
          rows.push(React.createElement(Metric, {
            px: 'pup', key: 'spend', label: 'Usage credits spent',
            value: minorFiat(spend.usedMinor, spend.currency, spend.exponent),
            cls: spend.reached ? 'bad' : null,
            sub: [
              spend.limitMinor !== null && spend.limitMinor !== undefined
                ? 'limit ' + minorFiat(spend.limitMinor, spend.limitCurrency ?? spend.currency, spend.limitExponent ?? spend.exponent)
                : null,
              spend.reached ? 'spend limit reached' : null,
            ].filter(Boolean).join(' · ') || null,
          }))
        }
      }

      const note = []
      if (s && s.endpoint) note.push(s.endpoint.replace(/^https:\/\//, ''))
      const read = readNote(health)
      if (read) note.push(read)

      // GLM's per-tool call counts, when the plan reports them.
      const detailBlocks = []
      const details = d && d.prompts && Array.isArray(d.prompts.details) ? d.prompts.details : []
      if (details.length > 0) {
        detailBlocks.push(
          React.createElement(
            'div',
            { className: 'pup-code', key: 'details' },
            details.slice(0, 8).map((x) => `${x.model}: ${x.usage}`).join(' · '),
          ),
        )
      }
      const breakdown = d && Array.isArray(d.breakdown) ? d.breakdown : []
      if (breakdown.length > 0) {
        detailBlocks.push(
          React.createElement(
            'div',
            { className: 'pup-code', key: 'breakdown' },
            breakdown.map((row) => `${row.displayName}: ${row.percent}%`).join(' · '),
          ),
        )
      }
      if (d && d.ordinaryUsageAllowed === false) {
        detailBlocks.push(React.createElement('div', { className: 'pup-code', key: 'ordinary-usage' }, 'Included usage is currently blocked.'))
      }
      if (d && d.spendControlReached === true) {
        detailBlocks.push(React.createElement('div', { className: 'pup-code', key: 'spend-control' }, 'Spend control reached.'))
      }

      const children = [
        React.createElement(
          'div',
          { className: 'pup-head', key: 'head' },
          React.createElement('span', { className: 'pup-title' }, title),
          React.createElement('span', { className: 'pup-scope' }, plan ?? 'subscription quota'),
          React.createElement('span', { className: 'pup-spacer' }),
          React.createElement(
            'button',
            { className: 'pup-btn', type: 'button', onClick: onRefresh, disabled: busy || health.loading },
            busy || health.loading ? 'Refreshing…' : 'Refresh',
          ),
        ),
      ]
      if (status === 'idle' && !health.offline) {
        children.push(
          React.createElement(
            'div', { className: 'pup-msg', key: 'idle' },
            store.waiting
              ? 'The usage host service is not reachable yet. It appears after the Host half activates — try reloading the page, or check that the plugin row is enabled.'
              : 'Not read yet.',
          ),
        )
      }
      children.push(healthLines('pup', health))
      if (d && rows.length) {
        children.push(React.createElement('div', { className: 'pup-grid', key: 'grid' }, rows))
        if (worst) children.push(worstWindowBar('pup', worst))
        if (note.length) children.push(React.createElement('div', { className: 'pup-code', key: 'note' }, note.join(' · ')))
      }
      if (detailBlocks.length) children.push(...detailBlocks)

      return React.createElement('div', { className: 'pup-root' }, children)
    }

    /**
     * Generic balance panel (DeepSeek, NewAPI): one row of metrics per
     * balance entry, or the granted/used/remaining triple.
     */
    function BalancePanel({ store, getNs, title }) {
      const health = useHealth(store)
      const { busy, onRefresh } = useRefresher(store, getNs)

      const s = health.state
      const d = health.data
      const status = health.status

      const rows = []
      if (d && Array.isArray(d.balances)) {
        // DeepSeek shape: per-currency totals with granted/topped-up split.
        for (const b of d.balances) {
          rows.push(React.createElement(Metric, {
            px: 'pup', key: b.currency, label: `Balance (${b.currency})`,
            value: fiat(b.total, b.currency),
            cls: b.total !== null && b.total <= 0 ? 'bad' : b.total !== null && b.total <= 1 ? 'warn' : 'ok',
            sub: b.toppedUp !== null && b.granted !== null && b.granted !== 0
              ? `topped up ${fiat(b.toppedUp, b.currency)} · granted ${fiat(b.granted, b.currency)}`
              : null,
          }))
        }
      } else if (d && d.kind === 'balance') {
        // NewAPI shape: granted/used/remaining in one currency.
        rows.push(
          React.createElement(Metric, { px: 'pup', key: 'granted', label: 'Granted', value: fiat(d.total, d.currency) }),
          React.createElement(Metric, { px: 'pup', key: 'used', label: 'Used', value: fiat(d.used, d.currency) }),
          React.createElement(Metric, {
            px: 'pup', key: 'remaining', label: 'Remaining', value: fiat(d.remaining, d.currency),
            cls: budgetLevel(d.remaining, d.total),
          }),
        )
      }

      const note = []
      if (d && d.isAvailable === false) note.push('balance exhausted — the API refuses calls')
      if (s && s.endpoint) note.push(s.endpoint.replace(/^https:\/\//, ''))
      const read = readNote(health)
      if (read) note.push(read)

      const children = [
        React.createElement(
          'div',
          { className: 'pup-head', key: 'head' },
          React.createElement('span', { className: 'pup-title' }, title),
          React.createElement('span', { className: 'pup-scope' }, 'balance'),
          React.createElement('span', { className: 'pup-spacer' }),
          React.createElement(
            'button',
            { className: 'pup-btn', type: 'button', onClick: onRefresh, disabled: busy || health.loading },
            busy || health.loading ? 'Refreshing…' : 'Refresh',
          ),
        ),
      ]
      if (status === 'idle' && !health.offline) {
        children.push(
          React.createElement(
            'div', { className: 'pup-msg', key: 'idle' },
            store.waiting
              ? 'The usage host service is not reachable yet. It appears after the Host half activates — try reloading the page, or check that the plugin row is enabled.'
              : 'Not read yet.',
          ),
        )
      }
      children.push(healthLines('pup', health))
      if (d && rows.length) {
        children.push(React.createElement('div', { className: 'pup-grid', key: 'grid' }, rows))
        if (note.length) children.push(React.createElement('div', { className: 'pup-code', key: 'note' }, note.join(' · ')))
      }

      return React.createElement('div', { className: 'pup-root' }, children)
    }

    /** The generic quota chip summary (GLM, MiniMax): the most used window. */
    function quotaSummary(health) {
      const worst = health.data ? worstWindowEntry(health.data.windows) : null
      return {
        values: worst ? [{ key: 'q', text: pct(worst.ratio) }] : [],
        level: worst ? quotaLevel(worst.ratio) : null,
        empty: CHIP_TEXT.usage,
      }
    }

    /** The generic balance chip summary (DeepSeek, NewAPI): the first balance, or what is left. */
    function balanceSummary(health) {
      const d = health.data
      let text = null
      let level = null
      if (d && Array.isArray(d.balances) && d.balances.length > 0) {
        const b = d.balances[0]
        text = fiat(b.total, b.currency)
        level = b.total !== null && b.total <= 0 ? 'bad' : b.total !== null && b.total <= 1 ? 'warn' : 'ok'
      } else if (d && d.kind === 'balance' && d.remaining !== null) {
        text = fill(CHIP_TEXT.left, { amount: fiat(d.remaining, d.currency) })
        level = budgetLevel(d.remaining, d.total)
      }
      return { values: text ? [{ key: 'b', text }] : [], level, empty: CHIP_TEXT.balance }
    }

    // ---------- the composer chip: one shell for every provider ----------

    /**
     * The popover's distance from the window edges and from its trigger: the
     * host's stat dialog uses the same 12px inset and 8px gap
     * (dsh-client-ui-chat stat-dialog.module.css).
     */
    const POP_INSET = 12
    const POP_GAP = 8

    /**
     * The chip popover that is open, by its close function: opening another
     * chip closes it in the same click, so at most one chip popover is open.
     * The outside-press listeners close it too; this also covers a chip opened
     * from the keyboard or by script.
     */
    const openChip = {
      close: null,
      open(close) {
        const previous = this.close
        this.close = close
        if (previous && previous !== close) previous()
      },
      closed(close) {
        if (this.close === close) this.close = null
      },
    }

    /** A page-unique id per chip instance, for the trigger's aria-controls. */
    let chipSeq = 0
    function useChipId() {
      const ref = React.useRef(null)
      if (ref.current === null) {
        chipSeq += 1
        ref.current = `usage-chip-pop-${chipSeq}`
      }
      return ref.current
    }

    /**
     * The px of a plain length or a calc() sum of px lengths ('68px',
     * 'calc(48px + 20px)', 'calc(100px - 32px)'), else null. The desktop app
     * defines --dsh-frame-overlay-top as `calc(var(--dsh-frame-top-clearance)
     * + 20px)` (AppFrame.module.css); reading it gives that calc() string
     * (the var() is substituted, the calc() is not evaluated), which
     * parseFloat would turn into NaN.
     */
    function pxLength(text) {
      const calc = /^calc\(\s*(.*?)\s*\)$/i.exec(text)
      const tokens = (calc ? calc[1] : text).split(/\s+/)
      const px = (token) => (/^\d*\.?\d+px$/i.test(token) ? parseFloat(token) : /^0$/.test(token) ? 0 : null)
      if (!calc && tokens.length !== 1) return null
      if (tokens.length % 2 === 0) return null
      let sum = px(tokens[0])
      for (let index = 1; sum !== null && index < tokens.length; index += 2) {
        const term = px(tokens[index + 1])
        if (term === null || (tokens[index] !== '+' && tokens[index] !== '-')) return null
        sum += tokens[index] === '+' ? term : -term
      }
      return sum
    }

    /** The px a CSS length resolves to, measured as the height of a hidden fixed probe the browser lays out; 0 when it cannot be measured. */
    function probeLength(doc, value) {
      if (!/^[\w\s().,%+*/-]+$/.test(value) || typeof doc.createElement !== 'function') return 0
      const probe = doc.createElement('div')
      probe.style.cssText = `position:fixed;top:0;left:0;width:0;visibility:hidden;pointer-events:none;height:${value}`
      doc.body.appendChild(probe)
      try {
        const height = probe.getBoundingClientRect().height
        return Number.isFinite(height) && height > 0 ? height : 0
      } finally {
        doc.body.removeChild(probe)
      }
    }

    /** The top inset the desktop frame reserves (`--dsh-frame-overlay-top`, which the host's dialogs honour), else 0. */
    function frameTop(win) {
      try {
        const doc = win.document
        const root = doc && (doc.documentElement || doc.body)
        if (!root || !doc.body || typeof win.getComputedStyle !== 'function') return 0
        const value = String(win.getComputedStyle(root).getPropertyValue('--dsh-frame-overlay-top') ?? '').trim()
        if (!value) return 0
        const px = pxLength(value)
        return px !== null ? Math.max(0, px) : probeLength(doc, value)
      } catch {
        return 0
      }
    }

    /** Whether two measured places are the same (so a scroll that moved nothing is no state update). */
    function samePlace(a, b) {
      return Boolean(a) && Boolean(b) && a.left === b.left && a.top === b.top && a.bottom === b.bottom && a.maxHeight === b.maxHeight
    }

    /**
     * Where the open popover goes, measured from the trigger's rect and the
     * panel's size: above the trigger with an 8px gap (its bottom edge is the
     * anchor, so a panel that grows after a refresh grows upward), below it
     * when the room above is too small and the room below is larger, and
     * left-aligned with the trigger but shifted to stay 12px inside both window
     * edges. The max-height keeps it inside the window on the side it opens to.
     * The host's stat dialog makes the same choices with CSS anchor positioning
     * (stat-dialog.module.css); measuring does not need anchor() support and
     * can be tested. Null when nothing can be measured.
     */
    function popoverPlace(trigger, panel, win) {
      if (!trigger || !panel || !win || typeof trigger.getBoundingClientRect !== 'function' || typeof panel.getBoundingClientRect !== 'function') return null
      const vw = win.innerWidth
      const vh = win.innerHeight
      if (!(vw > 0 && vh > 0)) return null
      const anchor = trigger.getBoundingClientRect()
      const box = panel.getBoundingClientRect()
      const width = Math.min(box.width, Math.max(0, vw - 2 * POP_INSET))
      const left = Math.round(Math.max(POP_INSET, Math.min(anchor.left, vw - POP_INSET - width)))
      const top = Math.max(POP_INSET, frameTop(win))
      const above = anchor.top - POP_GAP - top
      const below = vh - POP_INSET - anchor.bottom - POP_GAP
      if (box.height <= above || above >= below) {
        return { left, bottom: Math.round(vh - anchor.top + POP_GAP), maxHeight: Math.max(0, Math.floor(above)) }
      }
      return { left, top: Math.round(anchor.bottom + POP_GAP), maxHeight: Math.max(0, Math.floor(below)) }
    }

    /**
     * A fixed overlay goes to the document body: the docked composer contains
     * its fixed descendants (the `conversation.composer.dock` slot says so), and
     * the host's own dock pills portal their dialogs the same way. Without
     * react-dom (an old host, a test renderer) it stays inline.
     */
    function toBody(element) {
      const body = typeof document !== 'undefined' && document ? document.body : null
      return createPortal && body ? createPortal(element, body) : element
    }

    /**
     * The composer chip: ONE shell for all eight providers. A provider brings
     * only its summary (figures, level, empty word; see openRouterSummary,
     * kimiSummary, quotaSummary, balanceSummary), its panel, its chip title and
     * its colour prefix; chipFace draws the words.
     *
     * The trigger is a button with aria-haspopup 'dialog', aria-expanded and,
     * while open, aria-controls. The popover is a non-modal dialog portaled to
     * the body and placed by measurement (popoverPlace). Once it is placed and
     * visible, focus moves into it, so the keyboard reaches its Refresh button.
     * Escape closes it (and is cancelled, so the host's stop shortcut does not
     * count it) and gives the focus back to the trigger, unless the focus
     * already went elsewhere (the composer editor keeps it). A press or a click
     * outside the chip and the dialog closes it and leaves the focus alone; so
     * does focus moving from the chip or the dialog to another element (Tab
     * away). Opening another chip closes it (openChip).
     * Every listener goes away on close and on unmount.
     */
    function UsageChip({ store, getNs, title, chipTitle, dialogLabel, px, summary, panel }) {
      const health = useHealth(store)
      const [open, setOpen] = React.useState(false)
      const [place, setPlace] = React.useState(null)
      const rootRef = React.useRef(null)
      const triggerRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const popId = useChipId()
      const close = React.useCallback(() => setOpen(false), [])
      const name = chipTitle || title
      const label = dialogLabel || name
      const face = chipFace({ px, title: name, health, ...summary(health) })

      // Open: place it, and place it again when the window resizes or scrolls
      // or when the chip, its row or the dialog change size (the chip can move
      // with no window resize: the composer grows, a sibling appears). A
      // measurement that gives the same place is not a state update.
      useLayoutEffect(() => {
        if (!open) return undefined
        const win = typeof window !== 'undefined' ? window : null
        const measure = () => {
          const next = popoverPlace(triggerRef.current, panelRef.current, win)
          if (next) setPlace((previous) => (samePlace(previous, next) ? previous : next))
        }
        measure()
        if (win && typeof win.addEventListener === 'function') {
          win.addEventListener('resize', measure)
          win.addEventListener('scroll', measure, true)
        }
        let observer = null
        if (win && typeof win.ResizeObserver === 'function') {
          try {
            observer = new win.ResizeObserver(measure)
            const row = rootRef.current && rootRef.current.parentElement
            for (const element of [triggerRef.current, row, panelRef.current]) if (element) observer.observe(element)
          } catch {
            observer = null
          }
        }
        return () => {
          if (win && typeof win.removeEventListener === 'function') {
            win.removeEventListener('resize', measure)
            win.removeEventListener('scroll', measure, true)
          }
          if (observer) observer.disconnect()
          setPlace(null)
        }
      }, [open])

      // Focus moves into the dialog once it is placed, so the keyboard reaches
      // its Refresh button. The first render has visibility:hidden (it is not
      // measured yet) and a browser does not focus a hidden element: asking
      // for the focus then would leave it on the trigger.
      const placed = place !== null
      useLayoutEffect(() => {
        if (open && placed && panelRef.current && typeof panelRef.current.focus === 'function') panelRef.current.focus({ preventScroll: true })
      }, [open, placed])

      // Open: Escape and presses outside the chip and the dialog close it.
      React.useEffect(() => {
        if (!open) return undefined
        const doc = typeof document !== 'undefined' ? document : null
        if (!doc || typeof doc.addEventListener !== 'function') return undefined
        const inside = (target) => Boolean(target) && Boolean(
          (rootRef.current && rootRef.current.contains(target)) || (panelRef.current && panelRef.current.contains(target)),
        )
        // A press elsewhere: close, and let the press move the focus where it goes.
        const onPress = (event) => {
          if (!inside(event.target)) setOpen(false)
        }
        // Escape that closes the popover is cancelled: the host's stop
        // shortcut acts on Escapes nobody cancelled, and this one is spent. An
        // Escape somebody else already cancelled is theirs.
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return
          event.preventDefault()
          const active = doc.activeElement
          setOpen(false)
          if (!active || active === doc.body || inside(active)) {
            if (triggerRef.current && typeof triggerRef.current.focus === 'function') triggerRef.current.focus()
          }
        }
        // Capture: the press closes this popover before another chip's click opens its own.
        doc.addEventListener('mousedown', onPress, true)
        doc.addEventListener('click', onPress, true)
        doc.addEventListener('keydown', onKeyDown)
        return () => {
          doc.removeEventListener('mousedown', onPress, true)
          doc.removeEventListener('click', onPress, true)
          doc.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      React.useEffect(() => (open ? () => openChip.closed(close) : undefined), [open, close])

      const toggle = () => {
        if (open) {
          setOpen(false)
          return
        }
        openChip.open(close)
        setOpen(true)
      }
      // Focus leaving for another element closes it; a window switch (no next element) does not.
      const onBlur = (event) => {
        const next = event.relatedTarget
        if (!next) return
        if ((rootRef.current && rootRef.current.contains(next)) || (panelRef.current && panelRef.current.contains(next))) return
        setOpen(false)
      }

      const dialog = open
        ? React.createElement(
            'div',
            {
              ref: panelRef,
              id: popId,
              role: 'dialog',
              'aria-label': label,
              tabIndex: -1,
              className: 'usage-pop',
              // Hidden for the one render before it is measured.
              style: place ? { left: place.left, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight } : { visibility: 'hidden' },
              onBlur,
            },
            React.createElement(panel, { store, getNs, title }),
          )
        : null

      return React.createElement(
        'span',
        { ref: rootRef, className: 'usage-chipwrap' },
        React.createElement(
          'button',
          {
            ref: triggerRef,
            type: 'button',
            className: 'usage-chip',
            'aria-haspopup': 'dialog',
            'aria-expanded': open ? 'true' : 'false',
            'aria-controls': open ? popId : undefined,
            'aria-label': face.label,
            title: label,
            onClick: toggle,
            onBlur,
          },
          React.createElement('span', { className: `${px}-dot` + (face.dot ? ` ${px}-${face.dot}` : ''), 'aria-hidden': 'true' }),
          React.createElement('span', null, name),
          ...face.parts,
        ),
        dialog ? toBody(dialog) : null,
      )
    }

    /** One stable chip component per provider: the shell with that provider's parts. */
    function providerChip(p) {
      const parts = { px: p.px, chipTitle: p.chipTitle, dialogLabel: p.label, summary: p.summary, panel: p.panel }
      function ProviderChip(props) {
        return React.createElement(UsageChip, { ...props, ...parts })
      }
      return ProviderChip
    }

    // ---------- provider-card extras ----------

    /**
     * The quota windows of a state, in one shape: zhipu/minimax carry a
     * `windows` array, kimi carries the fixed `quotas` record.
     */
    function windowsOf(d) {
      if (Array.isArray(d.windows)) return d.windows
      if (d.quotas && typeof d.quotas === 'object') {
        return Object.entries(d.quotas).map(([key, q]) => ({ key, usedRatio: q && typeof q.usedRatio === 'number' ? q.usedRatio : null }))
      }
      return []
    }

    /** Compact window label for a provider-card summary. */
    function summaryWindowLabel(w) {
      const short = { fiveHour: '5h', sevenDay: '7d', monthTotal: 'mo', monthCode: 'code' }
      if (short[w.key]) return short[w.key]
      return String(w.label ?? w.key ?? 'window')
        .replace(/-hour window$/, 'h')
        .replace(/-day window$/, 'd')
        .replace(/-minute window$/, 'm')
    }

    /** One compact usage summary per provider, from its latest state. */
    function summarize(p, s) {
      const d = s && s.data ? s.data : null
      if (!d) return null
      if (p.id === 'openrouter') {
        const parts = [`used ${usd(d.usage)}`]
        const a = s.account && s.account.status === 'ready' ? s.account.data : null
        if (a && a.remaining !== null) parts.push(`balance ${usd(a.remaining)} left`)
        if (d.usageMonthly !== null) parts.push(`month ${usd(d.usageMonthly)}`)
        return parts.join(' · ')
      }
      if (d.kind === 'quota' || d.quotas) {
        const parts = windowsOf(d)
          .filter((w) => typeof w.usedRatio === 'number')
          .map((w) => `${summaryWindowLabel(w)} ${pct(w.usedRatio)}`)
        for (const limit of d.limits ?? []) {
          if (limit.kind === 'weekly_all') continue
          const model = limit.scope?.model?.displayName ?? limit.kind ?? 'Scoped'
          parts.push(`${model} ${pct(limit.usedRatio)}`)
        }
        const credits = creditText(d.credits)
        if (credits !== null) parts.push(`credits ${credits}`)
        if (hasExtraAmount(d.extra)) {
          parts.push(isExtraUsed(d.extra)
            ? `extra used ${centsMoney(d.extra.balanceCents, d.extra.currency)}`
            : `extra ${centsMoney(d.extra.balanceCents, d.extra.currency)}`)
        }
        if (d.spend && Number.isFinite(d.spend.usedMinor)) {
          parts.push(`spent ${minorFiat(d.spend.usedMinor, d.spend.currency, d.spend.exponent)}`)
        }
        return parts.join(' · ') || null
      }
      if (d.kind === 'balance') {
        if (Array.isArray(d.balances) && d.balances.length > 0) {
          const b = d.balances[0]
          return `balance ${fiat(b.total, b.currency)}`
        }
        if (d.remaining !== null) return `${fiat(d.remaining, d.currency)} left`
      }
      return null
    }

    /**
     * The worst indicator level of the figures in the summary. The card raises
     * it for stale data and failures through healthLevel.
     */
    function summaryLevel(p, s) {
      const d = s && s.data ? s.data : null
      if (!d) return ''
      if (p.id === 'openrouter') {
        const a = s.account && s.account.status === 'ready' ? s.account.data : null
        const lv = a ? budgetLevel(a.remaining, a.totalCredits) : d.remaining !== null ? budgetLevel(d.remaining, d.limit) : null
        return lv ?? ''
      }
      if (d.kind === 'quota' || d.quotas) {
        const worst = worstWindow(windowsOf(d))
        return worst !== null ? (quotaLevel(worst) ?? '') : ''
      }
      if (d.kind === 'balance' && !Array.isArray(d.balances)) return budgetLevel(d.remaining, d.total) ?? ''
      return ''
    }

    /**
     * Per-route "signed in just now" signal. ProviderLoginAction marks a route
     * when its flow settles as authorized; the same card's CardExtras listens
     * so the usage line appears without a remount. It is a change signal, not
     * a record: a fresh mount ignores it and reads the stored status instead.
     */
    const signInSignal = {
      versions: new Map(),
      listeners: new Set(),
      version(route) { return this.versions.get(route) ?? 0 },
      mark(route) {
        this.versions.set(route, this.version(route) + 1)
        for (const fn of [...this.listeners]) {
          try {
            fn(route)
          } catch {
            // A broken listener must not break the others.
          }
        }
      },
      subscribe(fn) {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
      },
    }

    /**
     * One provider card's usage line (`settings.models.provider-card`).
     * Renders nothing until the owner confirms the row's key is configured —
     * usage belongs to set-up providers only. Click expands the full panel.
     */
    function CardExtras({ p, store, getNs, keyConfigured, provider, getLoginNs }) {
      const health = useHealth(store)
      const [open, setOpen] = React.useState(false)
      const [oauthConfigured, setOauthConfigured] = React.useState(null)
      // `busy` is true from the card's own sign-in until the refresh it triggers settles.
      const { busy, onRefresh } = useRefresher(store, getNs)
      const refreshRef = React.useRef(onRefresh)
      refreshRef.current = onRefresh
      const route = provider?.provider
      React.useEffect(() => {
        if (!['openai-codex', 'anthropic'].includes(route)) return undefined
        let active = true
        let timer
        const startedAt = Date.now()
        // A sign-in that settles while this read is in flight must win.
        const seen = signInSignal.version(route)
        const signedMeanwhile = () => signInSignal.version(route) !== seen
        // The login service can appear just after the card does: retry briefly
        // instead of leaving an OAuth-only user without the usage line.
        const read = () => {
          const ns = getLoginNs?.()
          if (!ns?.status) {
            if (!active) return
            if (Date.now() - startedAt >= MOUNT_GRACE_MS) {
              setOauthConfigured(signedMeanwhile())
              return
            }
            timer = setTimeout(read, MOUNT_RETRY_MS)
            return
          }
          void Promise.resolve().then(() => ns.status({ provider: route })).then((result) => {
            const value = result?.ok === true ? result.value : result
            if (active) setOauthConfigured(value?.configured === true || signedMeanwhile())
          }).catch(() => {
            if (active) setOauthConfigured(signedMeanwhile())
          })
        }
        read()
        return () => {
          active = false
          clearTimeout(timer)
        }
      }, [route])
      // The card's own sign-in action settled as authorized: show the usage
      // line now and refresh the provider once, so the error the missing
      // credential left in the store does not stay on screen.
      React.useEffect(() => {
        if (!['openai-codex', 'anthropic'].includes(route)) return undefined
        return signInSignal.subscribe((signedRoute) => {
          if (signedRoute !== route) return
          setOauthConfigured(true)
          refreshRef.current()
        })
      }, [route])
      if (keyConfigured === false && oauthConfigured !== true) return null
      const s = health.state
      const summary = summarize(p, s)
      const plan = health.data ? quotaPlan(health.data) : null
      const lv = healthLevel(summaryLevel(p, s), health)
      // The offline note, else the Host's failure: under the line while collapsed
      // (the open panel shows it in full, with its time). A provider that is not
      // mounted says so in plain words, and with nothing else on the line the
      // note is just the Gateway's own message.
      const failure = health.absent && !summary ? health.offline.message : healthNote(health)
      // While the refresh after a sign-in runs, what the store holds is from before it.
      if (busy && !summary) {
        return React.createElement(
          'div',
          { className: `${p.px}-root`, style: { marginTop: '12px', padding: '12px 14px' }, role: 'status' },
          'Loading usage…',
        )
      }
      if (!summary && !failure) return null

      return React.createElement(
        'div',
        { className: `${p.px}-root`, style: { marginTop: '12px', padding: '12px 14px' } },
        React.createElement(
          'button',
          {
            className: `${p.px}-btn`, type: 'button',
            style: { border: 'none', padding: 0, display: 'inline-flex', alignItems: 'center', gap: 6 },
            onClick: () => setOpen((v) => !v),
            title: `${p.title} usage`,
          },
          React.createElement('span', { className: `${p.px}-dot` + (lv ? ` ${p.px}-${lv}` : '') }),
          plan ? React.createElement('span', { className: `${p.px}-scope` }, plan) : null,
          React.createElement('span', null, summary ?? (health.absent ? HEALTH_TEXT.notAvailable : HEALTH_TEXT.usageUnavailable)),
          health.stale ? React.createElement('span', { className: `${p.px}-stale` }, readNote(health)) : null,
          React.createElement('span', { className: `${p.px}-code`, style: { marginTop: 0 } }, open ? '▴ less' : '▾ details'),
        ),
        failure && !open
          ? React.createElement('div', { className: health.absent ? `${p.px}-msg` : `${p.px}-err`, role: 'status', style: { marginTop: 6, fontSize: 12, overflowWrap: 'anywhere' } }, failure)
          : null,
        open ? React.createElement(p.panel, { store, getNs, title: p.title }) : null,
      )
    }

    const LOGIN_CONTROL_STYLE = {
      font: 'inherit',
      fontSize: 12,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '.5px solid var(--dsw-alias-border-l3)',
      borderRadius: 'var(--dsw-radius-sm)',
      height: 28,
      padding: '0 8px',
      minWidth: 0,
      flex: 1,
    }

    /** A sign-in action and inline OAuth flow for provider cards. */
    function ProviderLoginAction(props) {
      const route = typeof props.provider === 'string' ? props.provider : props.provider?.provider
      const nativeAuth = props.nativeAuth ?? props.provider?.nativeAuth
      const oauthRoute = ['openai-codex', 'anthropic'].includes(route) ? route : null
      const oauthEnabled = nativeAuth?.oauth === true
      const [busy, setBusy] = React.useState(false)
      const [oauthConfigured, setOauthConfigured] = React.useState(null)
      // One line under the button: a notice (role status) or a failure (role alert).
      const [note, setNote] = React.useState(null)
      const [link, setLink] = React.useState(null)
      const [promptEvent, setPromptEvent] = React.useState(null)
      const [answer, setAnswer] = React.useState('')
      const streamRef = React.useRef(null)
      // Counts sign-in runs; a run that is no longer current (cancelled,
      // unmounted, route changed) must not touch state any more.
      const runRef = React.useRef(0)
      const wasConfiguredRef = React.useRef(false)
      const answeredRef = React.useRef(null)

      const showNotice = (text) => setNote({ text, failure: false })
      const showFailure = (text) => setNote({ text, failure: true })
      // Ends the current run and cancels its stream. True when a stream was open.
      const closeStream = () => {
        runRef.current += 1
        const stream = streamRef.current
        streamRef.current = null
        try {
          stream?.dispose?.()
        } catch {
          // The stream had already finished.
        }
        return stream !== null
      }

      // Read the stored OAuth record on every mount. The namespace can appear
      // just after the card, so retry briefly instead of flashing a stale
      // sign-in button after a page reload.
      React.useEffect(() => {
        let active = true
        let timer
        setOauthConfigured(null)
        setBusy(false)
        setNote(null)
        setLink(null)
        setPromptEvent(null)
        setAnswer('')
        // Leaving the card (or switching its route) cancels a sign-in in flight.
        if (!oauthRoute || !oauthEnabled) return () => { active = false; closeStream() }
        const startedAt = Date.now()
        const readStatus = async () => {
          const ns = props.getLoginNs?.()
          if (!ns?.status) {
            if (!active) return
            if (Date.now() - startedAt >= MOUNT_GRACE_MS) {
              setOauthConfigured(false)
              const error = props.getLoginError?.()
              if (error) showFailure(error)
              return
            }
            timer = setTimeout(readStatus, MOUNT_RETRY_MS)
            return
          }
          try {
            const result = await ns.status({ provider: oauthRoute })
            if (!active) return
            if (result?.ok === false) throw new Error(result.error?.message ?? 'Could not read the sign-in state.')
            const value = result?.ok === true ? result.value : result
            setOauthConfigured(value?.configured === true)
          } catch (error) {
            if (!active) return
            setOauthConfigured(false)
            showFailure(error instanceof Error ? error.message : String(error))
          }
        }
        void readStatus()
        return () => {
          active = false
          clearTimeout(timer)
          closeStream()
        }
      }, [oauthRoute, oauthEnabled])

      if (!oauthRoute || !oauthEnabled) return null
      const providerName = route === 'openai-codex' ? 'ChatGPT' : 'Claude'
      const label = `Sign in with ${providerName}`

      // An environment/API-key configuration suppresses only the sign-in
      // action. It must not hide a separately stored OAuth identity.
      if (oauthConfigured !== true && props.keyConfigured !== false && !busy) return null
      if (oauthConfigured === null) {
        return React.createElement(
          'div',
          { style: { marginTop: 8, padding: '0 12px 8px' }, role: 'status' },
          'Checking sign-in…',
        )
      }

      const start = async () => {
        if (busy) return
        const wasConfigured = oauthConfigured === true
        wasConfiguredRef.current = wasConfigured
        answeredRef.current = null
        runRef.current += 1
        const run = runRef.current
        setBusy(true)
        setOauthConfigured(false)
        setNote(null)
        setLink(null)
        setPromptEvent(null)
        try {
          const ns = props.getLoginNs?.()
          if (!ns?.begin) throw new Error(props.getLoginError?.() ?? 'The provider login service is unavailable.')
          const stream = ns.begin({ provider: route, method: 'oauth' })
          streamRef.current = stream
          for await (const event of stream) {
            if (runRef.current !== run) break
            if (event.type === 'notice') {
              showNotice(event.notice.message)
              setLink(event.notice.url ? { url: event.notice.url, code: event.notice.code } : null)
            } else if (event.type === 'prompt') {
              setAnswer(event.prompt.kind === 'select' ? event.prompt.options?.[0]?.id ?? '' : '')
              setPromptEvent(event)
            } else if (event.type === 'settled') {
              if (event.status === 'authorized') {
                setOauthConfigured(true)
                setNote(null)
                setLink(null)
                // Tell this card's usage line, which reads the status only on mount.
                signInSignal.mark(oauthRoute)
              } else {
                setOauthConfigured(wasConfigured)
                setLink(null)
                showNotice('Sign-in cancelled.')
              }
            }
          }
        } catch (error) {
          if (runRef.current === run) {
            setOauthConfigured(wasConfigured)
            setLink(null)
            showFailure(error instanceof Error ? error.message : String(error))
          }
        } finally {
          if (runRef.current === run) {
            streamRef.current = null
            setBusy(false)
            setPromptEvent(null)
          }
        }
      }

      const cancel = () => {
        if (!closeStream()) return
        setBusy(false)
        setLink(null)
        setPromptEvent(null)
        setAnswer('')
        setOauthConfigured(wasConfiguredRef.current)
        showNotice('Sign-in cancelled.')
      }

      const submit = () => {
        if (!promptEvent || !streamRef.current) return
        if (answeredRef.current === promptEvent.id) return
        answeredRef.current = promptEvent.id
        try {
          streamRef.current.send({ type: 'answer', id: promptEvent.id, answer })
        } catch {
          // The stream ended between the prompt and this click: send throws then.
          setPromptEvent(null)
          setAnswer('')
          showFailure('The sign-in already ended. Start it again.')
          return
        }
        setPromptEvent(null)
        setAnswer('')
      }

      // Enter submits; Enter that confirms an IME composition (keyCode 229)
      // must not.
      const onAnswerKeyDown = (event) => {
        if (event.key !== 'Enter') return
        if (event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229) return
        event.preventDefault()
        submit()
      }

      const noteNode = note
        ? React.createElement(
            'div',
            note.failure
              ? { role: 'alert', className: 'pup-err', style: { marginTop: 6, fontSize: 12, overflowWrap: 'anywhere' } }
              : { role: 'status', style: { marginTop: 6, fontSize: 12, overflowWrap: 'anywhere' } },
            note.text,
          )
        : null

      if (oauthConfigured === true) {
        return React.createElement(
          'div',
          { style: { marginTop: 8, padding: '0 12px 8px' } },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            React.createElement(
              'span',
              { role: 'status', className: 'pup-ok', style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 } },
              React.createElement('span', { className: 'pup-dot pup-ok' }),
              `Signed in with ${providerName}`,
            ),
            React.createElement(
              primitives.Button,
              { type: 'button', variant: 'outline', size: 'sm', onClick: start, disabled: busy },
              busy ? 'Waiting for sign-in…' : 'Re-authenticate',
            ),
          ),
          noteNode,
        )
      }

      const promptId = promptEvent ? `pup-login-${oauthRoute}-${promptEvent.id}` : null
      const prompt = promptEvent?.prompt
      return React.createElement(
        'div',
        { style: { marginTop: 8, padding: '0 12px 8px' } },
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          React.createElement(
            primitives.Button,
            { type: 'button', variant: 'outline', size: 'sm', onClick: start, disabled: busy },
            busy ? 'Waiting for sign-in…' : label,
          ),
          busy ? React.createElement(primitives.Button, { type: 'button', variant: 'outline', size: 'sm', onClick: cancel }, 'Cancel') : null,
        ),
        noteNode,
        link ? React.createElement('div', { style: { marginTop: 6, fontSize: 12, minWidth: 0, overflowWrap: 'anywhere' } },
          React.createElement('a', { href: link.url, target: '_blank', rel: 'noreferrer noopener', style: { overflowWrap: 'anywhere' } }, link.url),
          link.code
            ? React.createElement('div', { className: 'pup-login-code', style: { marginTop: 4, overflowWrap: 'anywhere', userSelect: 'text' } }, `Code: ${link.code}`)
            : null,
        ) : null,
        prompt ? React.createElement('div', { style: { marginTop: 8 } },
          React.createElement('label', {
            htmlFor: promptId,
            style: { display: 'block', marginBottom: 4, fontSize: 12, color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere' },
          }, prompt.message || 'Your answer'),
          React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
            prompt.kind === 'select'
              ? React.createElement('select', {
                  id: promptId,
                  className: 'pup-login-control',
                  autoFocus: true,
                  value: answer,
                  onChange: (event) => setAnswer(event.target.value),
                  style: LOGIN_CONTROL_STYLE,
                }, prompt.options.map((option) => React.createElement('option', { key: option.id, value: option.id }, option.label)))
              : React.createElement('input', {
                  id: promptId,
                  className: 'pup-login-control',
                  type: prompt.kind === 'secret' ? 'password' : 'text',
                  autoFocus: true,
                  value: answer,
                  placeholder: prompt.placeholder,
                  onChange: (event) => setAnswer(event.target.value),
                  onKeyDown: onAnswerKeyDown,
                  style: LOGIN_CONTROL_STYLE,
                }),
            React.createElement(primitives.Button, { type: 'button', variant: 'outline', size: 'sm', onClick: submit }, 'Submit'),
          ),
        ) : null,
      )
    }

    // ---------- registration ----------

    /**
     * Services this half needs. A plain array of names. There is deliberately
     * NO `typert` entry and NO `styles` entry: `$mount` resolves typert
     * through the service shadow, and `styles` is a dynamic-package symbol,
     * not an injectable service.
     */
    const inject = ['slots', 'remote']

    // Stable per-provider panel wrappers: an inline arrow in the PROVIDERS
    // table would be a new component type per render and remount the popover
    // each time, dropping the chip's open state.
    function DeepSeekPanel(props) { return React.createElement(BalancePanel, { ...props, title: 'DeepSeek' }) }
    function ZhipuPanel(props) { return React.createElement(QuotaPanel, { ...props, title: 'GLM Coding Plan' }) }
    function MiniMaxPanel(props) { return React.createElement(QuotaPanel, { ...props, title: 'MiniMax Coding Plan' }) }
    function NewApiPanel(props) { return React.createElement(BalancePanel, { ...props, title: 'NewAPI' }) }

    /**
     * The per-provider wiring table: namespace, store, surfaces, gate. Each
     * chip is the one shell (UsageChip) with the provider's `summary`,
     * `panel`, colour prefix and optional short `chipTitle`; its dialog is
     * labelled with `label`. The `chip` component is bound below the table.
     */
    const PROVIDERS = [
      {
        id: 'openrouter',
        px: 'orup',
        title: 'OpenRouter',
        namespace: 'openrouterUsage',
        store: orStore,
        panel: OpenRouterPanel,
        summary: openRouterSummary,
        settingsId: 'openrouter-usage',
        chipId: 'openrouter-usage-chip',
        label: 'OpenRouter usage',
        chipLabel: 'OpenRouter usage chip',
        gate: ['openrouter'],
      },
      {
        id: 'kimi',
        px: 'kmup',
        title: 'Kimi Code',
        namespace: 'kimiUsage',
        store: kimiStore,
        panel: KimiPanel,
        summary: kimiSummary,
        settingsId: 'kimi-usage',
        chipId: 'kimi-usage-chip',
        label: 'Kimi Code usage',
        chipLabel: 'Kimi Code usage chip',
        gate: ['kimi-coding'],
      },
      {
        id: 'deepseek',
        px: 'pup',
        title: 'DeepSeek',
        namespace: 'deepseekUsage',
        store: makeStore(),
        panel: DeepSeekPanel,
        summary: balanceSummary,
        settingsId: 'deepseek-usage',
        chipId: 'deepseek-usage-chip',
        label: 'DeepSeek balance',
        chipLabel: 'DeepSeek balance chip',
        gate: ['deepseek', 'deepseek-official'],
      },
      {
        id: 'zhipu',
        px: 'pup',
        title: 'GLM Coding Plan',
        namespace: 'zhipuUsage',
        store: makeStore(),
        panel: ZhipuPanel,
        summary: quotaSummary,
        chipTitle: 'GLM',
        settingsId: 'zhipu-usage',
        chipId: 'zhipu-usage-chip',
        label: 'GLM Coding Plan usage',
        chipLabel: 'GLM Coding Plan usage chip',
        gate: ['zai-coding-cn', 'zai'],
      },
      {
        id: 'minimax',
        px: 'pup',
        title: 'MiniMax Coding Plan',
        namespace: 'minimaxUsage',
        store: makeStore(),
        panel: MiniMaxPanel,
        summary: quotaSummary,
        chipTitle: 'MiniMax',
        settingsId: 'minimax-usage',
        chipId: 'minimax-usage-chip',
        label: 'MiniMax Coding Plan usage',
        chipLabel: 'MiniMax Coding Plan usage chip',
        gate: ['minimax-cn', 'minimax'],
      },
      {
        id: 'newapi',
        px: 'pup',
        title: 'NewAPI',
        namespace: 'newapiUsage',
        store: makeStore(),
        panel: NewApiPanel,
        summary: balanceSummary,
        settingsId: 'newapi-usage',
        chipId: 'newapi-usage-chip',
        label: 'NewAPI token quota',
        chipLabel: 'NewAPI token quota chip',
        // No default gate: a NewAPI relay maps to no catalog provider. Set
        // `gate` in the provider config to unhide the chip.
        gate: [],
      },
      {
        id: 'codex',
        px: 'kmup',
        title: 'OpenAI Codex',
        namespace: 'codexUsage',
        store: makeStore(),
        panel: KimiPanel,
        summary: kimiSummary,
        settingsId: 'codex-usage',
        chipId: 'codex-usage-chip',
        label: 'OpenAI Codex usage',
        chipLabel: 'OpenAI Codex usage chip',
        gate: ['openai-codex'],
      },
      {
        id: 'anthropic',
        px: 'kmup',
        title: 'Claude',
        namespace: 'anthropicUsage',
        store: makeStore(),
        panel: KimiPanel,
        summary: kimiSummary,
        settingsId: 'anthropic-usage',
        chipId: 'anthropic-usage-chip',
        label: 'Claude usage',
        chipLabel: 'Claude usage chip',
        gate: ['anthropic'],
      },
    ]
    for (const p of PROVIDERS) p.chip = providerChip(p)

    /** Insert one stylesheet into the document, removed when the plugin unloads. */
    function insertStyles() {
      const id = 'usage-plugin-styles'
      if (typeof document === 'undefined') return () => {}
      const existing = document.getElementById(id)
      if (existing) return () => {}
      const el = document.createElement('style')
      el.id = id
      el.textContent = CSS
      document.head.appendChild(el)
      return () => {
        const live = document.getElementById(id)
        if (live && live.parentNode) live.parentNode.removeChild(live)
      }
    }

    /**
     * The hand-written Remote contribution for the WHOLE package. The typert
     * registry admits one registration per package name, so all provider
     * namespaces ride one mount — six separate mounts fail after the first
     * with "Remote package is already registered".
     */
    const strictJson = {
      mode: 'strict',
      typeSymbol: 'dsh-plugin-provider-login#JsonValue',
      create: () => ({ parse: (value) => value }),
    }

    function contribution(namespaces) {
      const descriptor = (namespace, method) => ({
        id: `dsh-plugin-provider-usage#${namespace}/${method}`,
        service: namespace,
        namespace,
        method,
        invocation: { kind: 'direct' },
        parameters: [],
        result: { mode: 'src-json' },
      })
      const loginStatus = {
        id: 'dsh-plugin-provider-login#providerLogin/status',
        service: 'providerLogin',
        namespace: 'providerLogin',
        method: 'status',
        invocation: { kind: 'direct' },
        parameters: [{ name: 'request', wire: 'request', source: 'json', codec: strictJson }],
        result: { mode: 'src-json' },
      }
      const loginBegin = {
        id: 'dsh-plugin-provider-login#providerLogin/begin',
        service: 'providerLogin',
        namespace: 'providerLogin',
        method: 'begin',
        mode: 'stream',
        invocation: { kind: 'direct' },
        parameters: [{ name: 'request', wire: 'request', source: 'json', codec: strictJson }],
        uplink: { codec: strictJson },
        cancellation: { parameter: 'signal' },
        result: { mode: 'src-json' },
      }
      return {
        package: 'dsh-plugin-provider-usage',
        descriptors: [...namespaces.flatMap((ns) => [descriptor(ns, 'snapshot'), descriptor(ns, 'refresh')]), loginStatus, loginBegin],
      }
    }

    function apply(ctx) {
      ctx.effect(insertStyles, 'usage: stylesheet')

      /**
       * Resolve the session's shared ModelDirectory store, or undefined when
       * the model-selection service is absent. Lazy get, never injected.
       */
      const getDirectory = (sessionId) => {
        try {
          const dirs = ctx.get('modelDirectories')
          if (!dirs || typeof dirs.directoryFor !== 'function') return undefined
          return dirs.directoryFor(sessionId).store
        } catch {
          return undefined
        }
      }

      /**
       * Mount ALL Remote namespaces in one effect owned by this plugin fiber,
       * so unloading the plugin unmounts them together. A mount failure must
       * never throw out of `apply`: a throw here fails web boot for the whole
       * application. The surfaces keep polling until the namespaces appear.
       */
      const namespaces = new Map()
      let providerLoginNs
      let providerLoginMountError
      ctx.effect(async () => {
        let dispose
        try {
          dispose = await ctx.remote.$mount(contribution(PROVIDERS.map((p) => p.namespace)))
        } catch (error) {
          providerLoginMountError = error instanceof Error ? error.message : String(error)
          return () => {}
        }
        for (const p of PROVIDERS) {
          try {
            const ns = ctx.get('remote.' + p.namespace)
            if (ns) namespaces.set(p.namespace, ns)
          } catch {
            // A missing namespace leaves the provider's surfaces polling.
          }
        }
        try { providerLoginNs = ctx.get('remote.providerLogin') } catch { providerLoginNs = undefined }
        return () => { providerLoginNs = undefined; dispose() }
      }, 'usage: mount remotes')

      for (const p of PROVIDERS) {
        const getNs = () => namespaces.get(p.namespace)

        /** ONE poll loop per provider, feeding both of its surfaces. */
        ctx.effect(() => {
          let alive = true
          let timer
          const startedAt = Date.now()
          const tick = async () => {
            const ns = getNs()
            if (ns) {
              p.store.waiting = false
              try {
                const result = await ns.snapshot()
                if (alive) p.store.accept(result)
              } catch (error) {
                // The Remote call failed: keep the last state, show why (a missing service or a lost connection); the next tick retries.
                if (alive) p.store.fail(error)
              }
              if (alive) timer = setTimeout(tick, POLL_MS)
            } else {
              if (alive && Date.now() - startedAt > MOUNT_GRACE_MS && !p.store.waiting) {
                p.store.waiting = true
                p.store.notify() // so the idle hint appears
              }
              if (alive) timer = setTimeout(tick, MOUNT_RETRY_MS)
            }
          }
          void tick()
          return () => {
            alive = false
            clearTimeout(timer)
          }
        }, `usage: poll ${p.namespace}`)

        // See the registration below the loop: cards are keyed by settings
        // namespace, not by route — every pi-ai row dispatches 'llm-pi-ai'.

        // The composer chip. Hidden when the Host config says so
        // (`ui.composerChip` rides the state; default on) and unless the
        // session's active model belongs to one of this provider's gates.
        // The Host config can override the gate list (`ui.gate`), which is
        // the only way a config-only provider like NewAPI gets a chip.
        ctx.slots.inject(CHIP_SLOT, () =>
          ctx.slots.register(
            { name: CHIP_SLOT, id: p.chipId, order: 10, label: () => p.chipLabel },
            function ChipPanel(props) {
              // Read through the store hook: the chip appears or hides when the state arrives.
              const health = useHealth(p.store)
              const state = health.state
              const provider = useActiveProvider(getDirectory, props.sessionId)
              if (state && state.ui && state.ui.composerChip === false) return null
              // No service on the Host and nothing read: this provider is not mounted, so there is no chip.
              if (health.absent && health.data === null) return null
              const gates = state && state.ui && Array.isArray(state.ui.gate) ? state.ui.gate : p.gate
              if (!gates.includes(provider)) return null
              return React.createElement(p.chip, { ...props, store: p.store, getNs, title: p.title })
            },
          ),
        )
      }

    /**
     * Provider cards are keyed by SETTINGS NAMESPACE, not route: every pi-ai
     * row dispatches `entryKey = 'llm-pi-ai'`, the official DeepSeek row
     * dispatches 'llm-deepseek'. One occupant per namespace branches on the
     * row's route id (`props.provider.provider`) against the provider gates.
     */
    const cardNamespaces = ['llm-pi-ai', 'llm-deepseek']
    for (const settingsNs of cardNamespaces) {
      ctx.slots.inject(CARD_SLOT, () =>
        ctx.slots.register(
          { name: CARD_SLOT, key: settingsNs },
          function UsageCardOccupant(props) {
            const route = props && props.provider && typeof props.provider.provider === 'string' ? props.provider.provider : null
            const p = PROVIDERS.find((candidate) => candidate.gate.includes(route))
            const card = p
              ? React.createElement(CardExtras, { ...props, p, store: p.store, getNs: () => namespaces.get(p.namespace), getLoginNs: () => providerLoginNs })
              : null
            const login = React.createElement(ProviderLoginAction, { ...props, getLoginNs: () => providerLoginNs, getLoginError: () => providerLoginMountError })
            return React.createElement(React.Fragment, null, card, login)
          },
        ),
      )
    }
    }

    exports.SLOT = CARD_SLOT
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
