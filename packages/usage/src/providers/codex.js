/**
 * OpenAI Codex provider — ChatGPT account usage.
 *
 * Endpoint: GET https://chatgpt.com/backend-api/wham/usage
 * Auth: the OAuth access token stored by DSH under llm-pi-ai/openai-codex.
 * Reply: rate_limit.primary_window / secondary_window, plan_type, credits,
 * spend_control, and rate_limit_reset_credits.
 */

import { fetchUsageJson, mountProvider, num } from './net.js'

const DEFAULT_CREDENTIAL_REF = 'llm-pi-ai/openai-codex'
const DEFAULT_BASE = 'https://chatgpt.com/backend-api'

function windowLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Window'
  if (seconds % 86_400 === 0) return `${seconds / 86_400}-day window`
  if (seconds % 3_600 === 0) return `${seconds / 3_600}-hour window`
  return `${Math.round(seconds / 60)}-minute window`
}

function parseWindow(key, value) {
  if (!value || typeof value !== 'object') return null
  const seconds = num(value.limit_window_seconds)
  return {
    key,
    label: windowLabel(seconds),
    usedRatio: num(value.used_percent) === null ? null : num(value.used_percent) / 100,
    resetAt: num(value.reset_at) === null ? null : new Date(num(value.reset_at) * 1000).toISOString(),
    windowSeconds: seconds,
  }
}

function windowLine(label, window) {
  const pct = window.usedRatio === null ? '—' : `${(window.usedRatio * 100).toFixed(1)}% used`
  return `${label}: ${pct}${window.resetAt ? ` · resets ${window.resetAt}` : ''}`
}

function formatReport(state) {
  const lines = ['OpenAI Codex usage']
  const d = state.data
  if (d) {
    if (d.planType) lines.push(`Plan: ${d.planType}`)
    for (const window of d.windows) lines.push(windowLine(window.label, window))
    if (d.ordinaryUsageAllowed === false) lines.push('Ordinary included usage is currently blocked.')
    if (d.spendControlReached === true) lines.push('Spend control reached.')
    if (d.credits) {
      if (d.credits.unlimited) lines.push('Credits: unlimited')
      else if (d.credits.balance !== null) lines.push(`Credits: ${d.credits.balance}`)
      else if (d.credits.hasCredits === false) lines.push('Credits: none')
    }
    if (d.resetCreditsAvailable !== null) lines.push(`Rate-limit reset credits available: ${d.resetCreditsAvailable}`)
  }
  if (state.status === 'error') lines.push(`Warning: last refresh failed (${state.error}): ${state.detail ?? ''}`.trim())
  if (state.endpoint) lines.push(`Endpoint: ${String(state.endpoint).replace(/^https:\/\//, '')}`)
  if (state.fetchedAt) lines.push(`Read at ${new Date(state.fetchedAt).toLocaleTimeString()}`)
  return lines.join('\n')
}

export function mountCodex(ctx, config = {}) {
  const credentialRef = config.credentialRef ?? DEFAULT_CREDENTIAL_REF
  const baseUrl = (typeof config.baseUrl === 'string' && config.baseUrl.length > 0 ? config.baseUrl : DEFAULT_BASE).replace(/\/+$/, '')
  const url = baseUrl + '/wham/usage'

  mountProvider(ctx, {
    id: 'codex',
    title: 'OpenAI Codex',
    serviceKey: 'codexUsage',
    commandName: 'usage-codex',
    commandDescription: 'OpenAI Codex plan, quota windows, and credits',
    endpoint: baseUrl,
    defaultGate: ['openai-codex'],
    formatReport,
    fetchState: async (c, cfg) => {
      const result = await fetchUsageJson(c, { credentialRef, recordKey: credentialRef, url, timeoutMs: cfg.timeoutMs })
      if (result.failure) return result
      const body = result.body
      const rateLimit = body.rate_limit
      if (!rateLimit || typeof rateLimit !== 'object') {
        return { failure: 'bad-response', detail: 'Reply lacks rate_limit.' }
      }
      const windows = [
        parseWindow('primary', rateLimit.primary_window),
        parseWindow('secondary', rateLimit.secondary_window),
      ].filter(Boolean)
      if (windows.length === 0) {
        return { failure: 'bad-response', detail: 'Reply has no primary or secondary usage window.' }
      }
      const credits = body.credits && typeof body.credits === 'object'
        ? {
            hasCredits: typeof body.credits.has_credits === 'boolean' ? body.credits.has_credits : null,
            unlimited: typeof body.credits.unlimited === 'boolean' ? body.credits.unlimited : null,
            // The live API uses null or a decimal amount; accept either JSON
            // numbers or numeric strings without turning a missing balance into 0.
            balance: num(body.credits.balance),
          }
        : null
      const planType = typeof body.plan_type === 'string' ? body.plan_type : null
      return {
        endpoint: baseUrl,
        data: {
          kind: 'quota',
          // QuotaPanel's common plan field plus the provider-specific alias.
          level: planType,
          planType,
          windows,
          ordinaryUsageAllowed: typeof rateLimit.allowed === 'boolean' ? rateLimit.allowed : null,
          spendControlReached: typeof body.spend_control?.reached === 'boolean' ? body.spend_control.reached : null,
          resetCreditsAvailable: num(body.rate_limit_reset_credits?.available_count),
          credits,
        },
      }
    },
  }, config)
}
