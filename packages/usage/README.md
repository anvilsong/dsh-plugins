# dsh-plugin-provider-usage

[![npm version](https://img.shields.io/npm/v/dsh-plugin-provider-usage.svg)](https://www.npmjs.com/package/dsh-plugin-provider-usage)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/anvilsong/dsh-plugin-provider-usage/blob/main/packages/usage/LICENSE)

Provider balances and subscription quota inside
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
One plugin supports OpenRouter, Kimi Code, DeepSeek, GLM Coding Plan,
MiniMax Coding Plan, NewAPI, OpenAI Codex, and Anthropic Claude.

Usage appears inside configured provider cards. A composer chip follows the
active provider. `/usage-*` commands print the same data in a session.
The plugin reads existing DSH credentials; it does not need a separate
account list.

## Screenshots

### Usage inside provider cards

Configured providers show a compact usage summary in **Settings → Models**.
Select **details** to expand the full panel without leaving the provider card.

![Kimi Code and OpenRouter usage inside their provider cards](https://raw.githubusercontent.com/anvilsong/dsh-plugin-provider-usage/main/docs/images/models-provider-usage.webp)

### Composer chips

The chip follows the active provider. Select it to open the usage panel.

| OpenRouter active | Kimi Code active |
|---|---|
| ![OpenRouter composer chip showing key usage and remaining balance](https://raw.githubusercontent.com/anvilsong/dsh-plugin-provider-usage/main/docs/images/composer-openrouter-chip.webp) | ![Kimi Code composer chip showing quota usage](https://raw.githubusercontent.com/anvilsong/dsh-plugin-provider-usage/main/docs/images/composer-kimi-chip.webp) |

## Install

An existing DeepSeek Harness installation is required.

> The registry commands below work after this package is published on npm.
> Before publication, install a source checkout with the command in
> [Development](#development).

### Desktop app

1. Open **Settings → Plugins → Add plugin**.
2. Choose **Install a third-party plugin**.
3. Enter `dsh-plugin-provider-usage` and install it.
4. Enable the plugin. Restart the app if DSH requests it.

The `desktop` profile is managed by the app. Do not modify its package files
by hand.

### Web or another CLI profile

```sh
dsh plugin --profile web add dsh-plugin-provider-usage@latest
```

Replace `web` with your profile name when needed. Restart `dsh web` and
refresh the page after installation.

### Upgrade or remove

Use the same **Settings → Plugins** page on Desktop. For a CLI profile:

```sh
dsh plugin --profile web update dsh-plugin-provider-usage
dsh plugin --profile web remove dsh-plugin-provider-usage
```

Restart the host and refresh the page after changing the installed version.

## Compatibility and verification

- Verified with DeepSeek Harness Desktop **0.2.1-rc.3** and Cordis **4.0.5**.
- Node.js **22 or newer** is recommended for source development.
- The Web profile uses the same Host and Web APIs, but has not been verified
  separately.
- Older DSH versions are untested. The package declares its Cordis peer range
  so the host can reject an incompatible installation.

Provider verification is reported separately and honestly:

| Provider | Status |
|---|---|
| OpenRouter | Verified live against the real API |
| Kimi Code | Verified live against the real API |
| DeepSeek | Tested against the real reply shape; not yet run with a live key |
| GLM Coding Plan | Tested against the real reply shape; not yet run with a live key |
| MiniMax Coding Plan | Tested against the real reply shape; not yet run with a live key |
| NewAPI | Tested against the real reply shape; needs a self-hosted site |
| OpenAI Codex | Verified live against `/wham/usage` with an OAuth account |
| Anthropic Claude | Verified live against `/api/oauth/usage` with an OAuth account |

If a live reply differs from the parser,
[open an issue](https://github.com/anvilsong/dsh-plugin-provider-usage/issues).
Include the `/usage-<provider>` output, but remove all credentials and private
account data first.

## Provider login

OAuth login is built into this package. Use `/provider-login <provider>` or the
sign-in button on the provider card. When signed in, the card shows usage and a
re-authentication action. When no OAuth record exists, it shows the sign-in
button instead.

```text
/provider-login openai-codex
/provider-login anthropic
```

The command runs OAuth only. It appends no message to the conversation: the
sign-in link, any code, and progress appear in a question in the composer area.
The host still records the command itself (`command/run` and `command/done`) in
the session log. When the provider asks for something, the link is shown above
that request in the same question. In the Claude and Codex browser flows the
wait happens inside the paste-code question: sign in in the browser, or paste
the code there. While the flow waits on the browser with nothing to ask, the
question offers only **Cancel sign-in**. Expand the question text if it is cut
off, then copy the link.

Where the provider asks for text (the pasted code), you type the answer into the
question's **Other** field. Everything else cancels the sign-in: **Cancel sign-in**,
**Skip**, closing the question, and, on a choice between options, text typed into
**Other** that names none of them. That text is never passed on or logged.
A question the host cannot show (no question UI, or a session that is not a root
conversation) ends the sign-in with that reason instead of "cancelled"; use the
provider card, or add the credential in **Settings → Models**.

API keys are entered in **Settings → Models**. `/provider-login <provider> api-key`
is refused, because a question cannot mask a typed key. For the same reason, an
OAuth flow that asks for a secret is cancelled.

## Providers

| Provider | Source | Shows | Command | Chip shows under |
|---|---|---|---|---|
| OpenRouter | `/api/v1/key` + `/api/v1/credits` | credits, key meters (day/week/month), BYOK, limits | `/usage-openrouter` | `openrouter` |
| Kimi Code | `GET {base}/usages` | quota windows, requests, Extra Usage wallet | `/usage-kimi` | `kimi-coding` |
| DeepSeek | `GET {base}/user/balance` | balance per currency (granted / topped up) | `/usage-deepseek` | `deepseek`, `deepseek-official` |
| GLM Coding Plan | `GET {base}/api/monitor/usage/quota/limit` | 5-hour and 7-day windows, tool-call counts, plan level | `/usage-zhipu` | `zai-coding-cn`, `zai` |
| MiniMax Coding Plan | `GET {base}/v1/api/openplatform/coding_plan/remains` | 5-hour and 7-day windows | `/usage-minimax` | `minimax-cn`, `minimax` |
| NewAPI | `GET {baseUrl}/api/usage/token` | token quota as USD (granted / used / remaining) | `/usage-newapi` | none by default — set `gate` in config |
| OpenAI Codex | `GET {baseUrl}/wham/usage` | plan, quota windows, credits, reset credits | `/usage-codex` | `openai-codex` |
| Anthropic Claude | `GET {baseUrl}/api/oauth/usage` | weekly usage, extra usage, spend, breakdown | `/usage-anthropic` | `anthropic` |

Provider notes:

1. GLM's monitor API takes the raw key in `Authorization`, with no Bearer
   prefix.
2. MiniMax reports remaining percent. The plugin converts it to used percent.
3. NewAPI has no default site. It needs `enabled: true` and `baseUrl`.
4. Kimi uses an honest User-Agent. The plugin does not imitate another CLI.
5. OpenRouter account-wide credits require a management key. Ordinary keys
   still provide per-key usage and limits.
6. Codex reads the OAuth credential stored by DSH. Sign in through the
   provider card or run `/provider-login openai-codex` first.
7. Claude usage reads the OAuth credential stored by DSH. Sign in through the
   provider card or run `/provider-login anthropic` first.

## Credentials and security

| Provider | Default credential reference |
|---|---|
| OpenRouter | `OPENROUTER_API_KEY` |
| Kimi Code | `KIMI_CODING_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| GLM Coding Plan | `ZHIPU_API_KEY` |
| MiniMax Coding Plan | `MINIMAX_API_KEY` |
| NewAPI | `NEWAPI_API_KEY` |
| OpenAI Codex | `llm-pi-ai/openai-codex` (OAuth record) |
| Anthropic Claude | `llm-pi-ai/anthropic` (OAuth record) |

Configure model-provider keys in **Settings → Models**. The plugin also reads
credentials that the DSH credentials service resolves from its credential
store or environment.

Security properties:

1. The Host resolves a key only when it makes a request.
2. Raw keys stay in the Host process. Remote snapshots contain usage data,
   not credentials.
3. Keys go only to the configured provider endpoint. A custom `baseUrl`
   changes that destination, so use a site you trust.
4. Usage snapshots stay in memory. The plugin writes no usage history,
   account list, analytics, or telemetry to disk.

Every provider request follows the same outbound policy:

1. **Base URL.** A `baseUrl` must use `https`. Plain `http` is accepted only
   for `localhost`, `127.0.0.0/8` and `[::1]`, or when that provider's section
   sets `allowHttp: true`. With `allowHttp`, the Host log warns once at mount
   that the key travels unencrypted. A base URL with user info
   (`user:password@`), a query or a fragment is refused. A refused base URL
   leaves that provider unmounted, and the Host log has one warning that names
   the provider and the reason, never the user info or the query. OpenRouter
   has no `baseUrl`: its endpoints are fixed.
2. **Codex and Claude.** A `baseUrl` on another host than the default sends
   the OAuth sign-in token to that host. It works, and the Host log warns once
   at mount.
3. **Redirects.** A redirect to the same origin is followed at most 3 times,
   with the same headers. A redirect to another origin, a fourth redirect, or a
   redirect to an invalid target fails with `redirect-refused`; the failure
   text names only the target origin. The credential is never sent to another
   origin.
4. **Reply size.** A reply body larger than 1 MiB fails with `too-large`,
   whether its `Content-Length` says so or the body grows past 1 MiB while it
   is read. The request timeout covers the body read.
5. **Redaction.** The credential sent with a request is removed from every
   text value of the reply and from the request's failure texts before
   anything is stored. The key, its URL-encoded form, and any `Bearer <token>`
   of 16 or more characters that the server quotes appear as `[redacted]` in
   the state, the panel, the `/usage-*` reports and the Host log. Values
   shorter than 8 characters are not redacted. A failure detail is one line of
   at most 300 characters. The endpoint in a state or a report is the origin
   and path only.

## Surfaces

| Surface | Behavior |
|---|---|
| Settings → Models provider card | A compact usage line inside each provider's own card; click expands the full panel. Hidden when DSH reports the row's key as not configured, unless the row is an OAuth row (Codex, Claude) with a stored sign-in; it also stays empty until the first read has produced data or a failure |
| Composer chip | Follows the session's active provider; click opens the panel in a popover above the chip (below it when there is no room), kept inside the window. Escape, a click outside, or opening another chip closes it; Escape returns the focus to the chip. One chip popover is open at a time |
| Commands | `/usage-<provider>` refreshes, then prints a text report |

Provider cards register by settings namespace and then match each row's
provider route. This matters because all pi-ai rows share one settings
namespace. GLM covers `zai-coding-cn` and `zai`; MiniMax covers `minimax-cn`
and `minimax`.

Each chip reads the active provider from the shared per-session model
directory. A blank session resolves the catalog default. An unknown provider
hides the chip. The Host config can override a provider's `gate` list. This is
how a config-only provider such as NewAPI gets a chip and a card.

## Stale, unavailable and offline reads

A refresh can fail: a missing credential, an HTTP error, a timeout. The Host
keeps the last good data, so every surface can show it and say how old it is.

| You see | It means |
|---|---|
| `stale · read <time>` next to the card line or in the panel footer; the chip keeps its values and adds the word `stale`; the dot is at least amber | The last refresh failed but an earlier read exists. `<time>` is the last good read. The stale mark and the failure stay while the next refresh runs |
| `Usage unavailable` on the card; `unavailable !` and a red dot on the chip | The last attempt failed and there is no good read yet. The card also shows the failure text |
| `Host not reachable: <message>`, with the last data (if any) marked stale | The Remote call itself failed: the connection to the Host was lost. The Refresh button stays usable and the next good reply clears the note |
| `Usage is not available for this provider` and the Gateway's message in the secondary colour; no chip | The Host has no usage service for this provider (its row is disabled, or its mount failed) while other providers still answer. This is not an error, so nothing is red and the chip is hidden even with `showComposerChip: true` |

The client tells the last two apart by the failure code of the Remote reply,
not by its text: `gateway/invocation-unavailable`, `gateway/service-unavailable`,
`gateway/method-unavailable` and `gateway/definition-unavailable` mean the
service is missing; every other failure, and any rejected call, is a lost
connection. A reply that carries no code counts as a lost connection.

The expanded panel shows two different times: `Refresh failed at <time>:
<detail>` is the time of the failed attempt and `read <time>` the last good
read. A Host that sends no attempt time shows `Refresh failed: <detail>`
without a time. A time from today prints as a time; a time from another day
also prints its date.

Text reports (`/usage-<provider>`) end with a footer, printed once:

```text
Last good read: <time>
Warning: last refresh failed at <time> (<code>): <detail>
```

`Last good read: never` stands for a provider with no good read. The warning
line appears only while the last attempt failed, and it ends after `(<code>)`
when there is no detail. A report with stale data is still a success and
carries the last numbers; with no data at all the command answers with an error
`<Provider> usage unavailable: <detail>`.

A command that arrives while a refresh is running joins it: one request serves
the poll, the Refresh button and the command, and each gets the result of that
refresh, never a half-finished state.

## Configuration

The defaults are enough for the five public providers. NewAPI is disabled
until you configure its site.

To change defaults, override the included plugin row in
`~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: include:usage
  name: dsh-plugin-provider-usage
  config:
    providers:
      openrouter:
        enabled: true
        credentialRef: OPENROUTER_API_KEY
        showAccount: true
        showComposerChip: true
      kimi:
        enabled: true
        credentialRef: KIMI_CODING_API_KEY
        region: cn
        refreshMs: 120000
        timeoutMs: 15000
        showComposerChip: true
      deepseek:
        enabled: true
        credentialRef: DEEPSEEK_API_KEY
        showComposerChip: true
      zhipu:
        enabled: true
        credentialRef: ZHIPU_API_KEY
        region: cn
        showComposerChip: true
      minimax:
        enabled: true
        credentialRef: MINIMAX_API_KEY
        region: cn
        showComposerChip: true
      newapi:
        enabled: false
        credentialRef: NEWAPI_API_KEY
        # baseUrl: https://your-newapi-host.example
        # gate: ['your-provider-route-id']
```

**Config is replaced as a whole.** Restate every provider section you want to
keep. Do not add a second `- insert:` row for this plugin.

To enable NewAPI, change its section to `enabled: true`, set `baseUrl`, and
make `NEWAPI_API_KEY` available to the DSH credentials service. Set `gate` to
the model-provider route that should show its chip and card.

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `true`; NewAPI `false` | Mount or skip one provider without affecting the others |
| `credentialRef` | provider-specific | Credential reference resolved by DSH |
| `showComposerChip` | `true` | Show or hide the composer chip |
| `refreshMs` | `120000` | Poll interval; clamped to 30 seconds–1 hour |
| `timeoutMs` | `15000` | Request timeout; clamped to 5–120 seconds |
| `gate` | provider-specific | Provider route ids that show the chip and card |
| `region` | `cn` | `cn` or `global` for Kimi, GLM, and MiniMax |
| `baseUrl` | provider default | API base override; required for NewAPI |
| `allowHttp` | `false` | Accept a plain `http` `baseUrl` on a non-loopback host, such as a LAN relay; only the boolean `true` counts |
| `endpoint` | `key` | OpenRouter primary endpoint: `key` or `credits` |
| `showAccount` | `true` | Also request OpenRouter account-wide credits |

One provider's mount or request failure does not disable its siblings.
Within one provider the three surfaces fail separately:

- If the Remote service cannot be provided, nothing else of that provider is
  mounted (no command, no poll) and the Host log names the provider.
- If the `/usage-<provider>` command cannot be registered (a duplicate name,
  say), that is logged once and the service and the poll stay mounted, so the
  card still refreshes.
- If the poll effect cannot start, the service and the command stay mounted
  but nothing polls; the Host log names the provider and the poll.
- The sign-in service and the `/provider-login` command are independent of each
  other and of the eight providers: a failure of one is logged and the others
  stay mounted.

A failed refresh keeps the last good data and its read time (`fetchedAt`),
records the time of the attempt (`attemptedAt`), and keeps the error and its
detail while the next refresh runs. Any other failure inside a refresh ends in
an `unexpected` error state, never in a state stuck at `loading`.

## Troubleshooting

- **No usage line on a provider card:** the card is hidden when DSH reports
  that row's key as not configured, unless the row is Codex or Claude with a
  stored sign-in. It also stays empty until the first read has produced data
  or a failure. NewAPI also needs a `gate` matching an existing provider route.
- **`Usage is not available for this provider`:** the Host has no usage
  service for that row. Check that its `enabled` option is not `false` and look
  for `usage: provider "<id>" failed to mount` in the Host log.
- **`Host not reachable: <message>`:** the Remote call to the Host failed. Check
  that the Host is running, then reload the page.
- **`stale`:** the last refresh failed; the figures are from the time shown.
  Open the panel for the failure and press **Refresh**.
- **Kimi returns HTTP 401:** use a Kimi Code Console key, not a Kimi Platform
  key. Check the configured region as well.
- **A command reports an error:** the report includes the credential,
  timeout, network, HTTP, or response-shape failure. Use that text when
  opening an issue.
- **The UI did not change after configuration:** restart the Host, then
  reload the Web page.

## Development

The package is plain JavaScript ESM. It has no build step and no bundled
runtime dependencies.

```sh
git clone https://github.com/anvilsong/dsh-plugin-provider-usage.git
cd dsh-plugin-provider-usage

node --check packages/usage/src/index.host.js
node --check packages/usage/src/client.js

# Link the working copy into a development profile:
dsh plugin --profile web add "$PWD/packages/usage"
```

Reload the page after a client-only change. Restart the Host after a Host or
composition change. Run `npm pack --dry-run` from `packages/usage` before a
release to inspect the published file list.

## License

[MIT](https://github.com/anvilsong/dsh-plugin-provider-usage/blob/main/packages/usage/LICENSE)
