/**
 * Anthropic provider — Claude OAuth usage.
 *
 * Endpoint: GET https://api.anthropic.com/api/oauth/usage
 * Auth: the OAuth access token stored by DSH under llm-pi-ai/anthropic.
 * Reply: five_hour/seven_day windows, limits, extra_usage, spend, and
 * seven_day_breakdown.
 */

import { fetchUsageJson, isRecord, mountProvider, num, usageFooter } from './net.js'

const DEFAULT_CREDENTIAL_REF = 'llm-pi-ai/anthropic'
const DEFAULT_BASE = 'https://api.anthropic.com'

function parseWindow(key, value, label) {
  if (!isRecord(value)) return null
  const utilization = num(value.utilization)
  return {
    key,
    label,
    usedRatio: utilization === null ? null : utilization / 100,
    resetAt: typeof value.resets_at === 'string' ? value.resets_at : null,
  }
}

/** Keep auxiliary limits distinct from the top-level usage windows. */
function parseLimit(value) {
  if (!isRecord(value)) return null
  const percent = num(value.percent)
  const scope = isRecord(value.scope) ? value.scope : null
  const model = isRecord(scope?.model) ? scope.model : null
  return {
    kind: typeof value.kind === 'string' ? value.kind : null,
    group: typeof value.group === 'string' ? value.group : null,
    percent,
    usedRatio: percent === null ? null : percent / 100,
    severity: typeof value.severity === 'string' ? value.severity : null,
    resetAt: typeof value.resets_at === 'string' ? value.resets_at : null,
    scope: scope
      ? {
          model: model
            ? {
                id: typeof model.id === 'string' ? model.id : null,
                displayName: typeof model.display_name === 'string' ? model.display_name : null,
              }
            : null,
          surface: typeof scope.surface === 'string' ? scope.surface : null,
        }
      : null,
    isActive: typeof value.is_active === 'boolean' ? value.is_active : null,
  }
}

function moneyMinor(amount, exponent = 2) {
  if (!Number.isFinite(amount)) return null
  return amount / 10 ** exponent
}

function windowLine(label, window) {
  const pct = window.usedRatio === null ? '—' : `${(window.usedRatio * 100).toFixed(1)}% used`
  return `${label}: ${pct}${window.resetAt ? ` · resets ${window.resetAt}` : ''}`
}

function formatReport(state) {
  const lines = ['Claude usage']
  const d = state.data
  if (d) {
    for (const window of d.windows) lines.push(windowLine(window.label, window))
    for (const limit of d.limits ?? []) {
      if (limit.kind === 'weekly_all') continue
      const model = limit.scope?.model?.displayName ?? limit.kind ?? 'Scoped'
      lines.push(windowLine(`${model} limit`, limit))
    }
    if (d.extra) {
      const e = d.extra
      const used = moneyMinor(e.balanceCents, 2)
      const limit = moneyMinor(e.monthlyLimitCents, 2)
      // is_enabled may be missing (null): then the report claims neither state.
      if (e.enabled === false) {
        lines.push('Extra usage: disabled')
      } else if (used !== null) {
        lines.push(`Extra usage used: ${used.toFixed(2)} ${e.currency}${limit === null ? ' (no monthly limit)' : ` of ${limit.toFixed(2)} ${e.currency}`}`)
      }
      if (e.disabledReason) lines.push(`Extra usage disabled reason: ${e.disabledReason}`)
    }
    if (d.spend) {
      const used = moneyMinor(d.spend.usedMinor, d.spend.exponent)
      if (used !== null) lines.push(`Usage credits spent: ${used.toFixed(2)} ${d.spend.currency}`)
    }
    if (d.breakdown.length > 0) {
      lines.push(`Breakdown: ${d.breakdown.map((row) => `${row.displayName} ${row.percent}%`).join(' · ')}`)
    }
  }
  if (state.endpoint) lines.push(`Endpoint: ${String(state.endpoint).replace(/^https:\/\//, '')}`)
  lines.push(...usageFooter(state))
  return lines.join('\n')
}

