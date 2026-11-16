# Phase 5 exit evidence

## Closure decision

Phase 5 closed on 8 November 2026. The repository-local pilot thresholds passed, and all five protected hosted jobs passed in [OpenRM CI run 42508760769](https://github.com/TJ-Engineer/OpenRM/actions/runs/42508760769). Live-environment commissioning remains an operator responsibility.

## Local evidence

| Gate | Result |
| --- | --- |
| Rust quality | Formatting, clippy with warnings denied, and 32 unit tests passed. |
| Web quality | Lint, typecheck, four unit tests, generated-contract check, and production build passed. |
| Browser/accessibility | 33 tests passed across Chromium, Firefox, and WebKit, including automated WCAG 2 A/AA scans. |
| PostgreSQL runtime | All nine migrations applied to PostgreSQL 17.11; the complete requirements-to-verification path plus connector and operations checks exited successfully. |
| Jira failure recovery | One active delivery entered dead letter after its bounded attempt, replayed in dry-run mode, and retained two ordered append-only attempts. |
| Isolation and integrity | Cross-project access returned `403`; direct updates to all controlled histories, connector policy events, and delivery attempts were rejected. |
| Security smoke | Authentication failure, CORS denial, security headers, request-size limit, HTTPS connector origin validation, and non-secret connector configuration passed. |
| Load | 300 readiness requests at concurrency 20 completed with zero errors and 14.06 ms observed p95 against the final local candidate. |
| Soak | A 30-second run issued 118,130 requests at concurrency 10 with zero errors and 3.77 ms observed p95. |
| Recovery | A verified PostgreSQL 17 custom archive restored 55 controlled rows across nine migrations; six critical evidence tables were present. |
| Upgrade | The current migration set reapplied twice to the restored database without drift. |
| Deployment | Compose topology parses; the 40.1 MB API image passed health/readiness as UID 10001 with a read-only root filesystem and all capabilities dropped; hosted image construction passed. |

## Hosted evidence

| Job | Result |
| --- | --- |
| `web` | Generated contract, lint, typecheck, unit, build, three-browser/WCAG, and npm audit gates passed. |
| `api` | Formatting, clippy, tests, RustSec audit, and API smoke gates passed. |
| `database-path` | Complete controlled workflow, Jira recovery, security, load, isolation, and append-only checks passed against PostgreSQL 17. |
| `recovery-rehearsal` | Backup/restore and forward-only upgrade rehearsals passed against PostgreSQL 17. |
| `production-artifact` | Production topology validation and source-built API image passed. |

## Residual environment conditions

- Commission the pilot OIDC tenant, database encryption/PITR, secret manager, alert receivers, and retention policy before admitting pilot data.
- Keep Jira in `dry_run` until its least-privilege service identity and representative payloads are approved.
- Record environment-specific RPO/RTO, availability, latency, backup-age, and incident-routing evidence.
- Obtain independent external penetration testing before broader regulated or safety-critical production exposure.
