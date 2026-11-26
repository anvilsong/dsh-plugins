# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Report it privately through GitHub: open the repository's **Security** tab and
choose **Report a vulnerability** (private vulnerability reporting). Include the
package name and version, what you observed, and the smallest steps that
reproduce it. Remove any credentials, tokens and private data first.

If private reporting is not available on the repository, open a public issue that
says only that you have a security report and asks for a private channel; do not
include details in it.

This is a small community project maintained by one person. I read reports as
time allows and cannot promise a response time or a fix date.

## What is in scope

These are plugins for DeepSeek Harness (DSH). Reports about how a plugin handles
credentials, outbound requests, files it writes or deletes (for example the
Sessions manager's prune and purge), or the read-only guards of the Advisor are
in scope. Problems in DeepSeek Harness itself belong with the
[DeepSeek Harness project](https://github.com/deepseek-ai/deepseek-harness).

## What each plugin does with your data

Each package's README states what it reads, writes and sends. In particular, the
usage plugin sends the credential you configured only to the endpoint configured for
that provider (its own API by default; a custom or NewAPI `baseUrl`, or a Codex or
Claude host other than the default, changes that destination), keeps snapshots in
memory and writes no usage history to disk; see
[its security section](packages/usage/README.md#credentials-and-security).
