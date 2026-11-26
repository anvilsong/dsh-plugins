# dsh-plugin-model-discovery

Appends models from the latest published `pi-ai` catalog to `llm-pi-ai` providers
that already list their models explicitly. A sync never creates a provider, never
converts a provider that has no `models` list, and never edits, reorders or
removes an existing model entry. The one way this plugin turns such a provider
into a listed one is the explicit command `/model-discovery seed <provider>`,
which shows a preview first and writes only after you confirm it (see "Seed a
provider"). Listing the models by hand, as described below, stays possible. The
plugin does not replace `llm-pi-ai`, and it does not install or run any package.

## Before you enable

An `llm-pi-ai` provider works in one of two ways:

- **No `models` list** (or an empty one): it serves the whole pi-ai catalog that
  ships with DSH, with every field taken from that catalog.
- **A `models` list**: it serves exactly the models in that list.

Writing a list into a provider of the first kind would replace DSH's catalog for
it. So a sync refuses: it reports
`provider <id> serves pi-ai's installed catalog; list its models explicitly first (see README)`
and writes nothing. A sync, the automatic checks included, never converts such a
provider. You have two ways to give it a list:

- **The seed command.** `/model-discovery seed <provider>` previews a list of
  the ids DSH serves now, and writes it only after you type the confirm
  command. See "Seed a provider" below. It is the only command of this plugin
  that converts a provider.
- **By hand.** The steps below. They stay the way to go when you want to choose
  the list yourself.

To list the models by hand:

1. Configure the provider in DSH first, for example by signing in on the Models
   page. The plugin does not create providers.
2. Open your profile patch, `$DSH_HOME/profiles/<profile>/cordis.patch.yml`
   (by default `~/.dsh/profiles/web/cordis.patch.yml` for the `web` profile).
3. Find the row with `id: llm-pi-ai`. Under `config.providers.<provider>`, add a
   `models:` list with one `- id:` line for every model the provider shows in
   DSH's model picker now. Keep every other key in that block, and do not add a
   second `llm-pi-ai` row. If the block has `modelOverrides`, move each
   override's fields onto the matching `models` entry and delete
   `modelOverrides`: DSH refuses the two together.

   Example for `openai-codex` with the catalog that ships in DSH 0.2.2-rc.5
   (pi-ai 1.3.0). Use the models your own picker shows:

   ```yaml
   - id: llm-pi-ai
     name: '@deepseek-ai/dsh-llm-pi-ai'
     config:
       providers:
         openai-codex:
           # keep any keys that are already here
           models:
             - id: gpt-5.3-codex-spark
             - id: gpt-5.5
             - id: gpt-5.6-luna
             - id: gpt-5.6-sol
             - id: gpt-5.6-terra
             - id: gpt-6-astra
             - id: gpt-6-luna
             - id: gpt-6-sol
             - id: gpt-6.1-sol
   ```

4. Save the file. DSH watches the profile patch and reloads it; restart DSH if
   the picker does not change. Check that the picker shows the same models and
   reasoning levels as before.

An entry with only an `id` takes every other field (name, sizes, input,
reasoning levels, protocol, endpoint, compat switches) from DSH's installed
pi-ai catalog, so the listed models keep behaving as before. The trade-off: an
explicit list no longer follows DSH's bundled catalog. A model that a later DSH
release adds appears only when you or this plugin list it, and a model that a
release drops stays listed until you remove it.

## What a sync does

1. Reads `https://registry.npmjs.org/@earendil-works/pi-ai/latest` and takes its
   `version`.
2. For each provider in `providers`, fetches
   `https://unpkg.com/@earendil-works/pi-ai@<version>/dist/providers/data/<provider>.json`.
   Automatic checks skip a provider that was already checked at the same version
   since the plugin started; `/model-discovery sync` always fetches again.
3. Maps the catalog entries (see "What is copied" and "Skip rules").
4. Finds the one `llm-pi-ai` row that configures the provider. If several rows
   configure it, or several rows exist and none does, nothing is written and the
   sync reports why.
5. Appends the missing model ids to that provider's `models` list through DSH's
   `configEditor`. The additions are recomputed from the config the editor holds
   at write time, so entries that another writer just added are kept and never
   duplicated. If nothing is left to add at that point, the edit is abandoned
   and nothing is written.

**Fixed source.** Only those two URLs, built from the fixed package name, are
requested. Redirects are refused, each response body is limited to 1 MB, and
each request to `timeoutMs`. The plugin trusts what npm's `latest` tag and unpkg
serve: there is no signature or integrity check. No package is installed or
executed.

### What "additive" means

- Only providers that are already configured with a non-empty `models` list
  change.
- Only ids missing from that list are appended, at the end, at most 200 per
  provider per sync. The rest follow at the next check.
- Existing entries, other providers and the other keys of the config are kept
  as they were. Models that pi-ai removes upstream are not removed here.
- **Deleting a discovered model does not stick.** The next `/model-discovery sync`,
  the first automatic check after the plugin starts, or the next automatic check
  after a new pi-ai version adds it back if pi-ai still lists it. To keep a model out, remove its provider from `providers` or
  disable the plugin.
- DSH's `configEditor` rewrites the complete `llm-pi-ai` config block of your
  profile patch on every change. Comments inside that block are not kept.

### What is copied

- `id`, `name` (control characters removed, at most 120 characters),
  `contextWindow`, `input` (only `text` and `image`) and `reasoningEfforts`.
- `maxTokens` is **not copied**, and that is deliberate: in DSH a `maxTokens` on a
  model entry is also that model's default per-request output cap, while the
  upstream value is only a capability. A discovered entry therefore never asks a
  provider for a capability-sized output; a route that sets its own
  `defaultMaxTokens` still applies, and a cap you want goes on the entry by hand.
- Not copied: `api`, `baseUrl`, `compat`, `cost`, `inputLimits`, `maxTokens` and
  `type`. This means:
  - For a model that DSH's bundled pi-ai catalog already knows, DSH still takes
    those fields from its catalog (the provider's own `api` and `baseURL`
    settings, when set, win).
  - For a model that the bundled catalog does not know, DSH uses the provider's
    `api` and `baseURL` settings or, when they are unset, the protocol and
    endpoint that its bundled catalog uses for that provider. The model runs
    without upstream compat switches or input limits, and with zero cost
    metadata.
  - To avoid sending a model with the wrong protocol, the plugin adds a model
    only when its upstream `api` matches the protocol DSH will use. That is the
    provider's `api` setting; otherwise the single protocol of the models you
    already list; otherwise the single protocol of the upstream catalog. If none
    of these gives one answer, new models are skipped.
  - If DSH's bundled catalog for the provider mixes protocols and the provider
    sets no `api`, DSH refuses any model it does not know. The edit for that provider is then rejected and
    reported at each check, and no model is added to that provider until DSH
    ships that model.
- `reasoningEfforts` follows pi-ai's rules for the upstream `thinkingLevelMap`.
  For well-formed maps DSH offers the same levels with the same wire values that
  pi-ai would (checked against 100,000 random maps and every bundled catalog):
  - a string value (a short token) is copied;
  - `null` (unsupported) is left out, and DSH then marks that level unsupported.
    A copied `null` would mean something else in DSH: for `off` it means
    "supported", and for any other level DSH rejects it;
  - an absent `minimal`, `low`, `medium` or `high` is written with the level
    name as its value. This is exact only on the `openai-codex-responses`,
    `openai-responses` and `azure-openai-responses` protocols, where pi-ai
    sends the level name for an absent key. On other protocols pi-ai uses its
    own default instead (Anthropic and Bedrock send `low` for `minimal`), which
    DSH cannot express, so such a model is skipped;
  - an absent `off` is written as `off: null`, which DSH treats as supported
    with pi-ai's default for off;
  - an absent `xhigh` or `max` is left out (unsupported, as in pi-ai);
  - an unknown level is ignored. A malformed value (an empty string, a number,
    or a token with unsupported characters) is not treated as absent: that
    level becomes unsupported in DSH, although pi-ai would have offered it.
    No bundled pi-ai 1.3.0 map has such a value.

  For example, pi-ai 1.3.0's `{"xhigh": "xhigh", "minimal": "low"}` becomes
  `off: null, minimal: low, low: low, medium: medium, high: high, xhigh: xhigh`.
- A non-reasoning model gets no `reasoningEfforts`. DSH then uses its bundled
  catalog's reasoning capability for a model it knows, and treats any other
  model as non-reasoning.

### Skip rules

A catalog entry is skipped, and listed under "Skipped" in the result, when:

- its `id` is missing, empty, longer than 128 characters, or contains anything
  other than letters, digits and `. _ : / ~ + @ -`;
- its id already appeared earlier in the catalog;
- `type` is not `chat`;
- `provider` is not the requested provider;
- `api` is not the catalog group the entry sits in;
- `baseUrl` does not start with `https://` (a sanity check only; `baseUrl` is
  never copied);
- `contextWindow` or `maxTokens` is not a positive integer;
- `input` contains neither `text` nor `image`;
- `reasoning` is not a boolean;
- a reasoning model has no `thinkingLevelMap`, leaves out `minimal`, `low`,
  `medium` or `high` on a protocol other than the three Responses protocols, or
  the mapping leaves no level other than `off`;
- its protocol does not match (see above);
- the limit of 200 additions per provider per sync is reached (reported as a
  count).

If every entry of a provider's catalog is skipped, that provider is reported as
an error. A response over 1,000,000 bytes, invalid UTF-8 or invalid JSON is an
error.

## Seed a provider

`/model-discovery seed` is the only command that converts a provider that has no
`models` list into one that has. It writes a list of id-only entries (`- id: ...`)
of the models DSH serves for that provider now, and nothing else about the
models. It never runs on a timer, and a sync never calls it.

```text
/model-discovery seed <provider> [<api>]           # preview: nothing is written
/model-discovery seed <provider> [<api>] confirm   # write the plan that the preview showed
```

**Grammar.** The whole input is lowercased, so `SEED OpenRouter` works.
`<provider>` and `<api>` are lowercase letters, digits and hyphens, starting with a
letter or digit. `confirm` must be the last word. Anything else answers
`Usage: /model-discovery sync|status|seed <provider> [<api>] [confirm]` and touches
nothing. A seed works while `enabled` is false and for a provider that is not in
`providers`, and is refused when the plugin config is invalid.

**Preview.** A preview checks the config of the `llm-pi-ai` row that configures
the provider, asks DSH's `llm` service which model ids it serves for the provider
(`listModels`, bounded by `timeoutMs`), reads npm's `latest` and the provider
catalog of that version from the two fixed URLs, and prints the plan: the row, the
latest pi-ai version, how many ids DSH serves and which protocols the catalog
gives them, whether an `api` will be set, how many ids will be listed (in the
order DSH serves them), and every id that is left out with its reason. It
writes nothing, not even the receipt.

**Confirm.**

- A confirm needs a preview of the same provider and the same `<api>` (or none),
  run earlier in the same process. Every seed command that runs (one that is not
  refused as a usage error, by the config check or by the run lock) takes the
  stored preview for its provider and `<api>` out, so a preview is used once: a
  confirm that fails also uses it up, and a new preview replaces the old one.
- A restart, a plugin reload or a profile re-apply drops every preview. A confirm
  after that answers `There is no preview of /model-discovery seed <provider> [<api>] in this process. Run /model-discovery seed <provider> [<api>], read the plan, then add confirm.`
- The confirm computes the plan again from the served ids, npm, unpkg and the
  config, and compares it with the preview, the pi-ai version and the `api` the
  route sets included. If it differs (`The plan now differs from the preview (the served models, the catalog or the config changed); nothing was written. Run <command> again.`),
  nothing is written.
- The write goes through DSH's `configEditor`. Inside the editor's write the plan
  is computed once more from the config the editor holds. If another writer
  changed the provider since the preview, the write stops with the refusal that
  fits the change: `provider <id> already lists models; ...` when `models` was
  added, `<api> differs from the provider api setting <route api>; nothing was changed`
  when a different `api` was set, `provider <id> has modelOverrides, ...` when
  `modelOverrides` were added, and `provider <id> is not configured` when the
  provider was removed. Only a change that no refusal names, such as the same
  `api` set before the edit, ends with `the plan differs from the preview when the edit ran; nothing was written`.
  In every case nothing is written. An unrelated provider or key that changed
  since the preview is kept.
- Like every `configEditor` write, it rewrites the whole `llm-pi-ai` config block
  of your profile patch, so comments inside that block are not kept.

### Outcomes

| Command | What is written |
|---|---|
| `seed <provider> confirm`, the route already sets `api` | Every valid served id is listed. No `api` is added. |
| `seed <provider> confirm`, the served ids belong to one protocol in the latest catalog, or to none | Every valid served id is listed, ids that the latest catalog does not have included. No `api` is added. |
| `seed <provider>`, the served ids belong to several protocols and the route sets no `api` | An error with the count per protocol and one command for each. Nothing is written. |
| `seed <provider> <api> confirm` | `api: <api>` is written, unless the route already sets one, and only the ids whose protocol in the latest catalog is `<api>` are listed. |

The `<api>` you name must equal the route's own `api` when the route sets one. A
route `api` also decides when you name none.

### What is left out

A left-out id is not listed and is named, with its reason, in the preview, in
the reply and in the receipt (at most 200 ids; the rest are counted).

Without `<api>` an id is left out only when:

- it is empty, longer than 128 characters or contains anything other than letters,
  digits and `. _ : / ~ + @ -` (`id is empty, longer than 128 characters or has unsupported characters`); or
- DSH serves it twice (`duplicate id in the served list`).

With `<api>` the same two rules apply, and an id is also left out when:

- it is not a chat model of the provider in the latest catalog:
  `not a chat model of <provider> in the latest pi-ai catalog (<version>)`. This
  also covers ids that pi-ai has removed since DSH's bundled catalog;
- its protocol in the latest catalog is another one:
  `protocol <protocol> in the latest catalog, not <api>`;
- it has several chat entries in the latest catalog (`has more than one chat entry in the latest catalog, so its protocol is ambiguous`),
  or its entry names an `api` other than the group it sits in
  (`its latest catalog entry names api <a> but sits in group <g>`), or the group name is not a
  protocol name (`its catalog group name <g> is not a protocol name`). From the pi-ai source, pi-ai keeps the last of several entries
  and trusts the entry's own `api`, so the plugin gives such an id no protocol
  instead of guessing one.

Entries that are not `chat` (images, classifiers) never count, so an id that a chat
entry and an image entry share keeps its chat protocol.

### Why the protocol filter, and how it can fail

From the DSH source (not tried on a live Host): DSH sends every listed model on
the route `api` when its own bundled catalog does not describe the model, and
the route `api` wins over the catalog's for all listed ids, while the base URL
stays that of the installed entry. The plugin cannot read DSH's bundled catalog (pi-ai 1.3.0 in DSH 0.2.2-rc.5).
It judges protocols by the **latest** published catalog. So an id whose protocol
group changed between the two is either lost or misrouted:

- `seed openrouter openai-completions` leaves out
  `~anthropic/claude-fable-latest`, `~anthropic/claude-haiku-latest`,
  `~anthropic/claude-opus-latest` and `~anthropic/claude-sonnet-latest`. Those four
  aliases were `openai-completions` ids in pi-ai 1.3.0 and are `anthropic-messages`
  ids in 1.6.1. DSH serves them today; after the seed they are gone from the picker.
- `seed openrouter anthropic-messages` lists them. DSH keeps the endpoint of its
  installed catalog entry (`https://openrouter.ai/api/v1`), so it would send an
  Anthropic body to the completions endpoint. This is what the DSH source says; it was not tried on a live Host. For OpenRouter, do not use it.

The several-protocols refusal prints a command for every protocol, the
`anthropic-messages` one included. When the preview filters by `<api>` and any
served id starts with `~` (a channel alias), it adds a note with the number of
aliases listed and left out. Check those after the seed. This example comes from
the catalogs of 2026-11-25; other providers and later versions can differ.

### Refusals

A refusal answers with an error and writes nothing. A refusal of the plan or the
config reads `Seed of <provider> failed; nothing was written: <reason>`. The reason is one of:

- `provider <id> is not configured`, `the llm-pi-ai providers setting is not an object`,
  `the config of provider <id> is not an object`, `providers.<id>.models is not an array`;
- `provider <id> already lists models; seed only converts a provider that serves pi-ai's installed catalog (sync adds new models to a list)`;
- `provider <id> has modelOverrides, which DSH refuses together with models; move them onto model entries by hand first (see README)`;
- `the api setting of provider <id> is not a non-empty string`;
- `<api> differs from the provider api setting <route api>; nothing was changed`;
- `no served model uses <api> in the latest pi-ai catalog (protocols found: ...); nothing was changed`;
- `the served models of <provider> use several protocols in the latest pi-ai catalog: ... A route sends its models on one protocol, so name one (the other protocols' models are left out): <commands>. Nothing was changed.`;
- `the latest pi-ai catalog (<version>) has no chat model for provider <id>; nothing was changed`;
- `no id is left to list: none of the <n> served ids can be listed; nothing was changed`;
- `llm.listModels did not answer within <timeoutMs> ms`;
- `DSH serves no models for provider <id>`. From the DSH source, this is also
  the answer when the route names an `apiKeyEnv` that does not resolve, because
  `listModels` then returns an empty list. A route without an `apiKeyEnv` (a
  login, for example OAuth) gets the full list. Not verified on a live Host;
- `DSH serves more than 2000 models for provider <id>`, `llm.listModels did not return a list`,
  `llm.listModels returned an entry without an id`, and
  `llm.listModels returned a model of another provider (<id>)`;
- `the llm service is unavailable, so the served models cannot be listed`;
- the row errors of the row chooser: `@deepseek-ai/dsh-llm-pi-ai is not editable in this profile`,
  `provider <id> is configured in several llm-pi-ai rows (<ids>); nothing was changed`, and
  `provider <id> is not configured in any of the llm-pi-ai rows (<ids>)`;
- a failed npm or unpkg request, as in a sync (for example `HTTP 404`, `response exceeds 1 MB`).

These replies stand alone, without the `Seed of ... failed` prefix:

- `Model discovery is already running a sync or a seed.` A sync that you start
  during a seed answers `Model discovery is already syncing.`
- `Model discovery is disabled by its config: <reason>`
- `Usage: /model-discovery sync|status|seed <provider> [<api>] [confirm]`
- the no-preview and plan-differs texts above.

A reply that quotes catalog text, group names or the route `api` has control and
bidirectional-formatting characters replaced by spaces.

### Before it writes: the profile backup

A seed rewrites the whole `llm-pi-ai` block through DSH's config editor, which drops comments
inside that block. Before the edit the plugin copies the profile patch beside itself, to
`$DSH_HOME/profiles/web/cordis.patch.yml.bak-model-discovery-<UTC stamp>`, and the reply names
the copy. The copy is a real file: restore it to undo the seed entirely. If the copy cannot be
taken the seed still runs and the reply says so.

### The reply and the receipt

A successful confirm answers with the number of ids written, the `api` it added (or
`and no api`), the left-out block, the undo line, and this line: ``Next: add <provider> to the plugin's `providers` setting, then run /model-discovery sync so that new upstream models are appended.``

It also writes a receipt, `$DSH_HOME/model-discovery/seed-<provider>.json`
(default `~/.dsh/model-discovery/seed-<provider>.json`), next to `status.json`:

- It is replaced atomically, with mode 0600; a missing folder is created with
  mode 0700. The folder is shared by all profiles, the file does not name the
  profile, and a later seed of the same provider replaces it.
- Fields: `provider`, `row` (the id of the `llm-pi-ai` row), `version`,
  `apiAdded` (the `api` the seed wrote, or `null`), `listedCount`,
  `leftOutCount`, `leftOut` (at most 200 lines, the last one `and N more left out`
  when more ids were left out), `undo` and `seededAt` (milliseconds since the
  epoch). It stores no config value, no URL and no credential. Control and
  bidirectional-formatting characters are replaced by spaces, strings are capped
  at 2,000 characters and lists at 200 items.
- A receipt that cannot be written does not fail or undo the seed: the reply says
  `The receipt $DSH_HOME/model-discovery/seed-<provider>.json could not be written (<code>); the seed itself was kept.` Replies show the path as `$DSH_HOME/...`, never an absolute one.
  When the plugin knows no DSH home folder (`profileContext.home` is not set), the
  reply says `The receipt was not written: the plugin knows no profile folder. The seed itself is done.`

### Undo

Remove `models`, and `api` when the seed added it (`apiAdded` in the receipt), from
`providers.<provider>` in the `llm-pi-ai` row, or restore your backup of the
profile patch. The provider then serves DSH's installed catalog again. The edit
dropped the comments in that block, so only a backup brings them back.

## Local routes

A local route is a provider whose endpoint is a server you run, such as a llama.cpp
router. Its own `/models` reply is the authority for which models exist and for their
context, so this is the one place where the plugin may change an existing entry and —
on a confirmed manual command only — remove one.

```yaml
- id: model-discovery
  config:
    providers: []            # optional: a local-only profile
    localRoutes:
      llamacpp-local:
        baseURL: 'http://127.0.0.1:8898/v1'
        mode: manual         # manual (default) or auto
```

`/model-discovery local <provider>` previews and writes nothing:
`/model-discovery local <provider> confirm` writes that exact plan.

What a run reads and writes:

| the server says | what the plan does |
|---|---|
| `--ctx-size` (the launch window) | the entry's `contextWindow` follows it; `context_length` only produces a note when the two disagree |
| `--n-predict` | the entry's `maxTokens` follows it; `-1`/`0` (llama.cpp's "no limit") and an absent flag write nothing |
| a model the route lists | every other field is kept exactly (name, `reasoningEfforts`, `maxTokens` without a server value, `compat`, …) |
| a model the route does not list | appended as `{id, contextWindow, maxTokens?, input}` |
| a listed model the server no longer serves, `mode: manual` | removed, and named in the preview |
| a listed model the server no longer serves, `mode: auto` | kept and reported; an automatic run never removes |

