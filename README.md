# dsh-plugin-provider-usage

Provider balances and subscription quota inside DeepSeek Harness.
OpenRouter, Kimi Code, DeepSeek, GLM Coding Plan, MiniMax Coding Plan, NewAPI,
OpenAI Codex, and Anthropic Claude are supported in one package.

## Install

### Desktop app

Open **Settings → Plugins → Add plugin → Install a third-party plugin**.
Enter `dsh-plugin-provider-usage`, install it, and enable it.

### Web or CLI

```sh
dsh plugin --profile web add dsh-plugin-provider-usage@latest
```

Replace `web` with your profile name when needed. Restart the Host and
refresh the page after installation.

> Registry installation requires the package to be published on npm. To try
> the source checkout before publication, use the development command below.

Read the [complete installation, configuration, and security guide](packages/usage/README.md).

## Preview

Usage appears inside configured provider cards. A composer chip follows the
active provider.

![Provider usage in Settings → Models](docs/images/models-provider-usage.webp)

| OpenRouter chip | Kimi Code chip |
|---|---|
| ![OpenRouter usage chip](docs/images/composer-openrouter-chip.webp) | ![Kimi Code usage chip](docs/images/composer-kimi-chip.webp) |

Codex and Claude cards sign in with your plan through OAuth. These two images
use sample data and an approximate dark theme rendered from the plugin's own
test gallery, so they show layout, not real figures or exact colours:

| OpenAI Codex | Claude |
|---|---|
| ![OpenAI Codex usage card](docs/images/provider-card-codex.webp) | ![Claude usage card](docs/images/provider-card-claude.webp) |

## Packages

| Directory | npm package | Purpose |
|---|---|---|
| [`packages/usage`](packages/usage) | `dsh-plugin-provider-usage` | Provider-card usage, active-provider composer chips, and `/usage-*` commands |
| [`packages/ultracode`](packages/ultracode) | `dsh-plugin-ultracode` | Per-session exhaustive orchestration mode, a composer switch, and `/ultracode` |
| [`packages/advisor`](packages/advisor) | `dsh-plugin-advisor` | In-process read-only advisor (task plans and design/review advice) on a chosen model, a read-only evidence verifier, and `/advisor` |
| [`packages/router`](packages/router) | `dsh-plugin-router` | Lead-controlled model routing with three complexity-level shortlists and `/router` |
| [`packages/explainer`](packages/explainer) | `dsh-plugin-explainer` | Per-session output style that picks the lowest clear explanation form, with `/explain-style` and a model-options switch |
| [`packages/code-review`](packages/code-review) | `dsh-plugin-code-review` | Bounded code review with two independent finders and one refuter |
| [`packages/sessions`](packages/sessions) | `dsh-plugin-sessions` | Owner-only Sessions page: store sizes, archived sessions, and a reversible prune into a trash folder (macOS) |
| [`packages/model-discovery`](packages/model-discovery) | `dsh-plugin-model-discovery` | Scheduled, additive-only discovery of newly published pi-ai models, with `/model-discovery sync` and `status` |
| [`packages/session-search-patched`](packages/session-search-patched) | `dsh-plugin-session-search-patched` | Unofficial patched engine for the optional session search (bounded index; pinned to DSH 0.2.2-rc.3, the shipped engine serves otherwise); install by folder path |

## Repository layout

- `packages/usage/src/index.host.js` is the Host entry.
- `packages/usage/src/providers/` contains one isolated module per provider.
- `packages/usage/src/client.js` is the self-contained Web client.
- `packages/usage/cordis.patch.yml` declares the plugin row and defaults.
- Packages ship directly from `src/`. No build or copy step is required.

## Development

```sh
git clone https://github.com/anvilsong/dsh-plugin-provider-usage.git
cd dsh-plugin-provider-usage

node --check packages/usage/src/index.host.js
node --check packages/usage/src/client.js

# Link this checkout into a development profile:
dsh plugin --profile web add "$PWD/packages/usage"
```

Replace `web` with another development profile when needed. Use the Desktop
app's **Settings → Plugins** page for normal Desktop installations.

Reload the page after a client-only change. Restart the Host after a Host or
composition change.

Verifying client plugins: follow the [manual live menu checklist](docs/live-menu-checklist.md).

## License

The usage package is [MIT licensed](packages/usage/LICENSE).
