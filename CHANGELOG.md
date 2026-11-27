# Changelog

This repository has no tagged releases yet. Each package keeps its own version in
its `package.json`; the entries below describe changes by package.

## Unreleased

- **model-discovery**: refuses to write to a provider that has no explicit `models`
  list (an earlier build converted such a provider's implicit catalog into a list
  and could drop installed models); reasoning efforts now follow pi-ai's rules;
  `syncAllowedModels` is opt-in; fetches are bounded and never follow redirects;
  new `/model-discovery seed <provider> [<api>] [confirm]`: the only command that
  converts a provider without a `models` list (a sync never does; listing the models
  by hand also converts), a preview first, then a confirm that writes id-only entries
  (and the `api` when you name one and the route sets none, which also limits the list
  to the ids of that protocol in the latest catalog), with the
  left-out ids named, a receipt `$DSH_HOME/model-discovery/seed-<provider>.json`, and
  an undo; README sections "Seed a provider" and "Providers" (Anthropic, Kimi,
  OpenRouter); discovered entries no longer copy `maxTokens` (in DSH that is also the
  default output cap), a seed copies the profile patch beside itself first and names the
  copy, and `/model-discovery local <provider> [confirm]` reconciles a self-hosted
  OpenAI-compatible route (`localRoutes` in the config: loopback endpoint only, `manual` or
  `auto`) from its own `/models` reply: `contextWindow` follows `--ctx-size`, `maxTokens`
  follows `--n-predict` when the server states it, other fields are preserved, and only a
  confirmed manual run removes an entry (an automatic run never does); not verified on a
  live Host (`llm.listModels`, the output cap of discovered `maxTokens`, the local probe),
  see `docs/model-discovery-checklist.md`.
- **ultracode**: a bare `/ultracode` now toggles the mode. Projection state version 5.
- **advisor**: the `/advisor off` reply no longer overstates what stops.
- **usage**: 0.7.0. Documentation brought in line with the code and with the
  harness it runs on: the "Compatibility and verification" section now names
  DSH 0.2.2-rc.5 (Cordis 4.1.0) as what this release was built and tested
  against, and the OpenRouter and Kimi Code rows say plainly that they were
  last checked live on 0.2.1-rc.3 and never re-run since. No behaviour change.
- **usage**: README corrected against the code (override ids, `gate`, verification
  status); new Codex and Claude card images; all card and chip images are now
  rendered from the plugin's own client with sample data.
- **sessions**, **session-search-patched**, **router**, **explainer**, **code-review**:
  README corrections, install and requirement sections.
- **session-search-patched**: peer pins admit rc.3 and rc.5 together.
- **repository**: package metadata, LICENSE files, CI workflow, lockfile, SECURITY and
  CONTRIBUTING, and scrubbed personal paths from tracked text files.
- **docs**: redrawn menu and page images (marked as redraws, with sample data) in the router, advisor, ultracode,
  explainer and sessions READMEs; their sources are in `docs/images/src`.