- **Identity is the id only:** `aliases`, `can_remove`, `status.value`, `source` and
  `tags` never decide membership, and an unloaded model stays listed.
- **Fail closed:** an empty, malformed, oversized (over 2000 models) or non-JSON answer,
  a duplicate id, a malformed context or output flag, an unusable context, or a proposal
  that would empty the list writes nothing and names the reason.
- **`mode: auto`** makes the existing `refreshMs` timer poll the route (start and every
  refresh). It adds models and follows context and `--n-predict`, and never removes.
- **A manual route** is only touched when you run the command.
- **Preview then confirm:** the confirm needs the preview of the same provider from this
  process, is used once, and refuses when the server, the config or the mode changed in
  between. The whole `llm-pi-ai` block is rewritten, so comments inside it are lost; a
  copy of the profile patch is taken first and the reply names it.
- **Not checked on a live Host:** the probe, the write and the timer for a local route
  are covered by offline tests only. Whether a server really serves the window it
  advertises is the server's business, not this plugin's.

## Providers

The default `providers` is `[openai-codex]`. To also extend Kimi and OpenRouter (and
Anthropic, which gains nothing today; see below), add a row with the bare id `model-discovery` to your profile patch.
Its `config` **replaces the whole config**: keep every setting you changed from
the defaults, because anything you leave out takes the default.

