/**
 * Usage plugin — Host half.
 *
 * One plugin, one row in the bundle patch, one fiber. Each of the eight usage
 * providers (OpenRouter, Kimi, DeepSeek, GLM, MiniMax, NewAPI, Codex, Claude)
 * is an isolated module under `providers/` that mounts its own Remote service,
 * its own `/usage-*` command, and its own poll timer. A ninth module, the
 * provider sign-in service (`providerLogin`, `/provider-login`), is mounted
 * once for all of them. Isolation rule: one provider's mount failure is
 * logged and skipped — it must never take any sibling provider down.
 *
 * Config shape (bundle patch), one key per provider:
 *   providers:
 *     openrouter: { enabled, credentialRef, endpoint, showAccount, refreshMs, timeoutMs, showComposerChip }
 *     kimi:       { enabled, credentialRef, region, baseUrl, refreshMs, timeoutMs, showComposerChip }
 *     deepseek:   { enabled, credentialRef, baseUrl, refreshMs, timeoutMs, showComposerChip, gate }
 *     zhipu:      { enabled, credentialRef, region, baseUrl, refreshMs, timeoutMs, showComposerChip, gate }   (GLM)
 *     minimax:    { enabled, credentialRef, region, baseUrl, refreshMs, timeoutMs, showComposerChip, gate }
 *     newapi:     { enabled, credentialRef, baseUrl, refreshMs, timeoutMs, showComposerChip, gate }
 *     codex:      { enabled, credentialRef, baseUrl, refreshMs, timeoutMs, showComposerChip, gate }
 *     anthropic:  { enabled, credentialRef, baseUrl, refreshMs, timeoutMs, showComposerChip, gate }   (Claude)
 *
 * Remote namespaces stay per provider (`openrouterUsage`, `kimiUsage`,
 * `deepseekUsage`, `zhipuUsage`, `minimaxUsage`, `newapiUsage`, `codexUsage`,
 * `anthropicUsage`), and so do the command names (`/usage-openrouter`,
 * `/usage-kimi`, `/usage-deepseek`, `/usage-zhipu`, `/usage-minimax`,
 * `/usage-newapi`, `/usage-codex`, `/usage-anthropic`): the package merged,
 * the surfaces did not.
 */

import { mountOpenRouter } from './providers/openrouter.js'
import { mountKimi } from './providers/kimi.js'
import { mountDeepSeek } from './providers/deepseek.js'
import { mountZhipu } from './providers/zhipu.js'
import { mountMiniMax } from './providers/minimax.js'
import { mountNewApi } from './providers/newapi.js'
import { mountCodex } from './providers/codex.js'
import { mountAnthropic } from './providers/anthropic.js'
import { mountProviderLogin } from './providers/login.js'

export const name = 'usage'

/**
 * Services this half needs. `credentials` resolves API keys per call;
 * `commands` mounts the report commands. Both ship in dsh-base.
 */
export const inject = ['credentials', 'commands', 'authorization', 'userQuestions']

export function apply(ctx, config = {}) {
  const providers = config && typeof config === 'object' ? (config.providers ?? {}) : {}

  const mounts = [
    ['openrouter', mountOpenRouter, providers.openrouter ?? {}],
    ['kimi', mountKimi, providers.kimi ?? {}],
    ['deepseek', mountDeepSeek, providers.deepseek ?? {}],
    ['zhipu', mountZhipu, providers.zhipu ?? {}],
    ['minimax', mountMiniMax, providers.minimax ?? {}],
    ['newapi', mountNewApi, providers.newapi ?? {}],
    ['codex', mountCodex, providers.codex ?? {}],
    ['anthropic', mountAnthropic, providers.anthropic ?? {}],
  ]

  for (const [id, mount, cfg] of mounts) {
    if (cfg && cfg.enabled === false) {
      continue
    }
    try {
      mount(ctx, cfg ?? {})
    } catch (error) {
      // A misconfigured provider must not block the sibling, nor the fiber.
      console.error(`usage: provider "${id}" failed to mount:`, error)
    }
  }

  // OAuth login and status share the same package and provider cards as usage.
  // It never throws on its own; the guard keeps apply() whole if that changes.
  try {
    mountProviderLogin(ctx)
  } catch (error) {
    console.error('usage: provider sign-in failed to mount:', error)
  }
}