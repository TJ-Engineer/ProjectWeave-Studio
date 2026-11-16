# OpenRM

OpenRM is an open, self-hostable configuration and requirements management platform. The application provides API-backed requirements, controlled change, reviews, approvals, verification, immutable signed agent-run provenance, administration, object storage, and signed gate evidence without demo or fabricated fallback content.

[![OpenRM CI](https://github.com/TJ-Engineer/OpenRM/actions/workflows/ci.yml/badge.svg)](https://github.com/TJ-Engineer/OpenRM/actions/workflows/ci.yml)

## Development status

**Current stage:** 🟡 Phase 6 product documentation and maintainability is active; the first in-product Help increment is protected-CI verified and the code-aligned maintainer SDD is published, with contextual guidance, an independent SDD walkthrough, and bounded pilot commissioning next (updated 8 November 2026).

- ⚫ Phase 0 prototype and funding surfaces are retired from the product; the historical static-delivery stack remains documented for cleanup and traceability.
- 🟢 Phase 1 is complete: all foundation deliverables and local evidence checks are implemented.
- 🟢 Hosted OpenRM CI passes web, API, security-audit, migration, browser, accessibility, authenticated PostgreSQL, recovery, upgrade, and production-artifact checks.
- 🟢 The protected `main` branch requires `web`, `api`, `database-path`, `recovery-rehearsal`, and `production-artifact`, and disallows force-pushes and deletion.
- 🟢 Phase 2 is complete. Teams can create isolated projects, assign scoped roles, create and revise requirements, organize with folders and tags, validate typed attributes, save filtered views, compare history, and import/export JSON.
- 🟢 Controlled revisions and audit events are append-only, create/revise commands are idempotent, stale edits are rejected, and the primary browser workflow passes automated WCAG A/AA checks.
- 🟢 Phase 3 is complete: live graph/matrix/coverage queries, gap reporting, directed relationship controls, asynchronous suspect propagation, reviewer dispositions, attributable changesets, immutable baseline comparison, and deterministic signed evidence export pass locally and in [protected OpenRM CI run 42499758656](https://github.com/TJ-Engineer/OpenRM/actions/runs/42499758656).
- 🟢 Phase 4 is complete: baseline-bound reviews, segregation-of-duty approvals, immutable verification procedures, independent runs, signed results, content-addressed attachments, exact-revision coverage, explainable readiness, due events, and deterministic complete gate export pass locally and in [protected OpenRM CI run 42504423145](https://github.com/TJ-Engineer/OpenRM/actions/runs/42504423145).
- 🟢 Phase 5 is complete: governed Jira delivery/replay, Prometheus/OTLP observability, hardened deployment assets, recovery and upgrade rehearsals, three-browser/WCAG validation, load and security gates, and pilot operations procedures pass locally and in [protected OpenRM CI run 42508760769](https://github.com/TJ-Engineer/OpenRM/actions/runs/42508760769).
- 🟢 The software-factory increment records sanitized model, prompt, context, tool-call, output, exact OpenRM revision, and external Jira/Git provenance as immutable signed evidence with idempotent REST writes and read-time signature verification.
- 🟡 Phase 6 is active: the structured JSON [first-edition user manual](docs/user/USER_MANUAL.json) is available through persistent in-product Help with search, stable anchors, responsive rendering, and three-browser WCAG checks; the [code-aligned maintainer SDD](docs/design/SOFTWARE_DESIGN_DESCRIPTION.md) documents the implemented architecture, data, security, deployment, operations, testing, and maintenance paths; contextual links, governance, external-link validation, and the independent SDD walkthrough remain.

See the [development dashboard](DEVELOPMENT_DASHBOARD.md) for current evidence, priorities, gaps, and per-phase time/token accounting, and the [implementation plan](IMPLEMENTATION_PLAN.md) for the full roadmap and exit criteria.

## Repository map

| Path | Purpose |
| --- | --- |
| `src/` | React/TypeScript web client and generated API types |
| `apps/api/` | Rust REST API, OIDC validation, policy harness, and operational endpoints |
| `contracts/` | Versioned OpenAPI contract |
| `db/migrations/` | PostgreSQL schema and forward cleanup history |
| `docs/adr/` | Accepted architecture decisions |
| `docs/design/` | Versioned maintainer Software Design Description |
| `docs/user/` | Structured JSON end-user manual rendered by in-product Help |
| `aws/` | Historical static-delivery infrastructure |
| `scripts/` | Bootstrap, checks, provisioning, and deployment |

The web client remains at the repository root to preserve the current Vite, AWS, and Sites deployments. Backend components are Cargo workspace members.

## Portable container stack

Docker is the only runtime prerequisite for the complete portable stack:

```bash
docker compose up --build -d
```

Open [http://127.0.0.1:8080](http://127.0.0.1:8080). The composition starts PostgreSQL, applies all migrations, launches the Rust API, loads the controlled 60-requirement `OPENRM` self-verification project, and serves the React application through a same-origin Nginx gateway. Only the web gateway and loopback PostgreSQL development port are published; service-to-service traffic remains on the Compose network.

```bash
docker compose ps
docker compose logs -f
docker compose down
```

Persistent database state remains in the `openrm-postgres` volume. Use `docker compose down --volumes` only when intentionally deleting local OpenRM data. Port, bind-address, database, signing-key, logging, and evidence-link settings are configurable with the `OPENRM_*` variables documented in [the deployment guide](docs/operations/DEPLOYMENT.md).

## Native development bootstrap

Prerequisites: Node.js 24+, Rust 1.96+, Docker, and npm.

```bash
npm run bootstrap
```

This creates `.env` from `.env.example`, starts PostgreSQL, installs JavaScript dependencies, generates TypeScript API types, and applies migrations.

Run the services in separate terminals:

```bash
npm run dev
cargo run -p openrm-api
```

The web client runs at `http://127.0.0.1:5173`; the API runs at `http://127.0.0.1:8080`.

## Verify the foundation

```bash
npm run check:foundation
```

For the database-backed path:

```bash
docker compose up -d postgres
cargo run -p openrm-api --bin migrate
cargo run -p openrm-api
```

Then verify:

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/ready
curl \
  -H 'Authorization: Bearer dev:local-user' \
  -H 'X-OpenRM-Organization: 00000000-0000-4000-8000-000000000001' \
  http://127.0.0.1:8080/api/v1/session
```

Development tokens are rejected when `APP_ENV=production`. Deployed environments must use `AUTH_MODE=oidc` with an issuer and audience.

Role-scoped development tokens use `dev:<subject>:<role>`, where the role is `administrator`, `author`, `reviewer`, or `viewer`.

## Verify the controlled evidence slices

```bash
npm run check
npm run test:e2e
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets
```

The protected `database-path` job applies all migrations to PostgreSQL 17 and exercises project isolation, controlled authoring, exact trace revisions, suspect resolution, changesets, signed baselines, review-package assembly, segregation of duties, blocker-controlled approval, independent verification, signed results and attachments, exact-revision coverage, gate readiness, deterministic complete export, immutable signed agent-run provenance, Jira dead-letter/replay operations, security smoke tests, bounded load, stale-snapshot rejection, and append-only history. Separate jobs rehearse recovery/upgrades and build the production API image.

Phase 5 operating procedures are under [`docs/operations`](docs/operations), with the threat model and security review under [`docs/security`](docs/security).

## OpenRM product requirements in OpenRM

The repository includes a reproducible self-verification project containing 12 system requirements, 48 derived requirements, complete decomposition traceability, an independent review, and signed test, analysis, and observation evidence.

Validate the catalog and linked evidence files:

```bash
npm run check:self-project
```

Load or replay the controlled `OPENRM` project against a migrated local API:

```bash
npm run bootstrap:self-project
```

See the [OpenRM self-verification guide](docs/verification/OPENRM_SELF_VERIFICATION.md) for the requirement structure, evidence methods, integrity controls, and environment options.

## Contract workflow

Edit `contracts/openapi.yaml`, then regenerate the web types:

```bash
npm run generate:api
```

CI fails when committed generated types do not match the contract.

## Reset local data

```bash
docker compose down -v
npm run bootstrap
```

The `-v` operation deletes the disposable local PostgreSQL volume.