```yaml
- id: model-discovery
  config:
    providers:
      - openai-codex
      - anthropic      # a sync adds nothing today; see the table below
      - kimi-coding
      - openrouter
```

A provider id here is the key under `providers` in your `llm-pi-ai` config and
must equal the file name `dist/providers/data/<id>.json` in the pi-ai package (from the DSH source;
check it against your own config). `kimi-coding` is the id
for Kimi.

| Provider | Before the first sync |
|---|---|
| `openai-codex` | List the models by hand (example above), or run `seed openai-codex`. Not verified on a live Host. |
| `anthropic` | A route that already lists models needs no seed. Otherwise `seed anthropic` lists 17 ids (the bundled 1.3.0 set) and writes no `api`. A sync then adds nothing today, and the list stops following DSH's bundled catalog: a Claude model that a later DSH release bundles with a sparse map is skipped on `anthropic-messages`, so it would not appear by itself. Seed it only if you want an explicit list. |
| `kimi-coding` | A route that already lists models needs no seed. Otherwise `seed kimi-coding`, no `api` written. A sync then adds 2 models today: `k3.1-pro` and `k3.1-pro-highspeed`. |
| `openrouter` | Run `seed openrouter openai-completions` first, read the preview, then confirm. Without `<api>` the seed refuses, because the served ids span several protocols in the latest catalog (unless the route already sets `api`). A sync then adds 51 models today. |

