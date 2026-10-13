# Release 1 performance budgets

The supported initial envelope is a small-to-medium team, 1,000 matching issues on a board, 50-card API pages, ten concurrent interactive clients, and up to 100 CSV rows per synchronous dry run (imports themselves remain bounded background jobs).

| Path                         |                              Release gate |
| ---------------------------- | ----------------------------------------: |
| Board issue page             |                          p95 under 500 ms |
| PostgreSQL issue search      |                          p95 under 500 ms |
| 100-row CSV dry run          |                        p95 under 1,000 ms |
| SSE connection establishment |                        p95 under 1,000 ms |
| Ordinary issue update        | p95 under 400 ms, excluding file scanning |

`npm run test:load` logs in through the public API, selects a real project, and drives bounded concurrent board, search, import-validation, and realtime requests. Environment variables documented in the script can increase concurrency/iterations or adjust a deployment-specific budget. A failed budget returns a non-zero exit code.

The PostgreSQL integration suite separately traverses and filters a 1,000-issue board and checks its p95 API-boundary query budget. Load tests never queue imports or mutate existing issues; the import path is dry-run only. Run this gate on release-sized hardware with production logging and TLS before each release.
