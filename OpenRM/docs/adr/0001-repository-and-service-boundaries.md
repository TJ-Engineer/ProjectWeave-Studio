# ADR 0001: Repository and service boundaries

- Status: Accepted
- Date: 2026-11-07

## Decision

Use one repository and one deployable Rust API during the MVP. Keep the React web client at the root to preserve current preview deployments. Place the API in `apps/api`, the contract in `contracts`, migrations in `db`, and generated web types in `src/api`.

Organize the API internally by domain boundaries before extracting services. Background work shares the domain contract but runs through durable outbox messages.

## Consequences

Cross-cutting changes remain atomic and the early operating model stays small. Service extraction is deferred until measured scaling, ownership, or isolation needs justify it.