- A provider that already lists models needs no seed. The seed refuses it.
- A sync that answers `Models added: none.` is normal. Nothing new was left to add,
  or the new entries were skipped. The skipped ones are named under "Skipped".
- The checks of "Skip rules" apply: a reasoning model with a sparse
  `thinkingLevelMap` is skipped on protocols other than the three Responses
  protocols, and so is a reasoning model without any map. That is why only a few
  Anthropic models are accepted: on the 1.6.1 catalogs of 2026-11-25, `mapCatalog`
  accepts 3 of 18 `anthropic` entries and 5 of 6 `kimi-coding` entries. "Accepted"
  is not "added": a sync adds only accepted ids that the route does not list yet.
  With the bundled 1.3.0 set as the served set, the 3 accepted `anthropic`
  entries are already served, and the one new id, `claude-fable-5-2`, is skipped
  as a sparse map, so `anthropic` gains 0. `kimi-coding` gains 2 and `openrouter`
  gains 51. These numbers are computed from the catalogs and the plugin's
  mapping (see `docs/model-discovery-checklist.md`), not from a live sync, and
  the served set is assumed to equal the bundled catalog.
- On OpenRouter at 1.6.1, with the 396 chat ids of the bundled 1.3.0 catalog as
  the served set, `seed openrouter openai-completions` would list 326 ids and
  leave out 70: 19 ids that 1.6.1 puts in `anthropic-messages`, among them the
  four aliases above, and 51 ids that 1.6.1 no longer lists. This assumes that
  DSH serves exactly those 396 ids, which was not checked on a live Host. Read
  your own preview.
