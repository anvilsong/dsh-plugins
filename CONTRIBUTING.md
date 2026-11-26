# Contributing

Thanks for looking. This is a small collection of plugins for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

## Set up

```sh
git clone https://github.com/anvilsong/dsh-plugins.git
cd dsh-plugins
npm ci           # installs the shared test dependency from the lockfile; no build step exists
npm test         # every package's tests
```

Use Node.js 24.22.3 (see `.nvmrc`); other versions are not tested.

Tests must not touch a real DSH profile, `~/.dsh`, a real credential or the
network. They use fakes and temporary folders. A test that needs the real host is
a manual checklist under [`docs/`](docs), not part of `npm test`.

Packages ship directly from `src/`. There is no build or copy step.

## Before you open a pull request

1. Add or update tests for the behavior you change, and run `npm test`.
2. Update the package README when behavior, config, limits or commands change.
   The README must not claim more than the code and tests show.
3. Read [`REVIEW.md`](REVIEW.md). It lists invariants that a change must not
   break, such as the Sessions manager's rule that only `purge` deletes.
4. Keep a change focused on one package where you can.

## Commit messages

Use a short conventional prefix: `feat(usage): ...`, `fix(advisor): ...`,
`docs(router): ...`, `test(sessions): ...`. Explain why, not only what.

## Reporting problems

Use GitHub issues for bugs and ideas. For a security problem, follow
[`SECURITY.md`](SECURITY.md) instead. When you report a provider problem, remove
all credentials and private account data from any output you paste.
