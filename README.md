# beeminder-cli

CLI for the [Beeminder API](https://api.beeminder.com/): read the user and goals, add a datapoint, list and delete datapoints. stdout carries only JSON, so people and AI agents can both use it. The contract is in `docs/design/cli-mvp.md`.

## Install

Install a released binary with `install.sh`. It stops without installing when the checksum does not match.

```bash
curl -fsSL https://raw.githubusercontent.com/TakashiAihara/beeminder-cli/main/install.sh | sh
```

To pin a tag, put the variable on the `sh` side; on the `curl` side it never reaches install.sh and latest is installed.

```bash
curl -fsSL https://raw.githubusercontent.com/TakashiAihara/beeminder-cli/main/install.sh | BEEMINDER_CLI_VERSION=v0.1.0 sh
```

- `BEEMINDER_CLI_VERSION` defaults to `latest`, which is resolved to a tag once; both the binary and `SHA256SUMS` come from that tag.
- `BEEMINDER_CLI_INSTALL_DIR` changes the install location (default `$HOME/.local/bin`).
- `BEEMINDER_CLI_VERIFY_ATTESTATION=1` also verifies the build provenance with `gh`; without `gh`, or when verification fails, it stops without installing.
- To fetch the files by hand, use the `beeminder-cli-<os>-<arch>` and `SHA256SUMS` assets on [Releases](https://github.com/TakashiAihara/beeminder-cli/releases); os is `linux` / `darwin`, arch is `x64` / `arm64`.

To run from source instead:

```bash
mise install
bun install
bun run src/cli.ts --help
```

## Environment

| Variable | Meaning | Default |
|---|---|---|
| `BEEMINDER_AUTH_TOKEN` | personal auth token (required) | none |
| `BEEMINDER_API_BASE` | API base URL | `https://www.beeminder.com/api/v1` |
| `BEEMINDER_TIMEOUT_MS` | request timeout in ms | `30000` |

The token is never put in argv, and it is redacted (raw and URL-encoded) from error messages on stderr. stdout is the API response body as JSON (re-serialized and pretty-printed, values unchanged).

## Commands

Every command accepts `--user <username>` (default `me`).

```bash
beeminder user
beeminder goals
beeminder goal <slug>
beeminder datapoints <slug>
beeminder add <slug> <value> [--comment <text>] [--requestid <id>] [--daystamp <YYYYMMDD>]
beeminder delete <slug> <id>
```

A negative value works as is:

```bash
beeminder add <slug> -1.5
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | API error (non-2xx other than 401) or network failure |
| 2 | token missing (no request sent) or API returned 401 |
| 3 | usage error (bad arguments, non-numeric value) |

## Development

```bash
bun run generate          # regenerate src/generated from openapi/beeminder.yaml
bun run check             # typecheck + lint + format:check + acceptance tests (Prism mock)
BEEMINDER_TEST_AUTH_TOKEN=... BEEMINDER_TEST_GOAL=<slug> bun run test:integration   # real API; the goal must use aggday sum
```