- DSH's schema sets no maximum length for a `models` list (from the DSH source,
  `dsh-llm-pi-ai/src/config.ts`; not checked on a live Host). The seed itself
  refuses more than 2000 served ids.

## Subagent routes (opt-in)

`syncAllowedModels` is `false` by default. DSH's
`subagent-model-selection-settings` `allowedModels` list decides which models a
subagent may be explicitly delegated to. It has an effect only when subagent
model selection is enabled in DSH, which is off by default. It is not the main
model picker: models that the plugin adds appear in the picker without it.

When `syncAllowedModels` is `true`:

- After a sync adds models, the plugin adds a `{provider, model}` route for
  exactly those models, unless the route already exists. It never adds routes
  for any other model, including models you listed yourself.
- The routes are merged inside the editor's write, from the current list, so
  routes that another writer just added are kept.
- If the route write fails, those models wait in memory and are retried at the
  next sync, even when no catalog model is new. A waiting model that you have
  since removed from the provider's list gets no route. The waiting list is lost
  when DSH restarts.
- A top-level Session created while subagent model selection is enabled
  records the allowed list and keeps it; subagent Sessions inherit their
  parent's list. Start a new Session to delegate to newly allowed models.

Turning this on widens an authorization list automatically whenever pi-ai
publishes a model. Leave it off unless you want that.

