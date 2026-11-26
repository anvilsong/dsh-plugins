# model-discovery: live checks (manual, not run by tests)

Runbook for checks that need the real DSH, the real pi-ai catalog or the profile on
this machine. Tests never run these. Each check records the command that produced it
and its result, so a reader can repeat it.

Versions at the time of writing: DSH 0.2.2-rc.5 bundles `@earendil-works/pi-ai`
1.3.0; npm `latest` was **1.6.1** (published 2026-11-25). The catalogs used below were
downloaded to `/tmp/cat-<provider>.json` and `/tmp/or-1.3.0.json`:

```sh
curl -sS "https://unpkg.com/@earendil-works/pi-ai@1.6.1/dist/providers/data/<provider>.json" -o /tmp/cat-<provider>.json
curl -sS "https://unpkg.com/@earendil-works/pi-ai@1.3.0/dist/providers/data/openrouter.json" -o /tmp/or-1.3.0.json
```

GO / STOP: **GO** for the seed design with a protocol-restricted list. Sync can
extend a seeded provider only with ids that are accepted (see "mapCatalog") **and**
not already served: computed from the catalogs, that is 0 for `anthropic`, 2 for
`kimi-coding` and 51 for `openrouter` (see "What sync adds after a seed"). See
"Decision" at the start of the file.

## Decision: how the seed lists a provider

The seed lists only the ids DSH serves whose latest catalog group equals the route
`api` it writes, and names every other id as left out.

- **Why not "list everything and write the api":** DSH sends a listed model on the route
  `api` (`packages/model-discovery/README.md`, "What is copied"). The 15 `anthropic/*` Claude
  models OpenRouter serves are `anthropic-messages` in the bundled catalog, with base URL
  `https://openrouter.ai/api`; listed under `api: openai-completions` they would go to
  `https://openrouter.ai/api/v1` with a completions body. The 4 `~anthropic/*-latest` aliases are
  the reverse case: `openai-completions` at `https://openrouter.ai/api/v1` in 1.3.0, moved to
  `anthropic-messages` in 1.6.1, so a completions route serves them the same way it does today
  and the list drops them only because the filter follows 1.6.1.
- **Left out on OpenRouter (`seed openrouter openai-completions`):** 19 served ids that
  1.6.1 puts in `anthropic-messages` plus 51 chat ids of 1.3.0 that 1.6.1 no longer
  lists, 70 in all. With the 396 bundled chat ids as the served set, 326 are listed.
  Correction of an earlier version of this file, which said 20 + 51.

## listModels

- **What it returns:** not checked on a live Host yet. From the DSH source it maps the
  chat models of the route only (so non-chat models are not included), and returns `[]`
  when the route names an `apiKeyEnv` that does not resolve; a route without an
  `apiKeyEnv` (a login, for example OAuth) returns the full list. The host service catalog
  describes `llm.listModels(provider)` as "Discover models advertised by one
  registered provider … detached model metadata in adapter-preferred order"
  (`LlmModelInfo { provider, id, name, description?, inputModalities?, badge? }`).
  It carries no wire protocol and no base URL.
- **Not verified on a live Host:** the points above, and whether it reads only the
  installed catalog or asks the provider's `/models` endpoint.
- **Consequence for the design:** the seed keeps the served set exactly as returned,
  and needs the protocol only to decide which ids may be listed under the chosen
  `api`. A wrong set costs a wrong list, not a wrong protocol.
- **To check:** `/model-discovery seed openrouter` previews the served set without
  writing. Compare its count with the picker.

## unknown model on a route with api

- **DSH rule:** `api = request.api ?? base?.api ?? sharedCatalogApi(defaults)`, and
  `baseUrl = request.baseURL ?? base?.baseUrl ?? providerBaseUrl`
  (`dsh-llm-pi-ai/src/catalog.ts`, `resolveEntry`). A model the installed catalog does
  not describe is served on the route `api`, with no `compat`, no `inputLimits` and
  zero cost metadata (`packages/model-discovery/README.md`, "What is copied").
- **Maximum length of a provider's `models` list:** none in DSH's schema, from the DSH
  source (`packages/model-discovery/docs/seed-review.md`, section 8); not checked on a
  live Host.
- **Not verified:** which `max_tokens` DSH sends for an entry that sets `maxTokens` when
  the request names no cap (the plugin README says the entry's value is the default
  cap, from the DSH source).

## mapCatalog on the real 1.6.1 catalogs

Command:

```sh
node -e "import('./packages/model-discovery/src/discovery.js').then(m=>{const fs=require('fs');for(const [p,f] of [['openrouter','/tmp/cat-openrouter.json'],['anthropic','/tmp/cat-anthropic.json'],['kimi-coding','/tmp/cat-kimi-coding.json']]){const c=m.mapCatalog(JSON.parse(fs.readFileSync(f,'utf8')),p);console.log(p,c.models.length,c.issues.length)}})"
```

