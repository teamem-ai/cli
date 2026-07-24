# teamem CLI

`teamem` is the CLI for [teamem](https://github.com/teamem-ai/teamem-server), an open-source, self-hostable team knowledge compilation service.

```bash
npm install -g teamem
teamem --help
```

This repository is self-contained: installing, building, and testing it never
requires a sibling checkout of `teamem-server`.

## Commands

- `teamem init` — initialize teamem in the current directory (coming soon)

## Contract dependency

`teamem --help` does not need the Teamem API contract, so the repository
skeleton deliberately has no schema dependency. Before implementation of
`teamem init` begins, `@teamem/schema` must be published to the public npm
registry. The CLI will then consume a released semver version from npm; local
`file:`, `workspace:`, Git URL dependencies, copied DTOs, and CI checkouts of
other repositories are not accepted.

Run `pnpm check:boundaries` to enforce this rule locally. CI runs the same
check.

## License

MIT — see [LICENSE](./LICENSE).
