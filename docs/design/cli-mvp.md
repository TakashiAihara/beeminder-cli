# CLI MVP

## Goal

A single-binary CLI, `beeminder`, that covers the daily path against the Beeminder API: read the user and goals, add a datapoint, list and delete datapoints. Output is machine-readable so that both people and AI agents can use it.

Goal creation, goal updates and every money-charging endpoint (`x-charges-money` in the spec) are out of scope for the MVP.

## Commands

| Command | API call | stdout |
|---|---|---|
| `beeminder user` | `GET /users/{u}.json` | User JSON |
| `beeminder goals` | `GET /users/{u}/goals.json` | array of Goal JSON |
| `beeminder goal <slug>` | `GET /users/{u}/goals/{slug}.json` | Goal JSON |
| `beeminder datapoints <slug>` | `GET /users/{u}/goals/{slug}/datapoints.json` | array of Datapoint JSON |
| `beeminder add <slug> <value> [--comment <text>] [--requestid <id>] [--daystamp <YYYYMMDD>]` | `POST /users/{u}/goals/{slug}/datapoints.json` | created Datapoint JSON |
| `beeminder delete <slug> <id>` | `DELETE /users/{u}/goals/{slug}/datapoints/{id}.json` | deleted Datapoint JSON |

- Every command accepts `--user <username>`. The default is `me`, which works with a personal auth token (measured 2026-11-20).
- stdout carries only the API response body as JSON (pretty-printed is fine). Logs and errors go to stderr.
- `<value>` must parse as a finite number; otherwise the command fails with a usage error before any request.

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `BEEMINDER_AUTH_TOKEN` | personal auth token | none (required) |
| `BEEMINDER_API_BASE` | API base URL | `https://www.beeminder.com/api/v1` |

- The token is never printed, never put in argv, and never written to stderr (also not inside error messages that echo a URL).
- `BEEMINDER_API_BASE` exists so tests can point the CLI at a mock server; it is also usable for any compatible endpoint.

## Authentication placement

Measured on 2026-11-20 against a test account:

- `auth_token` as a query parameter works.
- `auth_token` inside a JSON request body works (POST).
- `Authorization: Bearer <personal token>` returns 401; Bearer is for OAuth tokens only.

So the CLI sends `auth_token` in the JSON body for POST/PUT, and as a query parameter for GET/DELETE (no body).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | API returned an error (non-2xx other than 401), or the network failed |
| 2 | authentication: token missing (no request is sent) or API returned 401 |
| 3 | usage error (bad arguments, non-numeric value) |

On a non-2xx response the CLI writes the API's error body (`errors`) to stderr.

## Implementation

- Bun + TypeScript, `commander` for argument parsing, matching `TakashiAihara/mfme-cli`.
- The HTTP client is generated from `openapi/beeminder.yaml` with Orval (`client: fetch`) and a custom mutator that applies the base URL and the auth placement above. Generated code lives under `src/generated/` and is regenerated with `bun run generate`.
- Distribution: `bun build --compile` single binary (later; not part of the MVP acceptance).

## Tests

- Acceptance tests run the CLI as a subprocess (`bun src/cli.ts ...`) and check exit code, stdout JSON and stderr.
- Mock layer (every PR): Prism serves `openapi/beeminder.yaml` on 127.0.0.1; the CLI points at it via `BEEMINDER_API_BASE`. Prism validates the request against the spec, so a wrong body or a missing token fails the test.
- Real-API layer (local and nightly, not per PR): runs only when `BEEMINDER_TEST_AUTH_TOKEN` is set, against the test account's goal `readbook`. It adds a datapoint with a unique `requestid` and comment prefix `beeminder-cli-test-`, reads it back, and deletes it; cleanup also removes any leftover datapoint with that comment prefix. It never calls an endpoint marked `x-charges-money`.