Results (2026-11-25, Node 24.22.3):

| provider | accepted | issues | groups |
|---|---|---|---|
| openrouter | 304 | 226 | 118 non-chat types, 87 reasoning models with no `thinkingLevelMap`, 21 sparse maps |
| anthropic | 3 | 15 | 9 sparse maps, 6 without `thinkingLevelMap` |
| kimi-coding | 5 | 1 | 1 sparse map |

- **openrouter / google/gemini-4-neon:** accepted, `reasoningEfforts`
  `{low, medium, high, xhigh}`, context 1048576, maxTokens 943718.
- **Fable:** `claude-fable-5-2` is NOT accepted. Its 1.6.1
  `thinkingLevelMap` is `{xhigh, max, off}` only, and a sparse map on
  `anthropic-messages` is refused (`mapCatalog`, the sparse-map rule; README "Skip rules"): on that protocol an
  absent `minimal` is pi-ai's own `low` default, which DSH cannot express.
- **Follow-up (separate from this plan):** `reasoningEfforts` on a listed entry is a
  complete declaration in DSH (an absent level becomes `null`, an explicit `null` is
  refused; see "What is copied" in `packages/model-discovery/README.md`). So a discovery-mapped model could
  carry explicit `null`s instead of being skipped, when the installed catalog already
  describes the model. That needs its own consult and is not built here.
- **Kimi:** `kimi-for-coding-highspeed` has a 1.6.1 map `{off: null}` only, so it is
  skipped; the other five are accepted.