## Use

```text
/model-discovery sync     # check now and merge
/model-discovery status   # settings, last version, next automatic check, last result
/model-discovery seed <provider> [<api>]           # preview a seed, nothing is written
/model-discovery seed <provider> [<api>] confirm   # write the previewed seed
```

`seed` is described in "Seed a provider".

- The first automatic check runs right after the plugin starts, when `enabled`
  is true and DSH's `configEditor` is available. Later checks run every
  `refreshMs` (default six hours). `status` shows "Next automatic check" only
  while that timer exists, computed from the last tick.
- Automatic checks leave HMR's activation transaction before editing, so
  `configEditor` can open its own write transaction. This uses an internal field
  of DSH 0.2.2's HMR service. If a DSH release removes it, automatic edits are
  expected to fail with "HMR transactions cannot be nested" while
  `/model-discovery sync` keeps working (not verified on other DSH versions).
- `/model-discovery sync` also works while `enabled` is false. It is refused
  while another sync or a seed is running, and when the plugin config is invalid.
- A sync returns an error result whenever any step failed, even if other
  providers added models. The text lists models added, subagent routes added
  (when `syncAllowedModels` is on), skipped entries and errors separately.

## Status file

After each sync, the plugin writes `$DSH_HOME/model-discovery/status.json`
(default `~/.dsh/model-discovery/status.json`). All profiles share this one file.
It is replaced atomically. A missing folder is created with mode 0700 (an
existing folder keeps its mode), and the file is written with mode 0600.

