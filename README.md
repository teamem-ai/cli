# teamem CLI

`teamem` is the CLI for [teamem](https://github.com/teamem-ai/teamem-server), an open-source, self-hostable team knowledge compilation service.

> **Status:** CLI-01 is complete: the standalone repository skeleton builds,
> tests, and provides `teamem --help`. `teamem init` is the next implementation
> task. The `teamem` package has not been published to npm yet, so there is no
> supported global install command at this stage.

This repository is self-contained: installing, building, and testing it never
requires a sibling checkout of `teamem-server`.

## Local development

Requires Node.js 20 or newer and pnpm.

```bash
pnpm install --frozen-lockfile
pnpm build
node dist/index.js --help
pnpm lint
pnpm typecheck
pnpm test
pnpm check:boundaries
```

## Commands

- `teamem init` — initialize teamem in the current directory (coming soon)

## Contract dependency

`teamem --help` does not need the Teamem API contract, so the repository
skeleton deliberately has no schema dependency. `@teamem/schema@0.1.0` is now
available from the public npm registry. CLI-02 will add
`@teamem/schema@^0.1.0` when implementation of `teamem init` begins; that
dependency is intentionally not added as part of the repository skeleton.

The CLI may consume only a released semver version from npm. Local `file:`,
cross-repository `workspace:`, Git URL dependencies, copied DTOs, and CI
checkouts of other repositories are not accepted.

Run `pnpm check:boundaries` to enforce this rule locally. CI runs the same
check.

## License

MIT — see [LICENSE](./LICENSE).
