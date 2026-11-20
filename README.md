# beeminder-cli

CLI for the [Beeminder API](https://api.beeminder.com/): read the user and goals, add a datapoint, list and delete datapoints. stdout carries only JSON, so people and AI agents can both use it. The contract is in `docs/design/cli-mvp.md`.

## Install

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

The token is never printed and never put in argv.

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

A negative value needs `--` before it, because `-1.5` would be parsed as an option:

```bash
beeminder add <slug> -- -1.5
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