Fields: `version`, `modelsAdded`, `routesAdded`, `pendingRoutes`, `skipped`,
`error`, `result` (the text of the last sync) and `finishedAt`. Control and
bidirectional-formatting characters (line breaks included) are replaced by
spaces, strings are capped at 2,000 characters and lists at 200 items. The
plugin itself adds no credentials, API keys or headers there. Skip reasons and
errors come from upstream data and from DSH and are copied as they are, up to
the caps above. They can quote a few characters of an unreadable npm or unpkg
response, and DSH's own error text, for example about a broken profile patch.

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
        syncAllowedModels: false
        localRoutes: {}
```

- `enabled` (default `true`): run automatic checks. `/model-discovery sync` works
  either way.
- `providers` (default `[openai-codex]`): a non-empty list of provider ids of
  lowercase letters, digits and hyphens, starting with a letter or digit.
  Duplicates are ignored. Each provider must already be configured with an
  explicit `models` list (see "Before you enable" and "Seed a provider"), and the
  upstream package must have `dist/providers/data/<id>.json`. "Providers" shows a
  row with Anthropic, Kimi and OpenRouter.
- `refreshMs`: an integer from 60,000 to 604,800,000 ms. Default 21,600,000 (six
  hours).
- `timeoutMs`: an integer from 1,000 to 120,000 ms per HTTP request. Default
  15,000.
- `syncAllowedModels` (default `false`): see "Subagent routes".
- `packageName`: must be `@earendil-works/pi-ai`. The URLs are built from that
  fixed name, so discovery cannot be pointed at another package or registry.
- `localRoutes` (default `{}`): self-hosted OpenAI-compatible endpoints this plugin
  keeps in step with their own server, one entry per provider id:
  `{ baseURL: 'http://127.0.0.1:8898/v1', mode: 'manual' | 'auto' }`. Only a loopback
  address (`127.x.x.x` or `[::1]`) with an explicit port and a plain path prefix is
  accepted, and it must equal that provider's `baseURL`. The route needs
  `api: openai-completions` and an existing, non-empty `models` list: seed it first,
  because a local route has no catalog to name its models from. A provider may not be
  both a catalog provider and a local route, and `providers` may be empty when at least
  one local route exists. See "Local routes".
- `providers`: when `localRoutes` is configured this list may be empty, so a
  local-only profile is expressible.

An invalid config is logged, no timer starts, and `/model-discovery sync` and
`status` report the error.

To change the settings, add a row to your profile patch with the bare id
`model-discovery` (the id that the bundle inserts, not `include:model-discovery`).
Its `config` replaces the whole config; keys that you leave out take the
defaults above.

```yaml
- id: model-discovery
  config:
    providers:
      - openai-codex
      - openai
```

To turn the plugin off:

```yaml
- id: model-discovery
  disabled: true
