# Provider login

Adds `/provider-login <provider> [oauth|api-key]` to start a provider authorization flow
registered by `@deepseek-ai/dsh-llm-pi-ai`.

Examples:

```text
/provider-login openai-codex
/provider-login anthropic
/provider-login anthropic api-key
```

The default method is `oauth`. Notices, browser URLs, and codes appear as user
messages in the current session. Interactive prompts use DSH's question cards.

The credential is stored by DSH under `llm-pi-ai/<provider>`. This plugin does
not read or store the credential itself.
