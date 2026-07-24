# Repository instructions

These instructions apply to the entire `teamem-ai/cli` repository.

## Purpose and repository boundary

This repository contains the MIT-licensed standalone `teamem` CLI. It is not a
workspace package of `teamem-ai/teamem-server`, and it must install, build,
test, and publish from a checkout of this repository alone.

Use this precedence when sources disagree:

1. `package.json`, `pnpm-lock.yaml`, executable source, and tests in this
   repository;
2. the released public `@teamem/schema` package used by this repository;
3. this `AGENTS.md` and `README.md`;
4. planning documents and issue descriptions.

Do not depend on a sibling server checkout. The following integration paths
are prohibited:

- `file:` dependencies that point outside this repository;
- cross-repository `workspace:` dependencies;
- Git URLs, GitHub tarballs, or copied Teamem DTOs;
- CI jobs that checkout `teamem-server` to install, build, or test the CLI;
- imports from server internals, its database, or unpublished source.

The supported boundary is:

```text
build time: teamem CLI -> npm registry -> @teamem/schema@semver
run time:   teamem CLI -> public HTTP API -> teamem-server
```

## Development

Use Node.js 20 or newer and the pnpm version declared in `package.json`.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm check:boundaries
node dist/index.js --help
```

Run the relevant checks before claiming a task is complete. Report skipped or
unavailable validation honestly; do not replace real behavior with a fake
success path.

## M1 task boundaries

- CLI-01 is complete and provides the independent repository skeleton and
  working help/version entry points.
- CLI-02 owns repository scanning and creation of `cli_init` contract events.
  It must not make network requests.
- CLI-03 owns public HTTP ingestion, compilation triggering, status polling,
  retry behavior, and user-facing progress.
- CLI-04 owns cold-start end-to-end validation against a real server.

Do not pull work from a later task into an earlier task unless the active issue
explicitly changes that boundary.

## Data and security rules

- Respect `.gitignore` and never ingest ignored files by default.
- Evidence for repository files must include immutable repository, commit SHA,
  and path identity; a mutable branch path alone is insufficient.
- Preserve stable delivery and idempotency identities across retries.
- Validate public API payloads with the released `@teamem/schema` version.
- Never commit credentials or log secrets, private source content, or
  pre-redaction payloads.
- Preserve unrelated user changes and keep edits scoped to the active task.
