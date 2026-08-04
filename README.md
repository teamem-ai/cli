# teamem CLI

`teamem` is the command-line companion for [teamem](https://github.com/teamem-ai/teamem-server),
an open-source, self-hostable team-knowledge compilation service. It does two
things:

- **`teamem init`** — scan the current repository and push it to your teamem
  portal so the compiler can turn it into evidence-backed knowledge pages.
- **`teamem install-hook`** — install a read-only *SessionStart* hook for
  Claude Code so every new agent session automatically starts with your team's
  latest knowledge.

The CLI is MIT-licensed and self-contained: building and testing it never
requires a checkout of `teamem-server`.

---

## Requirements

- **Node.js 20 or newer**
- For `teamem init`: the command runs inside a **git repository** (it reads the
  current commit SHA and remote to anchor the events).
- For the `install-hook` runtime: `curl` and `python3` (present by default on
  macOS and most Linux distributions) — the installed hook uses them to fetch
  and format context.

You also need three values from your portal (see [Getting started](#getting-started)):

| Flag | What it is | Example |
| --- | --- | --- |
| `--url` | Your portal's base URL | `http://localhost:8080` or `https://api.teamem.ai` |
| `--token` | An API key minted in the portal | `tok_...` |
| `--project` | The project the key is scoped to | `prj_...` |

---

## Install

> **Status:** the `teamem` package is not published to npm yet, so the
> supported way to install today is **from source**. The npm instructions below
> are shown for when a release is published.

### From source (works today)

```bash
git clone https://github.com/teamem-ai/cli.git teamem-cli
cd teamem-cli
pnpm install --frozen-lockfile
pnpm build
```

Then run it directly:

```bash
node dist/index.js --help
```

…or link it so `teamem` is on your `PATH`:

```bash
npm link          # from the repo root; now `teamem` runs the built CLI
teamem --help
```

### From npm (once published)

```bash
npm install -g teamem     # or: pnpm add -g teamem
teamem --help
```

You can also run it without installing, once published:

```bash
npx teamem --help
```

---

## Getting started

1. **Have a portal running.** Self-host teamem (see the
   [server repo](https://github.com/teamem-ai/teamem-server)) or use your team's
   deployment. Note its base URL — e.g. `http://localhost:8080`.

2. **Mint an API key.** In the portal go to **Settings → API keys** and create a
   key with the **`read`** and **`events:write`** scopes (write lets `init` push
   events; read lets the hook fetch context). Copy the `tok_...` token — it's
   shown only once.

3. **Note the project id** (`prj_...`) the key is bound to — it's shown next to
   the key in the portal.

4. **Dry-run a scan** (no portal needed — just prints what would be sent):

   ```bash
   cd /path/to/your/repo
   teamem init
   ```

5. **Push your repo to the portal:**

   ```bash
   teamem init \
     --url http://localhost:8080 \
     --token tok_your_token_here \
     --project prj_your_project_id
   ```

6. **Wire it into Claude Code** so context is injected automatically:

   ```bash
   teamem install-hook \
     --url http://localhost:8080 \
     --token tok_your_token_here \
     --project prj_your_project_id
   ```

---

## Usage

```
teamem <command> [options]
```

### `teamem init`

Scans the current git repository (text files only — binaries are skipped and
files larger than 100 KB are truncated) and, when portal flags are supplied,
pushes each file as a `cli_init` ingestion event, triggers compilation, and
waits for the jobs to finish.

```bash
# Scan only — prints the repo, commit, and the list of files that would be sent.
teamem init

# Full push — scan, upload, compile, and report results.
teamem init --url <url> --token <token> --project <prj_...>
```

All three flags (`--url`, `--token`, `--project`) are required together for a
push; supplying only some of them is an error. On success it prints a summary:

```
Repository:   your-org/your-repo
Commit:       a1b2c3d4...
Files:        42
Ingested:     42
Rejected:     0
Jobs:         job_...
Job status:   completed
Pages:        7
```

Re-running `init` on the same commit is safe: ingestion and compilation are
idempotent, so an unchanged repository won't create duplicate events or pages.

### `teamem install-hook`

Installs a read-only *SessionStart* hook into your Claude Code settings
(`~/.claude/settings.json` by default, or `$TEAMEM_HOOKS_PATH`). At the start of
every session the hook calls `GET /v1/context` and injects your team's knowledge
summary as additional context — no manual search needed.

```bash
teamem install-hook --url <url> --token <token> --project <prj_...>
```

All three flags are required. The command is **idempotent** and **non-destructive**:

- Running it again for the same URL + project updates the existing entry
  (e.g. after rotating the token) rather than adding a duplicate.
- Any other SessionStart hooks you have — teamem or otherwise — are left
  untouched.

**To remove the hook**, edit the settings file it prints and delete the entry
whose command contains `teamem-install-hook`.

> If your agent/MCP client doesn't support SessionStart hooks, retrieve team
> knowledge on demand via the MCP `search` tool against the same portal instead.

### `teamem help` · `teamem --version`

```bash
teamem help          # or --help, -h
teamem --version     # or -v
```

### Options reference

| Option | Applies to | Description |
| --- | --- | --- |
| `--url <url>` | `init`, `install-hook` | Portal base URL |
| `--token <tok_...>` | `init`, `install-hook` | API key (kept out of logs and error messages) |
| `--project <prj_...>` | `init`, `install-hook` | Target project id |
| `--help`, `-h` | global | Show help |
| `--version`, `-v` | global | Show the CLI version |

Both `--flag value` and `--flag=value` forms are accepted.

---

## Security notes

- Your `--token` is a secret. The CLI never logs it and scrubs it from error
  messages, but the `install-hook` command **does** embed it in the hook it
  writes to `~/.claude/settings.json` (it must, so the hook can authenticate at
  runtime). Treat that file accordingly, and prefer a key scoped to a single
  project with only the scopes you need.
- Rotate a token by minting a new key in the portal and re-running the same
  command — `install-hook` updates the stored entry in place.

---

## Local development

Requires Node.js 20+ and pnpm.

```bash
pnpm install --frozen-lockfile
pnpm build
node dist/index.js --help
pnpm lint
pnpm typecheck
pnpm test
pnpm check:boundaries
```

## Contract dependency

The CLI depends on the Teamem API contract package
[`@teamem/schema`](https://www.npmjs.com/package/@teamem/schema) (see
`package.json`), which it uses to validate ingestion, compilation, and job
DTOs.

It may consume only a **released semver version from npm**. Local `file:`,
cross-repository `workspace:`, and Git-URL dependencies, copied DTOs, and CI
checkouts of other repositories are not accepted. Run `pnpm check:boundaries`
to enforce this locally; CI runs the same check.

## License

MIT — see [LICENSE](./LICENSE).
