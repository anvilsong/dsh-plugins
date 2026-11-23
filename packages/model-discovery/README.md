# dsh-plugin-model-discovery

Adds newly published `pi-ai` models to your DSH model catalog. It does not replace
`llm-pi-ai`, download an adapter, or change any existing model entry.

## What it does

On a schedule, the plugin reads the npm `latest` version of
`@earendil-works/pi-ai`, then fetches only that version's provider catalog JSON
from `unpkg.com`. New model ids are merged into the matching provider's `models`
array through DSH's `configEditor`.

The default provider is **`openai-codex`**. More providers can be added to the
`providers` list in the package patch.

- **Additive only.** Existing ids, custom fields, credentials and every other
  provider are preserved. Upstream deletions are not deletions here.
- **Idempotent.** A model id already in your config is never added again or
  replaced. An unchanged config is not rewritten.
- **Adapter-safe.** Only DSH-supported fields are copied: `id`, `name`,
  `contextWindow`, `maxTokens`, `input` and `reasoningEfforts`. Upstream `compat`,
  `cost`, `inputLimits`, `api`, `baseUrl` and `type` are not copied. Some upstream
  `compat` switches are intentionally not configurable in DSH.
- **Pinned source.** Only the npm registry's `latest` metadata and the matching
  versioned `unpkg.com` JSON files are fetched. No package is installed or
  executed.
- **Failure-safe.** One provider's fetch or edit failure does not stop other
  providers, and a rejected edit is not reported as an addition. The next check
  retries it.

New models appear in DSH only after they are published in the upstream `pi-ai`
catalog. **That does not prove your provider account can use them.** Provider
entitlement, quotas and live API availability are separate checks.

## Use

```text
/model-discovery sync     # fetch and merge now
/model-discovery status   # enabled providers, last version, additions and errors
```

The first automatic check runs at plugin start. After that, checks run every six
hours. Manual `sync` is always allowed, including while automatic discovery is
disabled in config.

## Config

The default patch row is:

```yaml
- insert:
    - id: model-discovery
      name: dsh-plugin-model-discovery
      config:
        enabled: true
        packageName: '@earendil-works/pi-ai'
        providers:
          - openai-codex
        refreshMs: 21600000
        timeoutMs: 15000
```

- `enabled`: start the periodic check at apply. `sync` still works when false.
- `providers`: non-empty list of provider ids. Every id must be lowercase and use
  only letters, digits and hyphens. The upstream package must have a matching
  `dist/providers/data/<id>.json`.
- `refreshMs`: 60,000 to 604,800,000 ms. Default 21,600,000 (six hours).
- `timeoutMs`: 1,000 to 120,000 ms per HTTP request. Default 15,000.
- `packageName`: currently pinned to `@earendil-works/pi-ai` so discovery cannot
  be pointed at another package or registry path.

Config changes that replace the whole row's config are intentional. This package
has no client half and no per-session state.

## Install

```sh
dsh plugin --profile web add "$PWD/packages/model-discovery"
```

Run from the repository root and replace `web` with your profile name when
needed (a wrong name creates a new profile). Restart the host after installing.
Then run `/model-discovery sync` and inspect `/model-discovery status`.

## Limits and failure behavior

- The discovery source is the **upstream `pi-ai` package catalog**, not a live
  provider `/models` endpoint. Codex has no such endpoint in this adapter.
- If npm or unpkg is unreachable, the last config is kept and the next check
  retries. No partial result is presented as a completed update.
- A provider config whose `models` is not an array is left untouched and reported.
- If `configEditor` is unavailable or the `llm-pi-ai` row is not editable in the
  active profile, sync fails with that reason. Nothing is written.
- If a home patch or command-line overlay overrides the target config, the editor
  rejects the write. Nothing is silently changed.
- The plugin does not validate that a discovered model is offered to your
  account, nor that its pricing, rate limits or capabilities are correct for your
  use. Check the provider before relying on a newly discovered model.
- `reasoningEfforts` maps upstream thinking levels to DSH's supported levels;
  unknown levels are ignored. A reasoning model with no usable map is skipped.
- Only `text` and `image` input modalities are kept. Other modalities are dropped;
  a model left with none is skipped.

## Development

```sh
node --test packages/model-discovery/test/*.test.mjs
```

Tests use fake catalog JSON and a fake config editor; no network, real profile or
`~/.dsh` data is touched. The suite covers additive merges, idempotence, version
changes, invalid catalog entries, fetch and editor failures, concurrent syncs and
timer disposal.

## License

MIT
