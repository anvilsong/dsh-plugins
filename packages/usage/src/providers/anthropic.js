/**
 * Anthropic provider — Claude OAuth usage.
 *
 * Endpoint: GET https://api.anthropic.com/api/oauth/usage
 * Auth: the OAuth access token stored by DSH under llm-pi-ai/anthropic.
 * Reply: five_hour/seven_day windows, limits, extra_usage, spend, and
 * seven_day_breakdown.
 */

import { fetchUsageJson, mountProvider, num } from './net.js'

const DEFAULT_CREDENTIAL_REF = 'llm-pi-ai/anthropic'
const DEFAULT_BASE = 'https://api.anthropic.com'

function parseWindow(key, value, label) {
  if (!value || typeof value !== 'object') return null
  const utilization = num(value.utilization)
  return {
    key,
    label,
    usedRatio: utilization === null ? null : utilization / 100,
    resetAt: typeof value.resets_at === 'string' ? value.resets_at : null,
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
    if (d.extra) {
      const e = d.extra
      const used = moneyMinor(e.balanceCents, 2)
      lines.push(`Extra usage: ${used === null ? '—' : `${used.toFixed(2)} ${e.currency}`} (${e.enabled ? 'enabled' : 'disabled'})`)
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
  if (state.status === 'error') lines.push(`Warning: last refresh failed (${state.error}): ${state.detail ?? ''}`.trim())
  if (state.endpoint) lines.push(`Endpoint: ${String(state.endpoint).replace(/^https:\/\//, '')}`)
  if (state.fetchedAt) lines.push(`Read at ${new Date(state.fetchedAt).toLocaleTimeString()}`)
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
      })
      if (result.failure) return result
      const body = result.body
      const windows = [
        parseWindow('fiveHour', body.five_hour, '5-hour window'),
        parseWindow('sevenDay', body.seven_day, '7-day window'),
      ].filter(Boolean)
      const limits = Array.isArray(body.limits) ? body.limits : []
      for (const limit of limits) {
        if (limit?.kind !== 'weekly_all') continue
        const existing = windows.find((window) => window.key === 'sevenDay')
        if (!existing) {
          windows.push({
            key: 'sevenDay',
            label: '7-day window',
            usedRatio: num(limit.percent) === null ? null : num(limit.percent) / 100,
            resetAt: typeof limit.resets_at === 'string' ? limit.resets_at : null,
          })
        }
      }
      if (windows.length === 0) {
        return { failure: 'bad-response', detail: 'Reply has no five-hour or seven-day usage window.' }
      }
      const extra = body.extra_usage && typeof body.extra_usage === 'object' ? body.extra_usage : null
      const spend = body.spend && typeof body.spend === 'object' ? body.spend : null
      const breakdown = Array.isArray(body.seven_day_breakdown?.rows)
        ? body.seven_day_breakdown.rows.filter((row) => typeof row?.display_name === 'string' && num(row.percent) !== null).map((row) => ({
            displayName: row.display_name,
            percent: num(row.percent),
          }))
        : []
      return {
        endpoint: baseUrl,
        data: {
          kind: 'quota',
          windows,
          extra: extra
            ? {
                enabled: extra.is_enabled === true,
                balanceCents: num(extra.used_credits) === null ? null : num(extra.used_credits) * 100,
                monthlyLimitCents: num(extra.monthly_limit) === null ? null : num(extra.monthly_limit) * 100,
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
                reached: spend.spend_limit_reached === true,
              }
            : null,
          breakdown,
        },
      }
    },
  }, config)
}
