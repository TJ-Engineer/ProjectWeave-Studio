# ADR 0006: Search consistency

- Status: Accepted
- Date: 2026-11-07

## Decision

PostgreSQL is the source of truth. Phase 2 begins with PostgreSQL full-text and structured indexes. A separate search adapter may be introduced later and consumes outbox events with at-least-once delivery.

Search responses expose the index watermark when asynchronous indexing is used. Controlled reads and gate decisions always resolve canonical records from PostgreSQL.

## Consequences

The MVP avoids premature search infrastructure. Future external indexes must tolerate replay and visibly report freshness.

