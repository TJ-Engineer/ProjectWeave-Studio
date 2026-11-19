# ADR 0007: Transactional outbox and connectors

- Status: Accepted
- Date: 2026-11-07

## Decision

Domain mutations and outbox messages commit in one PostgreSQL transaction. Workers claim messages with bounded leases and use message identifiers as idempotency keys. Connector adapters own mapping, rate limits, cursors, and remote identifiers but cannot participate in core transactions.

Failures retry with backoff and then move to an operator-visible dead-letter state. Replay never invents a new logical event identifier.

## Consequences

External outages cannot corrupt core transactions. The platform must operate worker health, backlog age, retries, and dead-letter recovery.