- **Add to `providers`:** a provider is worth adding only when it has an entry that is
  accepted **and not already served**. `kimi-coding` has two (see "What sync adds after
  a seed"); `anthropic` has none today, because its 3 accepted entries are already
  bundled and the one new id is skipped.

## openrouter 1.3.0 against 1.6.1

| | 1.3.0 | 1.6.1 |
|---|---|---|
| chat ids | 396 | 412 |
| `openai-completions` chat ids | 381 | 392 |
| `anthropic-messages` chat ids | 15 | 20 |

- **Group changed:** 4 channel aliases moved from `openai-completions` (1.3.0) to
  `anthropic-messages` (1.6.1): `~anthropic/claude-fable-latest`,
  `~anthropic/claude-haiku-latest`, `~anthropic/claude-opus-latest`,
  `~anthropic/claude-sonnet-latest`. An earlier version of this file stated the move
  backwards. Consequence: `seed openrouter openai-completions` leaves the four out
  (DSH serves them today), and `seed openrouter anthropic-messages` lists them with the
  `/api/v1` base URL of their installed entries (DSH source; not tried on a live Host).
- **Removed:** 51 chat ids present in 1.3.0 are absent from 1.6.1, all
  `openai-completions`.
- **Base URLs per group (1.6.1):** `anthropic-messages` `https://openrouter.ai/api`; the
  other three groups `https://openrouter.ai/api/v1`.
- **Absent from 1.3.0:** `google/gemini-4-neon` is (it is new in 1.6.1).
- **Left-out set of a seed under `openai-completions`:** 19 `anthropic-messages` chat
  ids (1.6.1 has 20; 19 of them are in the served set, per `packages/model-discovery/docs/seed-review.md`)
  and the 51 removed chat ids, 70 in all; 396 served minus 70 is 326 listed. This assumes that DSH serves exactly the
  396 bundled chat ids (not checked on a live Host). All of them are only served while
  the route has no `models` list.

## What sync adds after a seed

Computed from the catalogs of 2026-11-25 (1.6.1) with `mapCatalog`, assuming that DSH
serves exactly the ids of its bundled 1.3.0 catalog. **Not** from a live sync.

| provider | `seed` lists | sync adds today |
|---|---|---|
| anthropic | 17 ids, no `api` | 0: the 3 accepted entries are already served; the one new id, `claude-fable-5-2`, is skipped as a sparse map |
| kimi-coding | the bundled ids, no `api` | 2: `k3.1-pro`, `k3.1-pro-highspeed` |
| openrouter | 326 ids under `openai-completions` | 51: of the 52 accepted ids not served today, `anthropic/claude-fable-5.2` is `anthropic-messages` and is skipped on the `openai-completions` route |

A seeded `anthropic` list stops following DSH's bundled catalog: a Claude model that a
later DSH release bundles with a sparse map would not appear by itself (sync skips it
on `anthropic-messages`). Leave `anthropic` unseeded unless you want an explicit list.

## max_tokens

- **What the plugin writes:** `maxTokens` from the catalog, and in DSH a `maxTokens` on
  an entry is also that model's default per-request output cap
  (`packages/model-discovery/README.md`, "What is copied").
- **For neon:** 943718, from the 1.6.1 catalog.
- **OpenRouter's answer at that cap:** not checked. The plan records it in the rollout
  step; a refusal (for example 402) is fixed by hand on that entry.

## Rollout (not run yet)

Order matters. Editing the `model-discovery` row of your profile patch replaces its whole
config, re-applies the plugin (which drops every pending seed preview), and starts an
automatic check at once. That check reports an error for every provider in `providers`
that has no `models` list yet. So seed first and edit `providers` last.

1. Back up the profile patch (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`).
2. Preview and confirm each seed, one provider at a time, without editing the
   `model-discovery` row in between:
   - `/model-discovery seed openrouter openai-completions`: read the preview; the served
     count must match the picker, and the left-out ids are the ones above (70 on the
     numbers above). Plain `seed openrouter` is refused: the served ids span two
     protocols. Then `/model-discovery seed openrouter openai-completions confirm`.
   - `/model-discovery seed kimi-coding`, then `... confirm` (a single protocol, so no
     `api` is written).
   - `anthropic` only if you want an explicit list (it gains nothing today, see above).
   A route that already lists its models needs no seed; the seed refuses it.
3. Edit the `providers` list of the `model-discovery` row (`openai-codex` and the seeded
   providers; keep every other key you changed, because the row's config replaces the
   whole config).
4. Run `/model-discovery sync` and compare its result with "What sync adds after a seed"
   (expected: `kimi-coding` 2, `openrouter` 51).
5. Check that the picker shows `google/gemini-4-neon` with low, medium, high and xhigh.
6. Make one request to it and record the outcome.
7. Undo: for every seeded provider, remove `models` (and `api` where the receipt
   `$DSH_HOME/model-discovery/seed-<provider>.json` says `apiAdded`, which is the case for
   `openrouter`) from `providers.<provider>`, and take the provider out of the
   `model-discovery` row's `providers` list; or restore the backup from step 1.

## Local routes (llama.cpp) — built (plan bd791fa9ddef)

The module (`packages/model-discovery/src/local-discovery.js`) and the Host wiring
(`/model-discovery local <provider> [confirm]`, the `localRoutes` config, the automatic poll)
are built; all of it is covered by offline tests only. The rules below reflect the user's
decision of 2026-11-26: `--ctx-size` is the authority for context, and `--n-predict` supplies
`maxTokens` when the server states it.

Rules the tests pin (all offline, `test/local-discovery.test.mjs`):

| situation | what the plan does |
|---|---|
| `--ctx-size` and `context_length` agree | use the value |
| they disagree | use **`--ctx-size`** (the launch window) and add a note with both numbers |
| `--n-predict N` present and positive | write `maxTokens: N` on the entry |
| `--n-predict` absent, `-1` or `0` | write no `maxTokens`; a cap you set stays |
| the flag is missing or malformed, or repeats | try `context_length`; if that is missing too, fail the whole snapshot |
| a `-c` context flag | refused (unsupported spelling) |
| a listed id the server also serves | keep every field, update only `contextWindow` |
| a listed id the server no longer serves, mode `auto` | keep it, report it as a pending removal |
| a listed id the server no longer serves, mode `manual` | remove it |
| a model the server serves that the route does not list | append it as `{id, contextWindow, input}` |
| no listed id survives (`manual`) | refused: the list would be empty |
| a proposed context below the entry's own `maxTokens` | refused |

- **Identity is the id only:** `aliases`, `can_remove`, `status.value`, `source` and `tags`
  never decide membership, and an unloaded model stays listed.
- **URL pin:** only `http`/`https` to a dotted `127.x.x.x` literal or `[::1]`, with an
  explicit port and a plain path prefix such as `/v1`; `localhost`, LAN addresses,
  credentials, queries, fragments, encoded bytes and dot segments are refused.
- **The three 524288/262144 models** (`Flash-Next-Uncensored:IQ3_XXS`, `Flash-Next:IQ3_XXS`,
  `Qwen3.8-27B:Q4_K_XL`): the plan now writes 524288 and adds a note. The user states the
  server serves it; a request at that window has not been made through DSH.
- **To roll out:** add `localRoutes: { llamacpp-local: { baseURL: 'http://127.0.0.1:8898/v1', mode: 'auto' } }`
  to the `model-discovery` row, restart DSH, run `/model-discovery local llamacpp-local`,
  read the preview (the three context changes, no maxTokens), then confirm. A copy of the
  profile patch is taken first.
- **Not verified live:** the probe, the write and the timer for a local route.