```

This package has no client half and no per-session state.

## Install

```sh
dsh plugin --profile web add "$PWD/packages/model-discovery"
```

Run this from the repository root, and replace `web` with your profile name. A
name that does not exist yet creates a new profile. Then follow "Before you
enable", run `/model-discovery sync` and read `/model-discovery status`.

Not verified: whether DSH needs a restart after `dsh plugin add` (restart it if
`/model-discovery` is missing), and whether the `dsh` command is on your PATH
with the desktop app. DSH asks you to quit the desktop app before running
`dsh plugin --profile desktop`.

## Limits and failure behavior

- The source is the upstream `pi-ai` package catalog, not a live provider
  `/models` endpoint. DSH's pi-ai adapter cannot list Codex models (Codex uses
  OAuth).
- A model in the pi-ai catalog does not prove that your provider account can
  use it. Entitlement, quotas, pricing, rate limits and live API availability
  are separate checks.
- If npm or unpkg cannot be reached, nothing is written and the next check
  retries.
- A rejected edit writes nothing, is reported, and is retried at the next
  check. Causes include DSH's own validation, a home patch or command-line
  overlay that overrides the `llm-pi-ai` config, a missing `configEditor`, and a
  missing `llm-pi-ai` row.
- A provider whose `models` is not an array, whose config is not an object, or
  whose `providers` setting is not an object is left untouched and reported.
- DSH validates the whole provider on each write. One upstream model that DSH
  rejects therefore blocks that provider's additions for that check. The plugin
  skips the cases it can detect beforehand (see "Skip rules").
- **Output cap: none is discovered.** The upstream `maxTokens` is a capability,
  not a request default, so neither the sync nor the seed writes it and no clamp
  is needed. A discovered model the installed catalog does not describe gets no
  entry cap at all; a model the installed catalog describes keeps the installed
  cap. Set `maxTokens` on an entry by hand when you want one.
- **`llm.listModels` is not verified on a live Host.** Not checked: what a running
  DSH returns. From the DSH source, it returns the chat models of the provider's
  route only, and an empty list when the route names an `apiKeyEnv` that does not
  resolve (a route without one gets the full list), which a seed reports as
  `DSH serves no models for provider <id>`. Compare the preview's
  served count with your model picker before you confirm.
- **The receipt folder is shared.** `$DSH_HOME/model-discovery/` is used by every
  profile, and `seed-<provider>.json` does not name the profile. A seed of the same
  provider from another profile replaces the receipt.
- **A hung edit holds the lock.** `configEditor.edit` has no time limit here. A
  hung edit keeps `/model-discovery sync` and `seed` answering `Model discovery is already running a sync or a seed.` (or `Model discovery is already syncing.`) until the edit ends or DSH restarts.
  `listModels` and the HTTP requests are bounded by `timeoutMs`.
- **Two processes can seed at once.** The lock lives inside one running plugin
  instance. A second DSH process, or an instance that a reload replaced while its
  seed still ran, is not blocked. `configEditor` serializes the writes, and the plan is
  checked again inside the write, so the second seed of the same provider gives up
  (`already lists models`). Not tested with two real processes.

Not verified:

- the live npm and unpkg responses (tests use fake data only), in particular
  that neither URL answers with a redirect, which the plugin refuses;
- whether Node's built-in `fetch` uses a proxy that you configured for DSH;
- how DSH's interface renders command text that contains upstream names;
- a seed on a live Host: every seed test uses a fake `llm` service, catalog and
  config editor, and the real OpenRouter shape is a fixture, not a download;
- behavior on DSH releases other than 0.2.2-rc.5.

## Development

```sh
node --test packages/model-discovery/test/*.test.mjs
```

The tests use fake catalog JSON, a fake `fetch` and a fake config editor. The
status-file test writes only to a temporary directory. No network, real profile
or `~/.dsh` data is touched. They cover:

- additive merges and idempotence;
- refusal to convert implicit catalogs, create providers or replace a malformed
  `providers` value;
- reasoning maps against pi-ai's rules, including pi-ai 1.3.0's sparse Codex
  maps and the refusal of sparse maps on other protocols;
- skip rules, the protocol check and the per-sync limit;
- concurrent writers for both lists, and abandoned no-op edits;
- the opt-in subagent routes and their retry;
- choosing the `llm-pi-ai` row;
- fetch limits (redirects, body size, timeout);
- status-file modes and sanitizing;
- the seed (`test/seed.test.mjs`): grammar and usage, preview without a write,
  confirm that needs a preview and uses it once, both outcomes (with and without
  `<api>`), left-out ids and their reasons (a fixture of the real four-group
  OpenRouter shape included), the refusals of the config, of `listModels`, of the
  catalog and of the row choice (not the `is not editable in this profile` one),
  the lock shared with sync, a hanging `listModels`, a changed config between
  preview and edit, the receipt (modes, contents, a failed write) and sanitized
  replies. Not covered by a test: that a restart or reload drops the previews, a
  hung `configEditor.edit`, two real processes, and the numbers of "Providers" (computed
  once from the catalogs, not by a test);
- error results, timer ticks and disposal.

## License

MIT
