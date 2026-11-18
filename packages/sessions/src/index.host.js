// Host entry of dsh-plugin-sessions.
//
// Mounts the Remote service `sessionsManager` (src/service.js) over the host
// adapter (src/host-adapter.js), and nothing else: no agent-facing surface, no
// slash entry, no timer. Host services are read lazily by the adapter, so
// nothing is injected and the plugin starts even where a service is missing;
// the dashboard then reports why pruning is off.
//
// apply() never throws. An invalid config (for example a relative dataDir)
// is logged and the service runs read-only: capabilities.prune is false with
// the reason `sessions-manager/trash-unusable`. The Plugin Manager needs no
// Config schema (docs/store-safety.md, Config), so none is exported; the
// bundle patch carries the defaults of src/config.js.

import { createHostAdapter } from './host-adapter.js'
import { resolveSettings, SessionsManagerService } from './service.js'

export const name = 'sessions-manager'
export const inject = []

const describe = (error) => {
  try {
    return error instanceof Error ? String(error.message) : String(error)
  } catch {
    return 'an unreadable error'
  }
}

/**
 * @param {object} ctx plugin context
 * @param {Record<string, unknown>} [config] raw plugin config (see cordis.patch.yml)
 */
export function apply(ctx, config = {}) {
  let adapter
  try {
    adapter = createHostAdapter(ctx)
    const settings = resolveSettings(config, { home: adapter.home() })
    new SessionsManagerService(ctx, { adapter, settings })
  } catch (error) {
    const message = `sessions-manager: the dashboard service did not start: ${describe(error)}`
    try {
      if (adapter !== undefined) adapter.warn(message)
      else console.error(message)
    } catch { /* nothing left to report to */ }
  }
}
