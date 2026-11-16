# ADR 0003: Typed relationships and suspect propagation

- Status: Accepted
- Date: 2026-11-07

## Decision

Relationships are directed, typed records between artifact revisions with project-configurable cardinality rules. When a source revision changes, active downstream relationships become suspect unless the relationship type explicitly opts out.

Resolving a suspect link records an attributable disposition against the exact source and target revisions. Propagation is asynchronous through the outbox but idempotent and replayable.

## Consequences

Impact analysis can explain why a link is suspect. Eventual propagation requires freshness indicators and a recovery queue.