export function mountAnthropic(ctx, config = {}) {
  const credentialRef = config.credentialRef ?? DEFAULT_CREDENTIAL_REF
  const baseUrl = (typeof config.baseUrl === 'string' && config.baseUrl.length > 0 ? config.baseUrl : DEFAULT_BASE).replace(/\/+$/, '')
  const url = baseUrl + '/api/oauth/usage'

  mountProvider(ctx, {
    id: 'anthropic',
    title: 'Claude',
    serviceKey: 'anthropicUsage',
    commandName: 'usage-anthropic',
    commandDescription: 'Claude weekly usage, extra usage, and spend',
    endpoint: baseUrl,
    defaultGate: ['anthropic'],
    formatReport,
    fetchState: async (c, cfg) => {
      const result = await fetchUsageJson(c, {
        credentialRef,
        recordKey: credentialRef,
        url,
        timeoutMs: cfg.timeoutMs,
        headers: { 'anthropic-version': '2023-06-01' },
        signIn: 'anthropic',
      })
      if (result.failure) return result
      const body = result.body
      const windows = [
        parseWindow('fiveHour', body.five_hour, '5-hour window'),
        parseWindow('sevenDay', body.seven_day, '7-day window'),
        parseWindow('sevenDayOpus', body.seven_day_opus, '7-day Opus window'),
        parseWindow('sevenDaySonnet', body.seven_day_sonnet, '7-day Sonnet window'),
      ].filter(Boolean)
      const rawLimits = Array.isArray(body.limits) ? body.limits : []
      const limits = rawLimits.map(parseLimit).filter(Boolean)
      for (const limit of limits) {
        if (limit.kind !== 'weekly_all') continue
        const existing = windows.find((window) => window.key === 'sevenDay')
        if (!existing) {
          windows.push({
            key: 'sevenDay',
            label: '7-day window',
            usedRatio: limit.usedRatio,
            resetAt: limit.resetAt,
          })
        }
      }
      if (windows.length === 0) {
        return { failure: 'bad-response', detail: 'Reply has no five-hour or seven-day usage window.' }
      }
      const extra = isRecord(body.extra_usage) ? body.extra_usage : null
      const spend = isRecord(body.spend) ? body.spend : null
      const breakdown = Array.isArray(body.seven_day_breakdown?.rows)
        ? body.seven_day_breakdown.rows.filter((row) => isRecord(row) && typeof row.display_name === 'string' && num(row.percent) !== null).map((row) => ({
            displayName: row.display_name,
            percent: num(row.percent),
          }))
        : []
      const extraUtilization = num(extra?.utilization)
      return {
        endpoint: baseUrl,
        data: {
          kind: 'quota',
          quotas: Object.fromEntries(windows.map((window) => [window.key, window])),
          windows,
          limits,
          extra: extra
            ? {
                enabled: typeof extra.is_enabled === 'boolean' ? extra.is_enabled : null,
                // used_credits and monthly_limit are major currency units.
                // The shared panel calls this amount balanceCents; retain that
                // public field name even though Claude reports usage, not a wallet balance.
                balanceCents: num(extra.used_credits) === null ? null : num(extra.used_credits) * 100,
                monthlyLimitCents: num(extra.monthly_limit) === null ? null : num(extra.monthly_limit) * 100,
                usedRatio: extraUtilization === null ? null : extraUtilization / 100,
                currency: typeof extra.currency === 'string' ? extra.currency : 'USD',
                disabledReason: typeof extra.disabled_reason === 'string' ? extra.disabled_reason : null,
              }
            : null,
          spend: spend
            ? {
                usedMinor: num(spend.used?.amount_minor),
                currency: typeof spend.used?.currency === 'string' ? spend.used.currency : 'USD',
                exponent: num(spend.used?.exponent) ?? 2,
                limitMinor: num(spend.limit?.amount_minor),
                limitCurrency: typeof spend.limit?.currency === 'string' ? spend.limit.currency : null,
                limitExponent: num(spend.limit?.exponent),
                reached: typeof spend.spend_limit_reached === 'boolean' ? spend.spend_limit_reached : null,
              }
            : null,
          breakdown,
        },
      }
    },
  }, config)
}
