# Architecture decision records

ADRs record decisions that constrain OpenRM implementation. An accepted ADR can be superseded only by a later ADR; do not silently rewrite the decision after implementation depends on it.

| ADR | Decision |
| --- | --- |
| [0001](0001-repository-and-service-boundaries.md) | Repository and service boundaries |
| [0002](0002-revision-model.md) | Append-only revisions with materialized current state |
| [0003](0003-relationship-semantics.md) | Typed relationships and suspect propagation |
| [0004](0004-authorization-and-tenancy.md) | Organization boundary and centralized policy |
| [0005](0005-baselines-and-evidence.md) | Immutable baselines and deterministic evidence |
| [0006](0006-search-consistency.md) | PostgreSQL source of truth with asynchronous search |
| [0007](0007-outbox-and-connectors.md) | Transactional outbox and idempotent connectors |

